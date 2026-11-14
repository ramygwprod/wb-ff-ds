/**
 * Proves every registered check on samples: each must-pass sample produces no error, and each
 * must-fail sample produces errors on exactly the lines it marks: a line ending in a fail comment,
 * or the line after a fail-next comment line (for lines where Prettier moves a trailing comment).
 * Also proves
 * that every check actually ran, that the project's lint config applies each check to its files,
 * and that the Baseline data inside @eslint/css agrees with the layout sources.
 * Run with: npm run test:tools
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';

import { cssPlugins, sourceChecks } from './css/eslint-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SAMPLES = path.join(HERE, 'samples');
const FAIL_MARK = /\/\* fail \*\/\s*$/;
const FAIL_NEXT = /^\s*\/\* fail-next \*\/\s*$/;

const checks = sourceChecks();
const executed = new Map();

/** The 1-based line numbers a sample marks as failing. */
const markedLines = (text) =>
  text.split('\n').flatMap((line, i, all) => {
    if (FAIL_MARK.test(line)) return [i + 1];
    if (i > 0 && FAIL_NEXT.test(all[i - 1])) return [i + 1];
    return [];
  });

/** Lints one text with only one check's rules switched on. */
async function lintWith(check, filePath, text) {
  const eslint = new ESLint({
    cwd: REPO,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.css'], language: 'css/css', plugins: cssPlugins, rules: check.eslint },
    ],
  });
  const [result] = await eslint.lintText(text, { filePath });
  return result;
}

const samplesOf = (check, outcome) => {
  const dir = path.join(SAMPLES, check.id, outcome);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.css'))
    .sort()
    .map((f) => path.join(dir, f));
};

for (const check of checks) {
  for (const outcome of ['pass', 'fail']) {
    for (const file of samplesOf(check, outcome)) {
      test(`${check.id} must ${outcome}: ${path.basename(file)}`, async () => {
        const text = readFileSync(file, 'utf8');
        const expected = markedLines(text);
        if (outcome === 'fail') assert.ok(expected.length > 0, 'mark each failing line');
        else assert.deepEqual(expected, [], 'a must-pass sample has no fail marks');

        const { messages } = await lintWith(check, file, text);
        const detail = JSON.stringify(messages.map((m) => [m.line, m.ruleId, m.message]));
        assert.deepEqual(
          messages.filter((m) => m.fatal),
          [],
          `the sample must parse: ${detail}`,
        );
        for (const m of messages) assert.ok(m.ruleId in check.eslint, `stray rule: ${detail}`);
        const lines = [...new Set(messages.map((m) => m.line))].sort((a, b) => a - b);
        assert.deepEqual(lines, expected, detail);

        const count = executed.get(check.id) ?? { pass: 0, fail: 0 };
        count[outcome] += 1;
        executed.set(check.id, count);
      });
    }
  }
}

test('every check proved itself on at least one must-pass and one must-fail sample', () => {
  for (const check of checks) {
    const count = executed.get(check.id);
    assert.ok(count?.pass >= 1 && count?.fail >= 1, `${check.id}: ${JSON.stringify(count)}`);
  }
  const orphans = readdirSync(SAMPLES).filter((d) => !checks.some((c) => c.id === d));
  assert.deepEqual(orphans, [], 'every samples folder belongs to a registered check');
});

test('every lint config ng lint uses runs each check on its files, and only there', async () => {
  const angular = JSON.parse(readFileSync(path.join(REPO, 'angular.json'), 'utf8'));
  const targets = Object.entries(angular.projects).map(([name, project]) => ({
    name,
    ...project.architect.lint.options,
  }));
  assert.ok(targets.length > 0);
  const globalStyles = 'projects/ferrofluid-ds/src/styles.css';
  for (const target of targets) {
    assert.ok(
      target.lintFilePatterns.includes(`projects/${target.name}/**/*.css`),
      `${target.name}: ng lint includes its CSS files`,
    );
    const eslint = new ESLint({ cwd: REPO, overrideConfigFile: target.eslintConfig });
    const component = `projects/${target.name}/src/lib/sample/sample.css`;
    const onComponent = (await eslint.calculateConfigForFile(component)).rules;
    const onGlobal = (await eslint.calculateConfigForFile(globalStyles)).rules;
    for (const check of checks) {
      const ignored = check.ignores?.some((glob) => path.matchesGlob(globalStyles, glob)) ?? false;
      for (const rule of Object.keys(check.eslint)) {
        assert.equal(
          onComponent[rule]?.[0],
          2,
          `${target.name}: ${check.id} (${rule}) on component CSS`,
        );
        assert.equal(
          onGlobal[rule]?.[0],
          ignored ? undefined : 2,
          `${target.name}: ${check.id} (${rule}) on styles.css`,
        );
      }
    }
  }
});

// Scopes written from the rules' own words, independent of the registry, so a scope change
// in the registry can't silently redefine a rule.
test('L-L1 covers component styles only, never a global styles.css', async () => {
  const eslint = new ESLint({ cwd: REPO });
  const rule = 'wbff/no-viewport-media';
  for (const file of [
    'projects/wb-ff-ds/src/lib/sample/sample.css',
    'projects/ferrofluid-ds/src/app/app.css',
  ]) {
    assert.equal(
      (await eslint.calculateConfigForFile(path.join(REPO, file))).rules[rule]?.[0],
      2,
      file,
    );
  }
  for (const file of [
    'projects/ferrofluid-ds/src/styles.css',
    'projects/wb-ff-ds/src/styles.css',
  ]) {
    assert.equal(
      (await eslint.calculateConfigForFile(path.join(REPO, file))).rules[rule],
      undefined,
      file,
    );
  }
});

test('the Baseline data inside @eslint/css agrees with the layout sources', async () => {
  const require = createRequire(import.meta.url);
  const dataFile = path.join(
    path.dirname(require.resolve('@eslint/css')),
    'data',
    'baseline-data.js',
  );
  const data = await import(pathToFileURL(dataFile).href);
  const sources = JSON.parse(
    readFileSync(path.join(REPO, 'knowledge-base/foundations/layout/sources.json'), 'utf8'),
  );
  const level = { widely: '10', newly: '5', limited: '0' };
  // Each layout Baseline feature that maps to one entry in the bundled data.
  const mapping = [
    ['Container queries', 'atRules', 'container'],
    ['Cascade layers', 'atRules', 'layer'],
    ['`@property`', 'atRules', 'property'],
    ['`@scope`', 'atRules', 'scope'],
    ['`round()` / `mod()` / `rem()`', 'functions', 'round'],
    ['`progress()`', 'functions', 'progress'],
    ['`dvh` / `svh` / `lvh`, `safe-area-inset`', 'units', 'dvh'],
    ['`reading-flow`', 'properties', 'reading-flow'],
  ];
  for (const [name, table, key] of mapping) {
    const feature = sources.baseline.features.find((f) => f.name === name);
    assert.ok(feature, `"${name}" is in sources.json`);
    const entry = data[table].get(key);
    assert.ok(entry, `${table}.${key} is in the bundled data`);
    const [status, year] = entry.split(':');
    assert.equal(
      status,
      level[feature.status],
      `${name}: sources say ${feature.status}, data says ${entry}`,
    );
    if (feature.status === 'newly') assert.equal(year, feature.since.slice(0, 4), `${name}: year`);
  }
});
