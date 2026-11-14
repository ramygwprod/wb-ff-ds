#!/usr/bin/env node
/**
 * WB-FF-DS contract registry validator (pipeline spine, step S1).
 *
 * Stage 1 checks each registry file against its JSON Schema.
 * Stage 2 checks the references between files: IDs, sources, decisions, rules, and each agent
 * manifest's location, write scope, gate scripts and reviewers.
 * Every issue carries a code, a severity, the file and a JSON Pointer path.
 *
 * Usage: node tools/registry/validate.mjs [--root <dir>] [--json] [--today YYYY-MM-DD]
 * --today sets the date used for decision expiry; it defaults to the local date.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';

const SCHEMA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schemas');
const FILE_KINDS = ['sources', 'rules', 'decisions', 'agent', 'checks'];

/** @typedef {{ severity: 'error' | 'warning', code: string, file: string, path: string, message: string }} Issue */
/** @typedef {{ file: string, data: any }} Entry */
/** @typedef {{ name: string, sources: Entry | null, rules: Entry | null, agent: Entry | null }} Foundation */
/** @typedef {{ decisions: Entry | null, foundations: Foundation[], agents: Entry[], checks: Entry | null, scripts: string[] | null }} Registry */

/** @returns {Issue} */
function issue(severity, code, file, pointer, message) {
  return { severity, code, file, path: pointer, message };
}

/**
 * The open decisions each rule waits on: the open decisions it cites, plus the open decisions
 * that list it in "blocks". Shared with the generator, so documents and checks can't disagree.
 * @returns {Map<string, Set<string>>} rule ID → open decision IDs
 */
export function openDecisionsByRule(decisionList, ruleList) {
  const open = new Set(decisionList.filter((d) => d.status === 'open').map((d) => d.id));
  const waits = new Map();
  const add = (ruleId, decisionId) => {
    if (!waits.has(ruleId)) waits.set(ruleId, new Set());
    waits.get(ruleId).add(decisionId);
  };
  for (const d of decisionList) if (open.has(d.id)) for (const r of d.blocks ?? []) add(r, d.id);
  for (const r of ruleList) for (const id of r.decisions ?? []) if (open.has(id)) add(r.id, id);
  return waits;
}

/**
 * Paths only a person may change. No agent's write scope may reach them. Dot paths (.github,
 * .claude, .gitignore, .npmrc) need no entry: the manifest schema can't express them at all.
 */
export const PROTECTED = [
  { path: 'knowledge-base/decisions.json', why: 'decisions are answered by a person' },
  {
    path: 'knowledge-base/foundations/*/agent.json',
    why: "an agent can't change any agent's authority",
  },
  { path: 'knowledge-base/agents/**', why: "an agent can't change any agent's authority" },
  { path: 'knowledge-base/runs/**', why: 'the run log is written by the hooks, not by agents' },
  { path: 'tools/**', why: 'the checks and generators' },
  { path: 'releases/**', why: 'published changelogs' },
  { path: 'package.json', why: 'dependencies and scripts' },
  { path: 'package-lock.json', why: 'dependencies' },
  { path: 'angular.json', why: 'build configuration' },
  { path: 'tsconfig.json', why: 'build configuration' },
  { path: 'eslint.config.js', why: 'lint checks' },
  { path: 'CLAUDE.md', why: 'the operating contract' },
];

/**
 * Whether a write-scope entry and a protected path can name the same file. "*" matches one
 * segment, and a trailing "/**" means everything below that folder.
 */
export function scopeOverlaps(scope, guarded) {
  const split = (p) => {
    const deep = p.endsWith('/**');
    return { parts: (deep ? p.slice(0, -3) : p).split('/'), deep };
  };
  const a = split(scope);
  const b = split(guarded);
  const shared = Math.min(a.parts.length, b.parts.length);
  for (let i = 0; i < shared; i++) {
    if (a.parts[i] !== b.parts[i] && a.parts[i] !== '*' && b.parts[i] !== '*') return false;
  }
  if (a.parts.length === b.parts.length) return true;
  return a.parts.length < b.parts.length ? a.deep : b.deep;
}

/** Compiles one validator per registry file kind. Throws if a schema is invalid. */
export async function createValidators() {
  // Strict mode stays on. strictRequired is off because conditional "then" blocks legitimately
  // require properties that are defined once, in the parent schema.
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictTypes: false,
    strictRequired: false,
  });
  const readSchema = async (name) =>
    JSON.parse(await readFile(path.join(SCHEMA_DIR, `${name}.schema.json`), 'utf8'));
  ajv.addSchema(await readSchema('common'));
  const validators = {};
  for (const kind of FILE_KINDS) validators[kind] = ajv.compile(await readSchema(kind));
  return validators;
}

function describeSchemaError(error) {
  switch (error.keyword) {
    case 'additionalProperties':
      return `unknown property "${error.params.additionalProperty}"`;
    case 'required':
      return `missing required property "${error.params.missingProperty}"`;
    case 'enum':
      return `must be one of: ${error.params.allowedValues.join(', ')}`;
    case 'false schema':
      return 'is not allowed here';
    default:
      return error.message ?? 'does not match the schema';
  }
}

/** Stage 1: one file against its schema. */
function schemaIssues(validate, entry) {
  if (validate(entry.data)) return [];
  return validate.errors.map((error) =>
    issue('error', 'SCHEMA', entry.file, error.instancePath || '/', describeSchemaError(error)),
  );
}

/** Indexes records by ID, reporting duplicates. */
function indexById(records, entry, listPointer, issues, seen = new Map()) {
  records.forEach((record, i) => {
    const pointer = `${listPointer}/${i}`;
    const earlier = seen.get(record.id);
    if (earlier) {
      issues.push(
        issue(
          'error',
          'DUPLICATE_ID',
          entry.file,
          `${pointer}/id`,
          `"${record.id}" is already used at ${earlier.file} ${earlier.pointer}`,
        ),
      );
      return;
    }
    seen.set(record.id, { record, file: entry.file, pointer });
  });
  return seen;
}

/** Stage 2: references between files. Only files that passed stage 1 are inspected. */
function referenceIssues(registry, passed, { today } = {}) {
  const issues = [];
  const ok = (entry) => entry !== null && passed.has(entry.file);

  // Decisions: one register shared by every foundation.
  const decisions = ok(registry.decisions)
    ? indexById(registry.decisions.data.decisions, registry.decisions, '/decisions', issues)
    : null;

  // Which decision replaced which: rules must cite the current decision, not the replaced one.
  const supersededBy = new Map();
  if (decisions) {
    registry.decisions.data.decisions.forEach((decision, i) => {
      (decision.supersedes ?? []).forEach((id, j) => {
        const pointer = `/decisions/${i}/supersedes/${j}`;
        if (id === decision.id) {
          issues.push(
            issue(
              'error',
              'SELF_REFERENCE',
              registry.decisions.file,
              pointer,
              `"${id}" supersedes itself`,
            ),
          );
        } else if (!decisions.has(id)) {
          issues.push(
            issue(
              'error',
              'UNRESOLVED_DECISION',
              registry.decisions.file,
              pointer,
              `"${id}" is not in the decision register`,
            ),
          );
        } else {
          supersededBy.set(id, decision.id);
        }
      });
    });
  }

  // Contract version: every file must declare the same one.
  const versioned = [
    registry.decisions,
    ...registry.foundations.flatMap((f) => [f.sources, f.rules, f.agent]),
    ...(registry.agents ?? []),
    registry.checks,
  ].filter((entry) => entry && ok(entry));
  const reference = versioned[0]?.data.contractVersion;
  for (const entry of versioned) {
    if (entry.data.contractVersion !== reference) {
      issues.push(
        issue(
          'error',
          'CONTRACT_MISMATCH',
          entry.file,
          '/contractVersion',
          `declares ${entry.data.contractVersion}, but ${versioned[0].file} declares ${reference}`,
        ),
      );
    }
  }

  // Checks: one registry. Each rule's checkId must resolve here, and each check's rules back.
  const checkIndex = ok(registry.checks)
    ? indexById(registry.checks.data.checks, registry.checks, '/checks', issues)
    : null;

  // Rules across all foundations, so dependsOn and decision blocks can cross foundations.
  // If any rules file failed stage 1 the set is incomplete, and "unknown rule" would be a false alarm.
  const allRules = new Map();
  for (const foundation of registry.foundations) {
    if (ok(foundation.rules))
      indexById(foundation.rules.data.rules, foundation.rules, '/rules', issues, allRules);
  }
  // A foundation folder with no rules.json (MISSING_PAIR) also leaves the set incomplete.
  const rulesComplete = registry.foundations.every((f) => ok(f.rules));
  const unknownRule = (id) => rulesComplete && !allRules.has(id);
  // Only with a valid register: without one, "waits on nothing" would be a false alarm.
  const waits = decisions
    ? openDecisionsByRule(
        registry.decisions.data.decisions,
        [...allRules.values()].map((v) => v.record),
      )
    : null;

  for (const foundation of registry.foundations) {
    const { name, sources, rules, agent } = foundation;
    if (!sources || !rules) {
      const present = sources ?? rules ?? agent;
      const missing = [!sources && 'sources.json', !rules && 'rules.json']
        .filter(Boolean)
        .join(' or ');
      if (present)
        issues.push(
          issue(
            'error',
            'MISSING_PAIR',
            present.file,
            '/',
            `the "${name}" foundation has no ${missing}`,
          ),
        );
      continue;
    }
    for (const entry of [sources, rules]) {
      if (ok(entry) && entry.data.foundation !== name) {
        issues.push(
          issue(
            'error',
            'FOUNDATION_MISMATCH',
            entry.file,
            '/foundation',
            `declares "${entry.data.foundation}" but sits in the "${name}" folder`,
          ),
        );
      }
    }
    if (!ok(sources) || !ok(rules)) continue;

    const sourceIndex = indexById(sources.data.sources, sources, '/sources', issues);
    const cited = new Set();
    const groups = new Set(rules.data.groups.map((g) => g.id));
    const prefix = rules.data.idPrefix;

    rules.data.rules.forEach((rule, i) => {
      const at = `/rules/${i}`;
      if (!groups.has(rule.group)) {
        issues.push(
          issue(
            'error',
            'UNKNOWN_GROUP',
            rules.file,
            `${at}/group`,
            `group "${rule.group}" is not listed in /groups`,
          ),
        );
      }
      if (!new RegExp(`^${prefix}-${rule.group}\\d+$`).test(rule.id)) {
        issues.push(
          issue(
            'error',
            'PREFIX_MISMATCH',
            rules.file,
            `${at}/id`,
            `"${rule.id}" should start with "${prefix}-${rule.group}"`,
          ),
        );
      }
      (rule.sources ?? []).forEach((id, j) => {
        cited.add(id);
        if (!sourceIndex.has(id)) {
          issues.push(
            issue(
              'error',
              'UNRESOLVED_SOURCE',
              rules.file,
              `${at}/sources/${j}`,
              `"${id}" is not in ${sources.file}`,
            ),
          );
        }
      });
      (rule.decisions ?? []).forEach((id, j) => {
        const pointer = `${at}/decisions/${j}`;
        const found = decisions?.get(id);
        if (!found) {
          issues.push(
            issue(
              'error',
              'UNRESOLVED_DECISION',
              rules.file,
              pointer,
              decisions
                ? `"${id}" is not in the decision register`
                : `"${id}" is cited but there is no valid decision register`,
            ),
          );
          return;
        }
        const status = found.record.status;
        if (supersededBy.has(id)) {
          issues.push(
            issue(
              'error',
              'DECISION_SUPERSEDED',
              rules.file,
              pointer,
              `"${id}" was replaced by "${supersededBy.get(id)}"; cite that instead`,
            ),
          );
        } else if (status === 'abandoned' || status === 'expired') {
          issues.push(
            issue(
              'error',
              'DECISION_CLOSED',
              rules.file,
              pointer,
              `"${id}" was ${status}; a rule can't rest on it`,
            ),
          );
        }
      });
      const waiting = waits ? [...(waits.get(rule.id) ?? [])].sort() : [];
      if (rule.status === 'approved') {
        for (const id of waiting) {
          issues.push(
            issue(
              'error',
              'DECISION_OPEN',
              rules.file,
              `${at}/status`,
              `"${rule.id}" is approved, but it waits on "${id}", which is still open`,
            ),
          );
        }
      }
      if (rule.status === 'proposed' && waits && waiting.length === 0) {
        issues.push(
          issue(
            'error',
            'PROPOSED_NOT_WAITING',
            rules.file,
            `${at}/status`,
            `"${rule.id}" is proposed (awaiting a decision), but no open decision cites or blocks it`,
          ),
        );
      }
      (rule.dependsOn ?? []).forEach((id, j) => {
        const pointer = `${at}/dependsOn/${j}`;
        if (id === rule.id)
          issues.push(
            issue('error', 'SELF_REFERENCE', rules.file, pointer, `"${id}" depends on itself`),
          );
        else if (unknownRule(id))
          issues.push(
            issue('error', 'UNRESOLVED_RULE', rules.file, pointer, `"${id}" is not a known rule`),
          );
      });
      if (rule.kind === 'check' && !rule.checkId) {
        issues.push(
          issue(
            'warning',
            'UNMAPPED_CHECK',
            rules.file,
            at,
            `"${rule.id}" is a check rule with no checkId yet`,
          ),
        );
      }
      if (rule.checkId) {
        const pointer = `${at}/checkId`;
        const check = checkIndex?.get(rule.checkId)?.record;
        if (!check) {
          issues.push(
            issue(
              'error',
              'UNRESOLVED_CHECK',
              rules.file,
              pointer,
              checkIndex
                ? `"${rule.checkId}" is not in the check registry`
                : `"${rule.checkId}" is cited but there is no valid check registry`,
            ),
          );
        } else {
          if (check.kind !== rule.checkKind) {
            issues.push(
              issue(
                'error',
                'CHECK_KIND_MISMATCH',
                rules.file,
                `${at}/checkKind`,
                `"${rule.id}" is a ${rule.checkKind} check, but "${check.id}" is a ${check.kind} check`,
              ),
            );
          }
          if (!check.rules.includes(rule.id)) {
            issues.push(
              issue(
                'error',
                'CHECK_LINK_MISMATCH',
                rules.file,
                pointer,
                `"${rule.id}" points to "${check.id}", which doesn't list it in its rules`,
              ),
            );
          }
        }
      }
    });

    if (rules.data.status === 'approved') {
      const pending = rules.data.rules.filter((r) => r.status !== 'approved').map((r) => r.id);
      if (pending.length > 0) {
        issues.push(
          issue(
            'error',
            'RULES_NOT_APPROVED',
            rules.file,
            '/status',
            `the file is approved, but ${pending.length} rule(s) are not: ` +
              `${pending.slice(0, 5).join(', ')}${pending.length > 5 ? ', …' : ''}`,
          ),
        );
      }
    }

    (rules.data.gaps ?? []).forEach((gap, i) => {
      const pointer = `/gaps/${i}/decision`;
      const found = decisions?.get(gap.decision);
      if (!found) {
        issues.push(
          issue(
            'error',
            'UNRESOLVED_DECISION',
            rules.file,
            pointer,
            decisions
              ? `"${gap.decision}" is not in the decision register`
              : `"${gap.decision}" is cited but there is no valid decision register`,
          ),
        );
      } else if (found.record.status !== 'open') {
        issues.push(
          issue(
            'error',
            'GAP_DECISION_CLOSED',
            rules.file,
            pointer,
            `"${gap.decision}" is ${found.record.status}; close this gap and update the rules it blocked`,
          ),
        );
      }
    });

    sources.data.sources.forEach((source, i) => {
      if (!cited.has(source.id)) {
        issues.push(
          issue(
            'warning',
            'UNUSED_SOURCE',
            sources.file,
            `/sources/${i}`,
            `"${source.id}" is not cited by any rule`,
          ),
        );
      }
    });
  }

  if (decisions) {
    registry.decisions.data.decisions.forEach((decision, i) => {
      if (decision.status === 'open' && decision.expiresOn && today && today > decision.expiresOn) {
        issues.push(
          issue(
            'error',
            'DECISION_EXPIRED',
            registry.decisions.file,
            `/decisions/${i}/expiresOn`,
            `"${decision.id}" was due by ${decision.expiresOn}; answer it, extend it, or mark it expired`,
          ),
        );
      }
      (decision.blocks ?? []).forEach((id, j) => {
        if (unknownRule(id)) {
          issues.push(
            issue(
              'error',
              'UNRESOLVED_RULE',
              registry.decisions.file,
              `/decisions/${i}/blocks/${j}`,
              `"${id}" is not a known rule`,
            ),
          );
        }
      });
    });
  }
  if (checkIndex) {
    registry.checks.data.checks.forEach((check, i) => {
      check.rules.forEach((ruleId, j) => {
        const pointer = `/checks/${i}/rules/${j}`;
        const rule = allRules.get(ruleId)?.record;
        if (!rule) {
          if (unknownRule(ruleId))
            issues.push(
              issue(
                'error',
                'UNRESOLVED_RULE',
                registry.checks.file,
                pointer,
                `"${ruleId}" is not a known rule`,
              ),
            );
        } else if (rule.checkId !== check.id) {
          issues.push(
            issue(
              'error',
              'CHECK_LINK_MISMATCH',
              registry.checks.file,
              pointer,
              `"${check.id}" lists "${ruleId}", but that rule's checkId is ${rule.checkId ? `"${rule.checkId}"` : 'not set'}`,
            ),
          );
        }
      });
    });
  }

  issues.push(...agentIssues(registry, ok));
  return issues;
}

/** Agent manifests: where each sits, what it may write, what its gate runs, who reviews it. */
function agentIssues(registry, ok) {
  const issues = [];
  const all = [
    ...registry.foundations.map((f) => ({ entry: f.agent, folder: f.name })),
    ...(registry.agents ?? []).map((entry) => ({ entry, folder: null })),
  ].filter(({ entry }) => entry);
  const valid = all.filter(({ entry }) => ok(entry));
  // If any manifest failed stage 1, "unknown reviewer" could be a false alarm.
  const complete = valid.length === all.length;

  const byName = new Map();
  for (const { entry } of valid) {
    const earlier = byName.get(entry.data.name);
    if (earlier) {
      issues.push(
        issue(
          'error',
          'DUPLICATE_ID',
          entry.file,
          '/name',
          `agent "${entry.data.name}" is already defined in ${earlier.file}`,
        ),
      );
    } else byName.set(entry.data.name, entry);
  }

  for (const { entry, folder } of valid) {
    const { data, file } = entry;
    if (folder !== null && data.role !== 'foundation') {
      issues.push(
        issue(
          'error',
          'AGENT_LOCATION',
          file,
          '/role',
          `only a foundation agent's manifest sits in a foundation folder; move "${data.name}" to knowledge-base/agents/`,
        ),
      );
    } else if (folder === null && data.role === 'foundation') {
      issues.push(
        issue(
          'error',
          'AGENT_LOCATION',
          file,
          '/role',
          `a foundation agent's manifest belongs in knowledge-base/foundations/${data.foundation}/agent.json`,
        ),
      );
    } else if (folder !== null && data.foundation !== folder) {
      issues.push(
        issue(
          'error',
          'FOUNDATION_MISMATCH',
          file,
          '/foundation',
          `declares "${data.foundation}" but sits in the "${folder}" folder`,
        ),
      );
    }

    data.writeScope.forEach((scope, i) => {
      const hit = PROTECTED.find((guarded) => scopeOverlaps(scope, guarded.path));
      if (hit) {
        issues.push(
          issue(
            'error',
            'SCOPE_PROTECTED',
            file,
            `/writeScope/${i}`,
            `"${scope}" reaches ${hit.path}, which only a person may change (${hit.why})`,
          ),
        );
      }
    });

    data.gate.checks.forEach((name, i) => {
      if (!registry.scripts?.includes(name)) {
        issues.push(
          issue(
            'error',
            'UNKNOWN_SCRIPT',
            file,
            `/gate/checks/${i}`,
            registry.scripts
              ? `"${name}" is not a script in package.json`
              : `"${name}" can't be checked: there is no package.json with scripts`,
          ),
        );
      }
    });

    (data.reviewedBy ?? []).forEach((name, i) => {
      const pointer = `/reviewedBy/${i}`;
      const reviewer = byName.get(name);
      if (name === data.name) {
        issues.push(issue('error', 'SELF_REFERENCE', file, pointer, `"${name}" reviews itself`));
      } else if (!reviewer) {
        if (complete)
          issues.push(
            issue('error', 'UNRESOLVED_AGENT', file, pointer, `"${name}" is not a known agent`),
          );
      } else if (reviewer.data.role !== 'reviewer') {
        issues.push(
          issue(
            'error',
            'UNRESOLVED_AGENT',
            file,
            pointer,
            `"${name}" is a ${reviewer.data.role} agent, not a reviewer`,
          ),
        );
      }
    });
  }
  return issues;
}

/**
 * Validates an in-memory registry. Pure: no file access, so tests can feed it variants.
 * @param {Registry} registry
 * @param {{ today?: string }} [options] today (YYYY-MM-DD) enables the decision expiry check.
 * @returns {Issue[]}
 */
export function validateRegistryData(registry, validators, options = {}) {
  const issues = [];
  const passed = new Set();
  const stageOne = (kind, entry) => {
    if (!entry) return;
    const found = schemaIssues(validators[kind], entry);
    issues.push(...found);
    if (found.length === 0) passed.add(entry.file);
  };
  stageOne('decisions', registry.decisions);
  for (const foundation of registry.foundations) {
    stageOne('sources', foundation.sources);
    stageOne('rules', foundation.rules);
    stageOne('agent', foundation.agent);
  }
  for (const agent of registry.agents ?? []) stageOne('agent', agent);
  stageOne('checks', registry.checks);
  issues.push(...referenceIssues(registry, passed, options));
  return issues;
}

async function readEntry(absolute, root, issues) {
  const file = path.relative(root, absolute).split(path.sep).join('/');
  let text;
  try {
    text = await readFile(absolute, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return { file, data: JSON.parse(text) };
  } catch (error) {
    issues.push(issue('error', 'PARSE', file, '/', `not valid JSON: ${error.message}`));
    return null;
  }
}

/**
 * Reads, under root: knowledge-base/decisions.json, knowledge-base/foundations/<name>/
 * {sources,rules,agent}.json, knowledge-base/agents/*.json, tools/checks/registry.json, and the
 * script names in package.json.
 */
export async function loadRegistry(root) {
  const issues = [];
  const base = path.join(root, 'knowledge-base');
  const registry = {
    decisions: await readEntry(path.join(base, 'decisions.json'), root, issues),
    foundations: [],
    agents: [],
    checks: null,
    scripts: null,
  };
  registry.checks = await readEntry(
    path.join(root, 'tools', 'checks', 'registry.json'),
    root,
    issues,
  );
  const pkg = await readEntry(path.join(root, 'package.json'), root, issues);
  if (pkg) registry.scripts = Object.keys(pkg.data.scripts ?? {}).sort();
  let folders = [];
  try {
    folders = (await readdir(path.join(base, 'foundations'), { withFileTypes: true })).filter((d) =>
      d.isDirectory(),
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const folder of folders.sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(base, 'foundations', folder.name);
    const sources = await readEntry(path.join(dir, 'sources.json'), root, issues);
    const rules = await readEntry(path.join(dir, 'rules.json'), root, issues);
    const agent = await readEntry(path.join(dir, 'agent.json'), root, issues);
    if (sources || rules || agent) {
      registry.foundations.push({ name: folder.name, sources, rules, agent });
    } else {
      issues.push(
        issue(
          'warning',
          'NOT_CONVERTED',
          `knowledge-base/foundations/${folder.name}`,
          '/',
          'this foundation has no sources.json or rules.json yet',
        ),
      );
    }
  }
  let agentFiles = [];
  try {
    agentFiles = (await readdir(path.join(base, 'agents'), { withFileTypes: true }))
      .filter((d) => d.isFile() && d.name.endsWith('.json'))
      .map((d) => d.name)
      .sort();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const name of agentFiles) {
    const entry = await readEntry(path.join(base, 'agents', name), root, issues);
    if (entry) registry.agents.push(entry);
  }
  return { registry, issues };
}

function summarise(registry) {
  // Each foundation file holds a list under the same name as its kind: sources.sources, rules.rules.
  const total = (kind) =>
    registry.foundations.reduce((n, f) => n + (f[kind]?.data?.[kind]?.length ?? 0), 0);
  const decisions = registry.decisions?.data?.decisions?.length ?? 0;
  const agents = registry.foundations.filter((f) => f.agent).length + registry.agents.length;
  return `${registry.foundations.length} foundation(s), ${total('rules')} rule(s), ${total('sources')} source(s), ${decisions} decision(s), ${agents} agent(s)`;
}

/** Today's date in local time, as YYYY-MM-DD. */
export function localDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { root: { type: 'string' }, json: { type: 'boolean' }, today: { type: 'string' } },
  });
  const root = path.resolve(values.root ?? process.cwd());
  const { registry, issues: loadIssues } = await loadRegistry(root);
  const today = values.today ?? localDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today))
    throw new Error(`--today must be YYYY-MM-DD, got "${today}"`);
  const issues = [
    ...loadIssues,
    ...validateRegistryData(registry, await createValidators(), { today }),
  ];
  const errors = issues.filter((i) => i.severity === 'error');
  if (values.json) {
    process.stdout.write(
      `${JSON.stringify({ errors: errors.length, warnings: issues.length - errors.length, issues }, null, 2)}\n`,
    );
  } else {
    const order = (i) => (i.severity === 'error' ? 0 : 1);
    for (const i of [...issues].sort((a, b) => order(a) - order(b))) {
      console.log(
        `${i.severity.toUpperCase().padEnd(7)} ${i.code.padEnd(19)} ${i.file} ${i.path}  ${i.message}`,
      );
    }
    console.log(
      `registry: ${summarise(registry)}. ${errors.length} error(s), ${issues.length - errors.length} warning(s).`,
    );
  }
  process.exitCode = errors.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
