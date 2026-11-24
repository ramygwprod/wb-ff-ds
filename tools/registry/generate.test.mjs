/**
 * Tests for the registry Markdown generator. The valid fixture must render exactly the golden
 * files, a registry with errors must generate nothing, and drift must be reported.
 * Run with: npm run test:tools
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { build, findDrift, legend, loadSchemas, renderRegistry } from './generate.mjs';
import { createValidators, loadRegistry, validateRegistryData } from './validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VALID = path.join(HERE, 'fixtures', 'valid');
const GOLDEN = path.join(HERE, 'fixtures', 'golden');
const REPO = path.resolve(HERE, '..', '..');

const validators = await createValidators();
const schemas = await loadSchemas();
const { registry: valid } = await loadRegistry(VALID);

/** Every file under a folder, as forward-slash paths relative to it. */
async function filesUnder(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
}

/**
 * Golden copies of agent files sit under dot-claude/, not .claude/, so Claude Code can never load
 * a fixture as a real agent.
 */
const goldenPath = (file) => path.join(GOLDEN, file.replace(/^\.claude\//, 'dot-claude/'));

/** Splits a Markdown table row on unescaped pipes. */
const rowCells = (line) =>
  line
    .trim()
    .slice(1, -1)
    .split(/(?<!\\)\|/);

test('the valid fixture renders exactly the golden files', async () => {
  const outputs = await build(valid, validateRegistryData(valid, validators), VALID);
  assert.deepEqual(
    outputs.map((o) => path.relative(GOLDEN, goldenPath(o.file)).split(path.sep).join('/')).sort(),
    await filesUnder(GOLDEN),
  );
  for (const { file, content } of outputs) {
    assert.equal(content, await readFile(goldenPath(file), 'utf8'), file);
  }
});

test('rendering the same registry twice gives the same text', async () => {
  const first = await build(valid, [], VALID);
  const second = await build(structuredClone(valid), [], VALID);
  assert.deepEqual(first, second);
});

test('a registry with errors generates nothing', async () => {
  const broken = structuredClone(valid);
  broken.foundations[0].rules = null;
  const issues = validateRegistryData(broken, validators);
  assert.ok(issues.some((i) => i.severity === 'error'));
  await assert.rejects(build(broken, issues, VALID), /nothing was generated/);
});

test('drift: missing and changed files are reported, identical ones are not', async () => {
  const outputs = [
    { file: 'a.md', content: 'same\n' },
    { file: 'b.md', content: 'new\n' },
    { file: 'c.md', content: 'any\n' },
  ];
  const disk = { 'a.md': 'same\n', 'b.md': 'old\n' };
  const drift = await findDrift(outputs, async (file) => disk[file] ?? null);
  assert.deepEqual(drift, [
    { file: 'b.md', problem: 'differs from its JSON' },
    { file: 'c.md', problem: 'missing' },
  ]);
});

test('a pipe in rule text stays inside its table cell', () => {
  const piped = structuredClone(valid);
  piped.foundations[0].rules.data.rules[0].text = 'Use "px" | "rem" only.';
  const rules = renderRegistry(piped, schemas).find((o) => o.file.endsWith('rules.md'));
  const lines = rules.content.split('\n');
  const header = lines.find((l) => l.startsWith('| ID | Rule'));
  const row = lines.find((l) => l.startsWith('| X-A1 '));
  assert.ok(row.includes('"px" \\| "rem"'), row);
  assert.equal(rowCells(row).length, rowCells(header).length);
});

test('a replaced decision links both ways', () => {
  const replaced = structuredClone(valid);
  replaced.decisions.data.decisions.push({
    id: 'DEC-003',
    question: 'Fixture: which base size, revisited?',
    status: 'answered',
    options: ['16px'],
    answer: '16px, confirmed',
    decidedBy: 'Fixture owner',
    decidedOn: '2026-01-04',
    recordedOn: '2026-01-04',
    supersedes: ['DEC-001'],
  });
  replaced.foundations[0].rules.data.rules[0].decisions = ['DEC-003'];
  assert.deepEqual(validateRegistryData(replaced, validators), []);
  const register = renderRegistry(replaced, schemas).find((o) => o.file.endsWith('decisions.md'));
  const row = (id) => register.content.split('\n').find((l) => l.startsWith(`| ${id} `));
  assert.match(row('DEC-001'), /replaced by DEC-003/);
  assert.match(row('DEC-003'), /replaces DEC-001/);
});

test('a description that does not explain its enum exactly is rejected', () => {
  assert.throws(
    () => legend({ enum: ['a', 'b'], description: 'a: one.' }, 'test'),
    /unexplained: b/,
  );
  assert.throws(
    () => legend({ enum: ['a'], description: 'a: one. c: three.' }, 'test'),
    /not in the enum: c/,
  );
  assert.deepEqual([...legend({ enum: ['a'], description: 'a: one.' }, 'test')], [['a', 'one']]);
});

test('documents are published, agent files are local only', () => {
  const outputs = renderRegistry(valid, schemas);
  const local = outputs.filter((o) => !o.published).map((o) => o.file);
  assert.deepEqual(local.sort(), [
    '.claude/agents/foundations/foundation-demo.md',
    '.claude/agents/reviewers/demo-reviewer.md',
  ]);
  assert.ok(outputs.filter((o) => o.published).every((o) => o.file.startsWith('knowledge-base/')));
});

test('an agent file carries exactly the manifest tools, and no Bash', () => {
  const agent = renderRegistry(valid, schemas).find((o) => o.file.endsWith('foundation-demo.md'));
  const tools = /^tools: (.+)$/m.exec(agent.content)[1].split(', ');
  assert.deepEqual(tools, valid.foundations[0].agent.data.tools);
  assert.ok(!tools.includes('Bash'));
});

test('proposed guidance is listed apart from the guidance to apply, with what it waits on', () => {
  const section = (content, title) => content.split(`## ${title}\n`)[1]?.split('\n## ')[0] ?? null;
  for (const name of ['foundation-demo.md', 'demo-reviewer.md']) {
    const { content } = renderRegistry(valid, schemas).find((o) => o.file.endsWith(name));
    assert.ok(!section(content, 'Guidance to apply while working').includes('X-A2'), name);
    assert.match(
      section(content, 'Proposed guidance, not decided yet'),
      /Don't apply these.*\n\n- \*\*X-A2\*\* \(waits on DEC-002\)/,
      name,
    );
  }

  // Once its decision is answered and the rule is no longer proposed, it is guidance to apply.
  const decided = structuredClone(valid);
  const dec = decided.decisions.data.decisions.find((d) => d.id === 'DEC-002');
  delete dec.blocks;
  Object.assign(dec, {
    status: 'answered',
    answer: '1.5',
    decidedBy: 'Fixture owner',
    decidedOn: '2026-01-05',
  });
  decided.foundations[0].rules.data.rules.find((r) => r.id === 'X-A2').status = 'draft';
  decided.foundations[0].rules.data.gaps = [];
  assert.deepEqual(validateRegistryData(decided, validators), []);
  const { content } = renderRegistry(decided, schemas).find((o) =>
    o.file.endsWith('foundation-demo.md'),
  );
  assert.match(section(content, 'Guidance to apply while working'), /\*\*X-A2:\*\*/);
  assert.equal(section(content, 'Proposed guidance, not decided yet'), null);
});

test('a rule reaches an agent with its reason, and the rules document gives the reason its own column', () => {
  const section = (content, title) => content.split(`## ${title}\n`)[1]?.split('\n## ')[0] ?? null;
  const why =
    /Demo rule waiting for a decision\. \*\*Why:\*\* Demo reason for the waiting rule, which builds on X-A1\./;
  const outputs = renderRegistry(valid, schemas);
  for (const name of ['foundation-demo.md', 'demo-reviewer.md']) {
    const { content } = outputs.find((o) => o.file.endsWith(name));
    assert.match(section(content, 'Proposed guidance, not decided yet'), why, name);
  }

  // The same holds once the rule is guidance to apply.
  const decided = structuredClone(valid);
  const dec = decided.decisions.data.decisions.find((d) => d.id === 'DEC-002');
  delete dec.blocks;
  Object.assign(dec, {
    status: 'answered',
    answer: '1.5',
    decidedBy: 'Fixture owner',
    decidedOn: '2026-01-05',
  });
  decided.foundations[0].rules.data.rules.find((r) => r.id === 'X-A2').status = 'draft';
  decided.foundations[0].rules.data.gaps = [];
  const agent = renderRegistry(decided, schemas).find((o) => o.file.endsWith('foundation-demo.md'));
  assert.match(section(agent.content, 'Guidance to apply while working'), why);

  const lines = outputs.find((o) => o.file.endsWith('rules.md')).content.split('\n');
  const cells = (start) => rowCells(lines.find((l) => l.startsWith(start))).map((c) => c.trim());
  const header = cells('| ID | Rule');
  assert.equal(cells('| X-A1 ')[header.indexOf('Reason')], 'Demo reason for the checked rule.');
  assert.ok(lines.some((l) => l.startsWith('- **Reason:** ')));
});

test('a rule that a rule in the agent file names is given in that file, whatever its kind', () => {
  const section = (content, title) => content.split(`## ${title}\n`)[1]?.split('\n## ')[0] ?? null;
  // X-A2, guidance, names X-A1, a check rule, in its reason: without X-A1 the agent could not follow the pointer.
  for (const name of ['foundation-demo.md', 'demo-reviewer.md']) {
    const { content } = renderRegistry(valid, schemas).find((o) => o.file.endsWith(name));
    assert.match(
      section(content, 'Rules named above'),
      /- \*\*X-A1\*\* \(check\): Demo rule enforced by a check\. \*\*Why:\*\* Demo reason for the checked rule\./,
      name,
    );
  }
});

test('a rule named by a named rule is given too, and a name that is no rule is left alone', () => {
  const section = (content, title) => content.split(`## ${title}\n`)[1]?.split('\n## ')[0] ?? null;
  const chained = structuredClone(valid);
  const rules = chained.foundations[0].rules.data.rules;
  rules[0].reason = 'Demo reason for the checked rule: see X-A3, not Z-Z9.';
  rules.push({
    id: 'X-A3',
    group: 'A',
    text: 'Demo rule to read when deciding.',
    reason: 'Demo reason for the reference rule.',
    kind: 'reference',
    sources: ['S-DEMO-1'],
    consumers: ['ci'],
    status: 'draft',
  });
  assert.deepEqual(validateRegistryData(chained, validators), []);
  const { content } = renderRegistry(chained, schemas).find((o) =>
    o.file.endsWith('foundation-demo.md'),
  );
  const named = section(content, 'Rules named above');
  assert.match(named, /- \*\*X-A1\*\* \(check\)/);
  assert.match(named, /- \*\*X-A3\*\* \(reference\): Demo rule to read when deciding\./);
  assert.doesNotMatch(named, /\*\*Z-Z9\*\*/);
  // Each rule is given once, in the order it is first named.
  assert.equal(named.match(/^- \*\*X-A/gm).length, 2);
  assert.ok(named.indexOf('**X-A1**') < named.indexOf('**X-A3**'));
});

test('a rule nobody names is not repeated: an agent file that names none has no such section', () => {
  const plain = structuredClone(valid);
  plain.foundations[0].rules.data.rules[1].reason = 'Demo reason for the waiting rule.';
  for (const name of ['foundation-demo.md', 'demo-reviewer.md']) {
    const { content } = renderRegistry(plain, schemas).find((o) => o.file.endsWith(name));
    assert.doesNotMatch(content, /## Rules named above/, name);
    assert.doesNotMatch(content, /\*\*X-A1\*\*/, name);
  }
});

test('a rules file in which no rule states its reason renders no Reason column and no Why', () => {
  const bare = structuredClone(valid);
  for (const rule of bare.foundations[0].rules.data.rules) delete rule.reason;
  const outputs = renderRegistry(bare, schemas);
  const rules = outputs.find((o) => o.file.endsWith('rules.md')).content;
  assert.doesNotMatch(rules, /\| Reason \||- \*\*Reason:\*\*/);
  for (const name of ['foundation-demo.md', 'demo-reviewer.md']) {
    assert.doesNotMatch(outputs.find((o) => o.file.endsWith(name)).content, /\*\*Why:\*\*/, name);
  }
});

test("a foundation agent's open decisions include its gaps; a reviewer's don't", () => {
  const gapped = structuredClone(valid);
  gapped.decisions.data.decisions.push({
    id: 'DEC-003',
    question: 'Fixture: a question no rule covers yet?',
    options: [],
    status: 'open',
    recordedOn: '2026-01-04',
  });
  gapped.foundations[0].rules.data.gaps.push({
    gap: 'Demo gap with no rule.',
    owner: 'Fixture owner',
    decision: 'DEC-003',
  });
  assert.deepEqual(validateRegistryData(gapped, validators), []);
  const open = (name) =>
    renderRegistry(gapped, schemas)
      .find((o) => o.file.endsWith(name))
      .content.split('## Open decisions\n')[1]
      .split('\n## ')[0];
  assert.match(open('foundation-demo.md'), /\*\*DEC-003:\*\*/);
  assert.match(open('foundation-demo.md'), /\*\*DEC-002:\*\*/);
  assert.ok(!open('demo-reviewer.md').includes('DEC-003'));
});

test('a source is cited only by the rules of its own foundation, even when two foundations share its ID', () => {
  const two = structuredClone(valid);
  const second = structuredClone(valid.foundations[0]);
  second.name = 'second';
  second.agent = null;
  for (const entry of [second.sources, second.rules]) {
    entry.data.foundation = 'second';
    entry.file = entry.file.replace('/demo/', '/second/');
  }
  second.rules.data.idPrefix = 'Y';
  second.rules.data.gaps = [];
  second.rules.data.rules = [
    {
      id: 'Y-A1',
      group: 'A',
      text: 'A rule of the second foundation.',
      kind: 'guidance',
      sources: ['S-DEMO-1'],
      consumers: ['layout'],
      status: 'draft',
    },
  ];
  two.foundations.push(second);
  assert.deepEqual(
    validateRegistryData(two, validators).filter((i) => i.severity === 'error'),
    [],
  );
  const row = (folder) =>
    renderRegistry(two, schemas)
      .find((o) => o.file.endsWith(`${folder}/sources.md`))
      .content.split('\n')
      .find((l) => l.startsWith('| S-DEMO-1 '));
  assert.match(row('demo'), /\| X-A1 +\|$/);
  assert.match(row('second'), /\| Y-A1 +\|$/);
});

test("the repository's generated Markdown matches its JSON", async () => {
  const { registry, issues } = await loadRegistry(REPO);
  const outputs = await build(
    registry,
    [...issues, ...validateRegistryData(registry, validators)],
    REPO,
  );
  // Agent files are local only (DEC-039): CI never has them, so only published files count.
  const drift = await findDrift(
    outputs.filter((o) => o.published),
    async (file) => {
      try {
        return await readFile(path.join(REPO, file), 'utf8');
      } catch {
        return null;
      }
    },
  );
  assert.deepEqual(drift, [], 'run npm run registry:generate');
});
