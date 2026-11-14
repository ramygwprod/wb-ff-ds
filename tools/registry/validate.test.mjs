/**
 * Tests for the registry validator: every case in fixtures/cases.json must
 * produce exactly its expected issue codes, and the valid fixture none.
 * Run with: npm run test:tools
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createValidators, loadRegistry, validateRegistryData } from './validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const REPO = path.resolve(HERE, '..', '..');

const validators = await createValidators();
const { registry: valid, issues: validLoadIssues } = await loadRegistry(
  path.join(FIXTURES, 'valid'),
);
const { cases } = JSON.parse(await readFile(path.join(FIXTURES, 'cases.json'), 'utf8'));

// Every case runs on this date, so the expiry cases don't depend on the clock.
const TODAY = '2026-06-01';

const codes = (issues) => [...new Set(issues.map((i) => i.code))].sort();

/** Applies add / replace / remove at a JSON Pointer (RFC 6901), in place. */
function applyOp(document, { op, path: pointer, value }) {
  const segments = pointer
    .split('/')
    .slice(1)
    .map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'));
  const last = segments.pop();
  const parent = segments.reduce((node, key) => {
    assert.ok(node && key in node, `fixture path ${pointer} does not exist`);
    return node[key];
  }, document);
  if (Array.isArray(parent)) {
    const index = last === '-' ? parent.length : Number(last);
    if (op === 'add') parent.splice(index, 0, value);
    else if (op === 'replace') parent[index] = value;
    else if (op === 'remove') parent.splice(index, 1);
  } else if (op === 'remove') {
    assert.ok(last in parent, `fixture path ${pointer} does not exist`);
    delete parent[last];
  } else {
    if (op === 'replace') assert.ok(last in parent, `fixture path ${pointer} does not exist`);
    parent[last] = value;
  }
}

/**
 * Returns a copy of the valid registry with one case's changes applied. "file" names the target:
 * decisions, checks (the check registry), the demo foundation's sources, rules or agent, or
 * "reviewer" (the reviewer manifest).
 */
function variant(testCase) {
  const registry = structuredClone(valid);
  const [holder, key] =
    testCase.file === 'decisions' || testCase.file === 'checks'
      ? [registry, testCase.file]
      : testCase.file === 'reviewer'
        ? [registry.agents, 0]
        : [registry.foundations[0], testCase.file];
  if (testCase.drop) {
    assert.notEqual(testCase.file, 'reviewer', 'drop is not supported for the reviewer');
    holder[key] = null;
    return registry;
  }
  for (const op of testCase.ops) applyOp(holder[key].data, op);
  return registry;
}

test('every schema compiles in strict mode', () => {
  assert.ok(validators.sources && validators.rules && validators.decisions);
});

test('the valid fixture produces no issues', () => {
  assert.deepEqual(validLoadIssues, []);
  assert.deepEqual(validateRegistryData(valid, validators, { today: TODAY }), []);
});

for (const testCase of cases) {
  test(`case: ${testCase.name}`, () => {
    const issues = validateRegistryData(variant(testCase), validators, { today: TODAY });
    assert.deepEqual(codes(issues), [...testCase.expect].sort(), JSON.stringify(issues, null, 2));
  });
}

test('every issue points at a file and a path', () => {
  for (const testCase of cases) {
    for (const found of validateRegistryData(variant(testCase), validators, { today: TODAY })) {
      assert.match(found.file, /\S/);
      assert.match(found.path, /^\//);
      assert.ok(found.severity === 'error' || found.severity === 'warning');
    }
  }
});

test('a file that is not valid JSON is reported, not thrown', async () => {
  const root = path.join(REPO, '_work', 'registry-test-broken');
  const dir = path.join(root, 'knowledge-base', 'foundations', 'demo');
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(path.join(dir, 'rules.json'), '{ "oops": }');
    const { issues } = await loadRegistry(root);
    assert.deepEqual(codes(issues), ['NOT_CONVERTED', 'PARSE']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the repository registry has no errors', async () => {
  const { registry, issues: loadIssues } = await loadRegistry(REPO);
  const issues = [...loadIssues, ...validateRegistryData(registry, validators)];
  const errors = issues.filter((i) => i.severity === 'error');
  assert.deepEqual(errors, []);
});
