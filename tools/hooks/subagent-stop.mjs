#!/usr/bin/env node
/**
 * SubagentStop hook: the finish gate (spine step S5). Runs when a sub-agent tries to finish.
 * For an agent with a manifest it regenerates the Markdown (agents have no Bash), runs the
 * manifest's gate checks, reads the agent's "Outcome: …" line, and either lets it stop or sends
 * it back with the failures, at most gate.maxRetries times. Every result goes to the run log.
 * Agents without a manifest aren't gated here (they can't write in the repository anyway).
 * Usage (from .claude/settings.json): node tools/hooks/subagent-stop.mjs [--root dir] [--log-dir dir] [--state-dir dir]
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  appendRunLog,
  decideGate,
  loadManifests,
  parseOutcome,
  readStdinJson,
  REPO_ROOT,
  runScripts,
  safeRunId,
} from './lib.mjs';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    root: { type: 'string' },
    'log-dir': { type: 'string' },
    'state-dir': { type: 'string' },
  },
});
const root = path.resolve(values.root ?? REPO_ROOT);
const logDir = path.resolve(values['log-dir'] ?? path.join(root, 'knowledge-base', 'runs'));
const stateDir = path.resolve(values['state-dir'] ?? path.join(root, '.claude', 'state', 'gate'));

const input = await readStdinJson();
const { manifests } = await loadManifests(root);
const manifest = input.agent_type ? manifests?.get(input.agent_type) : undefined;

if (manifest) {
  const run = safeRunId(input.agent_id);
  const stateFile = path.join(stateDir, `${run}.json`);
  const attempts = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')).attempts : 0;

  const results = runScripts(root, ['registry:generate', ...manifest.gate.checks]);
  const claimed = parseOutcome(input.last_assistant_message);
  const d = decideGate({ claimed, results, attempts, maxRetries: manifest.gate.maxRetries });

  if (d.action === 'sent-back') {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ attempts: attempts + 1 }));
  } else {
    rmSync(stateFile, { force: true });
  }
  appendRunLog(logDir, {
    v: 1,
    at: new Date().toISOString(),
    event: 'gate',
    agent: manifest.name,
    run,
    claimed,
    outcome: d.outcome,
    action: d.action,
    attempt: attempts,
    checks: results.map(({ script, passed }) => ({ script, passed })),
  });
  if (d.action === 'sent-back') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: d.reason }));
  }
}
