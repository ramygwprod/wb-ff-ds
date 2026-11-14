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
