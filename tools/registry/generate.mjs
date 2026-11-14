#!/usr/bin/env node
/**
 * WB-FF-DS registry Markdown generator (pipeline spine, step S2).
 *
 * The JSON registry is the source of truth. This renders the Markdown that people and agents
 * read: knowledge-base/decisions.md, and sources.md and rules.md for each foundation. It also
 * writes each agent manifest's Claude Code agent file, which stays local (DEC-039).
 * It refuses to run on a registry that has errors, and --check reports drift without writing.
 * Every explanation of an allowed value comes from the schema descriptions, so the documents
 * can't disagree with the contract.
 *
 * Usage: node tools/registry/generate.mjs [--root <dir>] [--check]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as prettier from 'prettier';

import {
  createValidators,
  loadRegistry,
  localDate,
  openDecisionsByRule,
  validateRegistryData,
} from './validate.mjs';

const SCHEMA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schemas');

/** Section headings for source roles, in schema order. Checked against the role enum. */
const ROLE_TITLES = {
  'judged-by': 'Judged by',
  spec: 'Specifications',
  platform: 'Platform',
  'learn-from': 'Learn from',
  reuse: 'Reuse',
};

/** Reads the registry schemas. */
export async function loadSchemas() {
  const read = async (name) =>
    JSON.parse(await readFile(path.join(SCHEMA_DIR, `${name}.schema.json`), 'utf8'));
  return {
    common: await read('common'),
    sources: await read('sources'),
    rules: await read('rules'),
    decisions: await read('decisions'),
    agent: await read('agent'),
  };
}

/**
 * Parses a description written as "value: meaning. value: meaning." into a Map, and checks it
 * explains every enum value and nothing else. A mismatch throws: the schema must be fixed.
 */
export function legend(property, where) {
  const entries = new Map();
  for (const match of (property.description ?? '').matchAll(/([a-z][a-z0-9-]*): (.+?)\.(?=\s|$)/g))
    entries.set(match[1], match[2]);
  const values = property.enum ?? [];
  const missing = values.filter((v) => !entries.has(v));
  const extra = [...entries.keys()].filter((k) => !values.includes(k));
  if (missing.length || extra.length || values.length === 0) {
    throw new Error(
      `${where}: the description must explain each enum value once ` +
        `(unexplained: ${missing.join(', ') || 'none'}; not in the enum: ${extra.join(', ') || 'none'})`,
    );
  }
  return entries;
}

function legends(schemas) {
  const roles = legend(schemas.sources.$defs.source.properties.role, 'sources: role');
  const missingTitle = [...roles.keys()].filter((r) => !ROLE_TITLES[r]);
  if (missingTitle.length) throw new Error(`generate: no section title for role ${missingTitle}`);
  return {
    role: roles,
    verification: legend(
      schemas.sources.$defs.source.properties.verification,
      'sources: verification',
    ),
    featureStatus: legend(
      schemas.sources.$defs.feature.properties.status,
      'sources: feature status',
    ),
    featureUse: legend(schemas.sources.$defs.feature.properties.use, 'sources: feature use'),
    kind: legend(schemas.rules.$defs.rule.properties.kind, 'rules: kind'),
    checkKind: legend(schemas.rules.$defs.rule.properties.checkKind, 'rules: checkKind'),
    ruleStatus: legend(schemas.rules.$defs.rule.properties.status, 'rules: status'),
    consumer: legend(schemas.common.$defs.consumer, 'common: consumer'),
    agentRole: legend(schemas.agent.properties.role, 'agent: role'),
    outcome: legend(schemas.agent.$defs.outcome, 'agent: outcome'),
    decisionStatus: legend(schemas.decisions.$defs.decision.properties.status, 'decisions: status'),
  };
}

// ---------- Markdown helpers ----------

/** One table cell. Pipes are escaped; a line break can't be represented, so it throws. */
function cell(value, where) {
  const text = String(value ?? '');
  if (/[\r\n]/.test(text)) throw new Error(`${where}: a table cell can't hold a line break`);
  return text.replace(/\|/g, '\\|');
}

/**
 * A Markdown table. Columns marked optional are left out when every row is empty for them,
 * so a table never shows a column of blanks. Empty required cells show a dash.
 */
function table(columns, rows, where) {
  const shown = columns.filter((c) => !c.optional || rows.some((r) => c.value(r)));
  const line = (values) => `| ${values.join(' | ')} |`;
  return [
    line(shown.map((c) => c.header)),
    line(shown.map(() => '---')),
    ...rows.map((r) => line(shown.map((c) => cell(c.value(r) || '—', where)))),
  ].join('\n');
}

const list = (entries) => [...entries].map(([key, meaning]) => `  - \`${key}\`: ${meaning}.`);
const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const code = (value) => (value ? `\`${value}\`` : '');

function generatedNote(jsonFile) {
  return (
    `<!-- Generated from ${jsonFile} by tools/registry/generate.mjs. ` +
    `Don't edit this file: change the JSON, then run npm run registry:generate. -->`
  );
}

/** Link labels are the host name; repeats within one cell are numbered. */
function links(urls = []) {
  const seen = new Map();
  return urls
    .map((url) => {
      const host = new URL(url).hostname.replace(/^www\./, '');
      const count = (seen.get(host) ?? 0) + 1;
      seen.set(host, count);
      return `[${count > 1 ? `${host} ${count}` : host}](${url})`;
    })
    .join(' · ');
}

// ---------- Cross-file context ----------

function context(registry) {
  const decisions = registry.decisions?.data.decisions ?? [];
  const decisionById = new Map(decisions.map((d) => [d.id, d]));
  const supersededBy = new Map();
  for (const d of decisions) for (const old of d.supersedes ?? []) supersededBy.set(old, d.id);

  const rules = registry.foundations.flatMap((f) => f.rules.data.rules);
  const groupMembers = new Map();
  for (const rule of rules) {
    const key = rule.id.replace(/\d+$/, '');
    groupMembers.set(key, [...(groupMembers.get(key) ?? []), rule.id]);
  }

  const citedBy = new Map();
  const cite = (id, ruleId) => citedBy.set(id, [...(citedBy.get(id) ?? []), ruleId]);
  for (const rule of rules) {
    for (const id of rule.decisions ?? []) cite(id, rule.id);
    for (const id of rule.sources ?? []) cite(id, rule.id);
  }

  // The same function the validator uses, so "waits on" here matches what the checks enforce.
  const waitsOn = openDecisionsByRule(decisions, rules);

  /** Rule IDs, with a whole group written as "All L-T rules". */
  const ruleList = (ids = []) => {
    const out = [];
    const collapsed = new Set();
    for (const id of ids) {
      const key = id.replace(/\d+$/, '');
      if (collapsed.has(key)) continue;
      const members = groupMembers.get(key) ?? [];
      if (members.length > 1 && members.every((m) => ids.includes(m))) {
        out.push(`All ${key} rules`);
        collapsed.add(key);
      } else out.push(id);
    }
    return out.join(', ');
  };

  return { decisions, decisionById, supersededBy, citedBy, waitsOn, ruleList };
}

// ---------- Documents ----------

function renderRules(foundation, ctx, legendOf, schemas) {
  const { data } = foundation.rules;
  const file = foundation.rules.file;
  const title = data.title ?? foundation.name;
  const ruleSchema = schemas.rules.$defs.rule.properties;
  const columns = [
    { header: 'ID', value: (r) => r.id },
    { header: 'Rule', value: (r) => r.text },
    { header: 'Kind', value: (r) => r.kind },
    {
      header: 'Basis',
      value: (r) =>
        [...(r.sources ?? []), ...(r.decisions ?? []), ...(r.dependsOn ?? [])].join(', '),
    },
    { header: 'Consumers', value: (r) => r.consumers.join(', ') },
    {
      header: 'Status',
      value: (r) => {
        const waiting = [...(ctx.waitsOn.get(r.id) ?? [])].sort();
        return waiting.length ? `${r.status}, waits on ${waiting.join(', ')}` : r.status;
      },
    },
    {
      header: 'Check',
      value: (r) => (r.kind === 'check' ? `${r.checkKind}: ${code(r.checkId) || 'none yet'}` : ''),
    },
  ];

  const out = [
    generatedNote(file),
    `# ${title}: rules`,
    schemas.rules.description,
    `**Status:** ${data.status}. **Contract:** ${data.contractVersion}.`,
    [
      '- **Kind**',
      ...list(legendOf.kind),
      `- **Basis:** the sources ([sources.md](sources.md)), decisions ([decisions.md](../../decisions.md)) and other rules the rule rests on.`,
      '- **Consumers**',
      ...list(legendOf.consumer),
      '- **Status**',
      ...list(legendOf.ruleStatus),
      '  - "waits on" names an open decision that blocks the rule.',
      `- **Check:** the kind of check, then the check itself. ${ruleSchema.checkId.description}`,
      ...list(legendOf.checkKind),
    ].join('\n'),
  ];

  data.groups.forEach((group, index) => {
    const rows = data.rules.filter((r) => r.group === group.id);
    out.push(`## ${index + 1}. ${group.title}`, table(columns, rows, file));
  });

  const decisionIds = new Set(data.rules.flatMap((r) => r.decisions ?? []));
  for (const rule of data.rules)
    for (const id of ctx.waitsOn.get(rule.id) ?? []) decisionIds.add(id);
  if (decisionIds.size) {
    const rows = [...decisionIds].sort().map((id) => ctx.decisionById.get(id));
    out.push(
      '## Decisions these rules rest on',
      'Answers, options and history are in [decisions.md](../../decisions.md).',
      table(
        [
          { header: 'ID', value: (d) => d.id },
          { header: 'Question', value: (d) => d.question },
          { header: 'Status', value: (d) => d.status },
        ],
        rows,
        file,
      ),
    );
  }

  if (data.gaps?.length) {
    out.push(
      '## Gaps to close',
      table(
        [
          { header: 'Gap', value: (g) => g.gap },
          {
            header: 'Blocks',
            value: (g) => ctx.ruleList(ctx.decisionById.get(g.decision)?.blocks),
          },
          { header: 'Owner', value: (g) => g.owner },
          { header: 'Decision', value: (g) => g.decision },
        ],
        data.gaps,
        file,
      ),
    );
  }
  return { file: file.replace(/\.json$/, '.md'), content: `${out.join('\n\n')}\n` };
}

function renderSources(foundation, ctx, legendOf, schemas) {
  const { data } = foundation.sources;
  const file = foundation.sources.file;
  const title = data.title ?? foundation.name;
  const columns = [
    { header: 'ID', value: (s) => s.id },
    { header: 'Source', value: (s) => s.title },
    { header: 'Edition', value: (s) => s.edition, optional: true },
    { header: 'Uses', value: (s) => s.uses },
    { header: 'Note', value: (s) => s.note, optional: true },
    {
      header: 'Verified',
      value: (s) => (s.checked ? `${s.verification}, ${s.checked}` : s.verification),
    },
    { header: 'Links', value: (s) => links(s.urls), optional: true },
    { header: 'Cited by', value: (s) => ctx.ruleList(ctx.citedBy.get(s.id)) },
  ];

  const out = [
    generatedNote(file),
    `# ${title}: sources`,
    schemas.sources.description,
    `**Scope:** ${data.scope}`,
    [
      '- **Verified**: how the source was checked, and when.',
      ...list(legendOf.verification),
      '- **Cited by**: the rules in [rules.md](rules.md) that cite the source. A dash means none do yet.',
    ].join('\n'),
  ];

  for (const role of legendOf.role.keys()) {
    const rows = data.sources.filter((s) => s.role === role);
    if (rows.length === 0) continue;
    out.push(
      `## ${ROLE_TITLES[role]}`,
      `${capitalise(legendOf.role.get(role))}.`,
      table(columns, rows, file),
    );
  }

  if (data.baseline) {
    const { dataset, checked, features } = data.baseline;
    out.push(
      '## Browser support',
      `From ${dataset}, checked ${checked}.`,
      table(
        [
          { header: 'Feature', value: (f) => f.name },
          { header: 'Status', value: (f) => f.status },
          { header: 'Since', value: (f) => f.since, optional: true },
          { header: 'Use', value: (f) => f.use },
          { header: 'Note', value: (f) => f.note, optional: true },
        ],
        features,
        file,
      ),
      [
        '- **Status**',
        ...list(legendOf.featureStatus),
        '- **Use**',
        ...list(legendOf.featureUse),
      ].join('\n'),
    );
  }
  return { file: file.replace(/\.json$/, '.md'), content: `${out.join('\n\n')}\n` };
}

function renderDecisions(entry, ctx, legendOf, schemas) {
  const file = entry.file;
  const id = { header: 'ID', value: (d) => d.id };
  const question = { header: 'Question', value: (d) => d.question };
  const notes = { header: 'Notes', value: (d) => d.notes, optional: true };
  const relations = {
    header: 'Replaces / replaced by',
    optional: true,
    value: (d) =>
      [
        ...(d.supersedes ?? []).map((old) => `replaces ${old}`),
        ...(ctx.supersededBy.has(d.id) ? [`replaced by ${ctx.supersededBy.get(d.id)}`] : []),
      ].join('; '),
  };
  const columnsFor = {
    open: [
      id,
      question,
      { header: 'Options', value: (d) => (d.options ?? []).join('; ') },
      { header: 'Blocks', value: (d) => ctx.ruleList(d.blocks) },
      { header: 'Recorded', value: (d) => d.recordedOn },
      { header: 'Expires', value: (d) => d.expiresOn, optional: true },
      notes,
    ],
    answered: [
      id,
      question,
      { header: 'Answer', value: (d) => d.answer },
      { header: 'Decided', value: (d) => `${d.decidedOn}, ${d.decidedBy}` },
      { header: 'Cited by', value: (d) => ctx.ruleList(ctx.citedBy.get(d.id)) },
      relations,
      notes,
    ],
  };
  const fallback = [id, question, { header: 'Recorded', value: (d) => d.recordedOn }, notes];

  const out = [
    generatedNote(file),
    '# Decision register',
    schemas.decisions.description,
    `**Contract:** ${entry.data.contractVersion}.`,
    ['- **Status**', ...list(legendOf.decisionStatus)].join('\n'),
  ];
  for (const status of legendOf.decisionStatus.keys()) {
    const rows = ctx.decisions.filter((d) => d.status === status);
    if (rows.length === 0) continue;
    out.push(
      `## ${capitalise(status)} (${rows.length})`,
      table(columnsFor[status] ?? fallback, rows, file),
    );
  }
  return { file: file.replace(/\.json$/, '.md'), content: `${out.join('\n\n')}\n` };
}

/**
 * A Claude Code agent file, generated from a manifest. It stays local (DEC-039): the prompt
 * points at the registry by path and ID, and repeats only the guidance rules the agent loads.
 */
function renderAgent(entry, registry, ctx, legendOf) {
  const { data, file } = entry;
  const front = [
    '---',
    `name: ${data.name}`,
    `description: ${JSON.stringify(data.description)}`,
    `tools: ${data.tools.join(', ')}`,
    ...(data.model ? [`model: ${data.model}`] : []),
    ...(data.effort ? [`effort: ${data.effort}`] : []),
    '---',
  ].join('\n');

  const foundations = registry.foundations.filter((f) => f.rules && f.sources);
  const mine =
    data.role === 'foundation'
      ? foundations.filter((f) => f.name === data.foundation)
      : foundations.filter((f) =>
          f.rules.data.rules.some((r) => r.consumers.includes(data.consumer)),
        );
  const rules = mine
    .flatMap((f) => f.rules.data.rules)
    .filter((r) => data.role === 'foundation' || r.consumers.includes(data.consumer));
  const waiting = [...new Set(rules.flatMap((r) => [...(ctx.waitsOn.get(r.id) ?? [])]))].sort();
  const reviews = [...registry.foundations.map((f) => f.agent), ...(registry.agents ?? [])].filter(
    (a) => a?.data.reviewedBy?.includes(data.name),
  );
  const bullets = (items, empty) => (items.length ? items.join('\n') : empty);

  const dataLines = mine.flatMap((f) => {
    const dir = path.posix.dirname(f.rules.file);
    return [
      `- Rules: \`${f.rules.file}\` (readable view: \`${dir}/rules.md\`)`,
      `- Sources: \`${f.sources.file}\``,
    ];
  });
  if (registry.decisions) dataLines.push(`- Decisions: \`${registry.decisions.file}\``);

  const out = [
    front,
    generatedNote(file),
    `# ${data.name}`,
    `${capitalise(legendOf.agentRole.get(data.role))}.` +
      (data.role === 'reviewer'
        ? ` You review the rules tagged \`${data.consumer}\`.`
        : ` Yours is the \`${data.foundation}\` foundation.`) +
      ' Follow the operating contract in CLAUDE.md, section 2.',
    '## Your data',
    [
      ...dataLines,
      '',
      "Cite rules, sources and decisions by ID; don't copy their values. The `.md` files beside the JSON are generated from it: change the JSON only.",
    ].join('\n'),
    '## What you may write',
    data.writeScope.length
      ? `Only these paths. Every other write is refused.\n\n${data.writeScope.map((p) => `- \`${p}\``).join('\n')}`
      : 'Nothing. You read and report.',
  ];
  if (reviews.length) {
    out.push('## Agents you review', reviews.map((a) => `- \`${a.data.name}\``).join('\n'));
  }
  out.push(
    '## Guidance to apply while working',
    bullets(
      rules.filter((r) => r.kind === 'guidance').map((r) => `- **${r.id}:** ${r.text}`),
      'None yet.',
    ),
    '## Open decisions',
    `${data.role === 'reviewer' ? 'The rules you review' : 'Your rules'} wait on these. ` +
      "Don't answer them yourself: finish with `needs-decision` and name the decision.",
    bullets(
      waiting.map((id) => `- **${id}:** ${ctx.decisionById.get(id).question}`),
      'None.',
    ),
    '## How your work is checked',
    [
      `When you finish, these run: ${data.gate.checks.map((c) => `\`npm run ${c}\``).join(', ')}.`,
      data.gate.maxRetries === 0
        ? 'If a check fails, stop as `blocked`: no retries.'
        : `After a failed check you may fix it and retry up to ${data.gate.maxRetries} ` +
          `${data.gate.maxRetries === 1 ? 'time' : 'times'}; then stop as \`blocked\`.`,
      ...(data.reviewedBy?.length
        ? [`Then your work is reviewed by ${data.reviewedBy.map((r) => `\`${r}\``).join(', ')}.`]
        : []),
    ].join(' '),
    'End your final message with exactly one line `Outcome: <outcome>`, using one of these outcomes. The finish gate reads it:',
    list(legendOf.outcome)
      .map((line) => line.slice(2))
      .join('\n'),
  );
  const folder = data.role === 'foundation' ? 'foundations' : 'reviewers';
  return { file: `.claude/agents/${folder}/${data.name}.md`, content: `${out.join('\n\n')}\n` };
}

/**
 * Renders every document for a registry that has already passed validation.
 * Pure: returns [{ file, content, published }] with paths relative to the root, before
 * formatting. Agent files are local only (published: false), so CI never expects them.
 */
export function renderRegistry(registry, schemas) {
  const legendOf = legends(schemas);
  const ctx = context(registry);
  const outputs = [];
  const add = (output, published = true) => outputs.push({ ...output, published });
  if (registry.decisions) add(renderDecisions(registry.decisions, ctx, legendOf, schemas));
  for (const foundation of registry.foundations) {
    add(renderSources(foundation, ctx, legendOf, schemas));
    add(renderRules(foundation, ctx, legendOf, schemas));
  }
  const agents = [...registry.foundations.map((f) => f.agent), ...(registry.agents ?? [])];
  for (const agent of agents.filter(Boolean))
    add(renderAgent(agent, registry, ctx, legendOf), false);
  return outputs;
}

/** Formats each output with the repository's Prettier settings, as format:check expects. */
export async function formatOutputs(outputs, root) {
  return Promise.all(
    outputs.map(async (output) => {
      const filepath = path.join(root, output.file);
      const options = (await prettier.resolveConfig(filepath)) ?? {};
      return {
        ...output,
        content: await prettier.format(output.content, { ...options, filepath }),
      };
    }),
  );
}

/** Compares outputs with what's on disk. readText(file) returns the text, or null if absent. */
export async function findDrift(outputs, readText) {
  const drift = [];
  for (const { file, content } of outputs) {
    const current = await readText(file);
    if (current === null) drift.push({ file, problem: 'missing' });
    else if (current !== content) drift.push({ file, problem: 'differs from its JSON' });
  }
  return drift;
}

/**
 * Validates, renders and formats. Throws when the registry has errors, so nothing is ever
 * generated from a registry that fails its checks.
 */
export async function build(registry, issues, root) {
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `the registry has ${errors.length} error(s), so nothing was generated. ` +
        'Run npm run registry:check to see them.',
    );
  }
  return formatOutputs(renderRegistry(registry, await loadSchemas()), root);
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { root: { type: 'string' }, check: { type: 'boolean' } },
  });
  const root = path.resolve(values.root ?? process.cwd());
  const { registry, issues: loadIssues } = await loadRegistry(root);
  const issues = [
    ...loadIssues,
    ...validateRegistryData(registry, await createValidators(), { today: localDate() }),
  ];
  let outputs;
  try {
    outputs = await build(registry, issues, root);
  } catch (error) {
    console.error(`generate: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const readText = async (file) => {
    try {
      return await readFile(path.join(root, file), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  const published = outputs.filter((o) => o.published);
  const local = outputs.filter((o) => !o.published);
  const drift = await findDrift(published, readText);
  const localDrift = await findDrift(local, readText);
  if (values.check) {
    for (const d of drift) console.log(`DRIFT ${d.file}: ${d.problem}`);
    for (const d of localDrift)
      console.log(`LOCAL ${d.file}: ${d.problem} (local only, not a CI failure)`);
    console.log(
      `generate --check: ${published.length} published file(s), ${drift.length} out of date; ` +
        `${local.length} local agent file(s), ${localDrift.length} out of date.` +
        (drift.length + localDrift.length ? ' Run npm run registry:generate.' : ''),
    );
    process.exitCode = drift.length > 0 ? 1 : 0;
    return;
  }
  const changed = [...drift, ...localDrift];
  for (const { file } of changed) {
    const output = outputs.find((o) => o.file === file);
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), output.content);
    console.log(`wrote ${file}`);
  }
  console.log(`generate: ${changed.length} written, ${outputs.length - changed.length} unchanged.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
