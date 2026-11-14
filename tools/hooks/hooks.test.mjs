/**
 * Tests for the pipeline hooks: the write guard, the finish gate, the run log and the installer.
 * The decisions are tested as pure functions; the hook scripts are also run as Claude Code runs
 * them, with JSON on stdin, against the registry fixture.
 * Run with: npm run test:tools
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { scanRunLog } from './check-run-log.mjs';
import { hookEntries, merge } from './install.mjs';
import {
  appendRunLog,
  decideGate,
  decideWrite,
  parseOutcome,
  validateRunLogEntry,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const FIXTURE = path.join(REPO, 'tools', 'registry', 'fixtures', 'valid');
const WORK = path.join(REPO, '_work', 'hooks-test');
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
after(() => rmSync(WORK, { recursive: true, force: true }));

const manifest = (writeScope, name = 'foundation-demo') => ({
  name,
  writeScope,
  file: `${name}.json`,
});
const manifests = new Map([
  [
    'foundation-demo',
    manifest(['knowledge-base/foundations/demo/rules.json', 'projects/wb-ff-ds/src/lib/layout/**']),
  ],
  // A manifest that names protected paths: the validator rejects it, and the hook refuses anyway.
  ['rogue', manifest(['knowledge-base/decisions.json', 'tools/**'], 'rogue')],
]);
const write = (agentType, filePath, m = manifests) =>
  decideWrite({ agentType, filePath: path.resolve(REPO, filePath), root: REPO, manifests: m });

// ---------- Write guard decisions ----------

test('the main session is left to the normal permissions', () => {
  assert.equal(write(undefined, 'anything.txt').decision, 'pass');
});

test('an agent writes inside its scope', () => {
  assert.deepEqual(write('foundation-demo', 'knowledge-base/foundations/demo/rules.json'), {
    decision: 'allowed',
    why: 'in-scope',
    rel: 'knowledge-base/foundations/demo/rules.json',
  });
  assert.equal(
    write('foundation-demo', 'projects/wb-ff-ds/src/lib/layout/stack/stack.css').why,
    'in-scope',
  );
});

test('a folder scope does not cover a sibling that shares its prefix', () => {
  assert.equal(
    write('foundation-demo', 'projects/wb-ff-ds/src/lib/layout-extra/a.css').why,
    'out-of-scope',
  );
});

test('writes outside the scope, without a manifest, or with broken manifests are denied', () => {
  assert.equal(
    write('foundation-demo', 'knowledge-base/foundations/demo/sources.json').why,
    'out-of-scope',
  );
  assert.equal(
    write('general-purpose', 'knowledge-base/foundations/demo/rules.json').why,
    'no-manifest',
  );
  assert.equal(write('foundation-demo', 'README.md', null).why, 'invalid-manifests');
});

test('protected paths are denied even when a manifest lists them', () => {
  assert.equal(write('rogue', 'knowledge-base/decisions.json').why, 'protected');
  assert.equal(write('rogue', 'tools/registry/validate.mjs').why, 'protected');
  assert.equal(write('foundation-demo', '.claude/settings.json').why, 'protected');
  assert.equal(write('foundation-demo', 'knowledge-base/runs/2026-11.jsonl').why, 'protected');
  assert.equal(
    write('foundation-demo', 'knowledge-base/foundations/demo/agent.json').why,
    'protected',
  );
});

test('writes outside the repository are denied, including through .. and a symlink', () => {
  assert.equal(
    write('foundation-demo', path.join(REPO, '..', 'elsewhere.txt')).why,
    'outside-repo',
  );
  assert.equal(write('foundation-demo', 'knowledge-base/../../elsewhere.txt').why, 'outside-repo');
  const link = path.join(WORK, 'escape');
  symlinkSync(path.dirname(REPO), link);
  const viaLink = path.relative(REPO, path.join(link, 'elsewhere.txt'));
  assert.equal(write('rogue', viaLink).why, 'outside-repo');
});

// ---------- Finish gate decisions ----------

test('the outcome is the last "Outcome:" line of the final message', () => {
  assert.equal(parseOutcome('Done.\nOutcome: passed'), 'passed');
  assert.equal(
    parseOutcome('Outcome: passed\nmore work\noutcome: Needs-Decision'),
    'needs-decision',
  );
  assert.equal(parseOutcome('I think Outcome: passed is right'), null);
  // The outcome must be its own line, not the end of a sentence.
  assert.equal(parseOutcome('All good, so my Outcome: passed'), null);
  assert.equal(parseOutcome('Outcome: done'), null);
  assert.equal(parseOutcome(undefined), null);
});

const ok = [{ script: 'registry:check', passed: true, output: '' }];
const failing = [{ script: 'lint', passed: false, output: 'x.css\n  3:1 error L-L8: 100vh …' }];
const gate = (claimed, results, attempts = 0, maxRetries = 2) =>
  decideGate({ claimed, results, attempts, maxRetries });

test('the gate lets an agent stop only with a stated outcome that the checks bear out', () => {
  assert.deepEqual(gate('passed', ok), { action: 'stopped', outcome: 'passed' });
  const back = gate('passed', failing, 1);
  assert.equal(back.action, 'sent-back');
  assert.match(back.reason, /npm run lint failed/);
  assert.match(back.reason, /L-L8/);
  assert.match(back.reason, /1 retry\(ies\) left/);
  assert.deepEqual(gate('passed', failing, 2), { action: 'stopped', outcome: 'blocked' });
});

test('a missing outcome is sent back, then recorded as blocked once retries run out', () => {
  const back = gate(null, ok);
  assert.equal(back.action, 'sent-back');
  assert.match(back.reason, /Outcome: passed \| blocked \| needs-decision \| cancelled/);
  assert.deepEqual(gate(null, ok, 2), { action: 'stopped', outcome: 'blocked' });
  assert.deepEqual(gate(null, ok, 0, 0), { action: 'stopped', outcome: 'blocked' });
});

test('blocked, needs-decision and cancelled stop as stated', () => {
  for (const outcome of ['blocked', 'needs-decision', 'cancelled']) {
    assert.deepEqual(gate(outcome, failing), { action: 'stopped', outcome });
  }
});

// ---------- Run log ----------

const writeEntry = {
  v: 1,
  at: '2026-11-14T10:00:00.000Z',
  event: 'write',
  agent: 'foundation-demo',
  run: 'agent-1',
  tool: 'Write',
  path: 'knowledge-base/foundations/layout/rules.json',
  where: 'published',
  decision: 'allowed',
  why: 'in-scope',
};

test('the run log accepts only closed, structured entries', () => {
  assert.deepEqual(validateRunLogEntry(writeEntry), []);
  const bad = [
    { ...writeEntry, note: 'free text' },
    { ...writeEntry, where: 'unpublished' },
    { ...writeEntry, where: 'published', path: null },
    { ...writeEntry, agent: 'Some Plugin:Agent' },
    {
      v: 1,
      at: writeEntry.at,
      event: 'gate',
      agent: 'unregistered',
      run: 'a',
      claimed: null,
      outcome: 'passed',
      action: 'stopped',
      attempt: 0,
      checks: [],
    },
  ];
  for (const entry of bad)
    assert.notDeepEqual(validateRunLogEntry(entry), [], JSON.stringify(entry));
  assert.throws(
    () => appendRunLog(path.join(WORK, 'strict'), { ...writeEntry, note: 'x' }),
    /rejected/,
  );
  assert.equal(existsSync(path.join(WORK, 'strict')), false, 'nothing was written');
});

test('the run log scan catches unpublished paths, bad JSON and misfiled months', () => {
  const dir = path.join(WORK, 'scan');
  mkdirSync(dir, { recursive: true });
  const lines = [
    writeEntry,
    { ...writeEntry, path: '_work/notes.md' },
    { ...writeEntry, at: '2026-12-01T00:00:00.000Z' },
  ].map((e) => JSON.stringify(e));
  writeFileSync(path.join(dir, '2026-11.jsonl'), `${lines.join('\n')}\n{not json\n`);
  const { lines: count, problems } = scanRunLog(REPO, dir);
  assert.equal(count, 4);
  assert.equal(problems.length, 3, problems.join('\n'));
  assert.match(problems.join('\n'), /:2 names a path git doesn't publish/);
  assert.match(problems.join('\n'), /:3 is dated 2026-12/);
  assert.match(problems.join('\n'), /:4 is not valid JSON/);
});

// ---------- Installer ----------

test('the installer keeps other settings and replaces only its own hooks', () => {
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo', args: ['mine'] }] };
  const start = { permissions: { allow: ['Read'] }, hooks: { PreToolUse: [other] } };
  const once = merge(start, hookEntries('/usr/bin/node'));
  const twice = merge(once, hookEntries('/usr/bin/node'));
  assert.deepEqual(once, twice, 'running it again changes nothing');
  assert.deepEqual(once.permissions, start.permissions);
  assert.equal(once.hooks.PreToolUse.length, 2);
  assert.deepEqual(once.hooks.PreToolUse[0], other);
  const guard = once.hooks.PreToolUse[1];
  assert.equal(guard.matcher, 'Write|Edit|MultiEdit|NotebookEdit');
  assert.equal(guard.hooks[0].onFailure, 'block', 'a failing guard blocks the write');
  assert.equal(once.hooks.SubagentStop.length, 1);
});

// ---------- The hook scripts, run as Claude Code runs them ----------

const runHook = (script, input, extra = []) => {
  const logDir = path.join(WORK, `log-${script}`);
  const r = spawnSync(
    process.execPath,
    [path.join(HERE, script), '--root', FIXTURE, '--log-dir', logDir, ...extra],
    { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' },
  );
  const logFiles = existsSync(logDir) ? scanRunLog(FIXTURE, logDir) : { lines: 0, problems: [] };
  return {
    status: r.status,
    out: r.stdout ? JSON.parse(r.stdout) : null,
    stderr: r.stderr,
    log: logFiles,
  };
};
const toolCall = (agentType, rel) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: path.join(FIXTURE, rel), content: 'x' },
  ...(agentType ? { agent_type: agentType, agent_id: 'agent-test-1' } : {}),
});

test('pre-tool-use: in scope passes, everything else is denied with a reason', () => {
  const allowed = runHook(
    'pre-tool-use.mjs',
    toolCall('foundation-demo', 'knowledge-base/foundations/demo/rules.json'),
  );
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.out, null);
  assert.equal(allowed.log.problems.length, 0, allowed.log.problems.join('\n'));

  for (const [agent, rel, pattern] of [
    ['foundation-demo', 'tools/checks/registry.json', /protected/],
    [
      'foundation-demo',
      'knowledge-base/foundations/demo/notes.md',
      /outside foundation-demo's write scope/,
    ],
    ['general-purpose', 'knowledge-base/foundations/demo/rules.json', /has none/],
  ]) {
    const denied = runHook('pre-tool-use.mjs', toolCall(agent, rel));
    assert.equal(denied.status, 0, denied.stderr);
    assert.equal(denied.out.hookSpecificOutput.permissionDecision, 'deny', rel);
    assert.match(denied.out.hookSpecificOutput.permissionDecisionReason, pattern);
  }
});

test('pre-tool-use: the main session is untouched, and a broken input fails closed', () => {
  const main = runHook('pre-tool-use.mjs', toolCall(undefined, 'anything.txt'));
  assert.equal(main.out, null);
  const broken = runHook('pre-tool-use.mjs', '{not json');
  assert.equal(broken.out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(broken.out.hookSpecificOutput.permissionDecisionReason, /write guard failed/);
});

test('subagent-stop: a stated, passing outcome stops; a missing one is sent back', () => {
  const stateDir = path.join(WORK, 'state');
  const stop = (message, id) => ({
    hook_event_name: 'SubagentStop',
    agent_type: 'foundation-demo',
    agent_id: id,
    stop_hook_active: false,
    last_assistant_message: message,
  });
  const passed = runHook('subagent-stop.mjs', stop('Work done.\nOutcome: passed', 'agent-gate-1'), [
    '--state-dir',
    stateDir,
  ]);
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.out, null, 'allowed to stop');

  const missing = runHook('subagent-stop.mjs', stop('Work done.', 'agent-gate-2'), [
    '--state-dir',
    stateDir,
  ]);
  assert.equal(missing.out.decision, 'block');
  assert.match(missing.out.reason, /Outcome:/);
  assert.equal(
    JSON.parse(readFileSync(path.join(stateDir, 'agent-gate-2.json'), 'utf8')).attempts,
    1,
  );
  assert.equal(missing.log.problems.length, 0, missing.log.problems.join('\n'));

  const unregistered = runHook(
    'subagent-stop.mjs',
    { ...stop('x', 'agent-gate-3'), agent_type: 'Explore' },
    ['--state-dir', stateDir],
  );
  assert.equal(unregistered.out, null, 'agents without a manifest are not gated');
});
