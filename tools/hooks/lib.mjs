/**
 * Shared logic for the pipeline hooks (spine step S5). The decisions are pure functions, so the
 * tests can feed them inputs; the hook scripts only read stdin, call them, and write stdout.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { createValidators, loadRegistry, PROTECTED, scopeOverlaps } from '../registry/validate.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
export const OUTCOMES = ['passed', 'blocked', 'needs-decision', 'cancelled'];
const SCHEMA_DIR = fileURLToPath(new URL('../registry/schemas/', import.meta.url));

/** Reads the hook's JSON input from stdin. */
export async function readStdinJson() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text);
}

/**
 * Every agent manifest by name. If any manifest fails its schema or two share a name, returns
 * manifests: null, and then no sub-agent may write: a broken contract fails closed.
 */
export async function loadManifests(root) {
  const { registry } = await loadRegistry(root);
  const validators = await createValidators();
  const entries = [...registry.foundations.map((f) => f.agent), ...registry.agents].filter(Boolean);
  const manifests = new Map();
  for (const entry of entries) {
    if (!validators.agent(entry.data)) {
      return { manifests: null, error: `${entry.file} doesn't match the agent schema` };
    }
    if (manifests.has(entry.data.name)) {
      return { manifests: null, error: `two manifests are named "${entry.data.name}"` };
    }
    manifests.set(entry.data.name, { ...entry.data, file: entry.file });
  }
  return { manifests, error: null };
}

/** Whether a repository-relative path is inside a write scope (a file, or a folder ending /**). */
export function inScope(rel, scope) {
  return scope.some((entry) =>
    entry.endsWith('/**') ? rel.startsWith(`${entry.slice(0, -3)}/`) : rel === entry,
  );
}

/** Protected for every agent: any dot segment (.claude, .github, .git, ..), or the shared list. */
export function protectedReason(rel) {
  if (rel.split('/').some((segment) => segment.startsWith('.'))) return 'a dot path';
  return PROTECTED.find((guarded) => scopeOverlaps(rel, guarded.path))?.why ?? null;
}

/** The real path of a file's nearest existing ancestor, so a symlink can't lead outside. */
function realAncestor(abs) {
  let current = abs;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return realpathSync(current);
}

/** Resolves a tool's file path against the repository: { rel } inside it, or { rel: null }. */
export function resolveInRepo(root, filePath) {
  const realRoot = realpathSync(root);
  const abs = path.resolve(root, filePath);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { rel: null };
  const real = realAncestor(abs);
  if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) return { rel: null };
  return { rel: rel.split(path.sep).join('/') };
}

/** Whether git publishes a path (it isn't ignored). Anything git can't confirm counts as unpublished. */
export function isPublished(root, rel) {
  const result = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: root });
  return result.status === 1;
}

/**
 * The write decision for one tool call. agentType is absent in the main session, which this
 * hook leaves to Claude Code's normal permissions.
 * rel is the repository-relative path, or null when the path is outside the repository.
 * @returns {{ decision: 'pass' | 'allowed' | 'denied', why?: string, rel?: string | null, reason?: string }}
 */
export function decideWrite({ agentType, filePath, root, manifests }) {
  if (!agentType) return { decision: 'pass' };
  // Resolve first, so every decision (and the run log) knows where the path is.
  const { rel } = resolveInRepo(root, filePath);
  if (manifests === null) {
    return {
      decision: 'denied',
      why: 'invalid-manifests',
      rel,
      reason:
        "The agent manifests don't validate, so no agent may write. Run npm run registry:check.",
    };
  }
  const manifest = manifests.get(agentType);
  if (!manifest) {
    return {
      decision: 'denied',
      why: 'no-manifest',
      rel,
      reason: `Only agents with a manifest may write in this repository, and "${agentType}" has none.`,
    };
  }
  if (rel === null) {
    return {
      decision: 'denied',
      why: 'outside-repo',
      rel,
      reason: `${manifest.name} may write only inside the repository.`,
    };
  }
  const guarded = protectedReason(rel);
  if (guarded) {
    return {
      decision: 'denied',
      why: 'protected',
      rel,
      reason: `"${rel}" is protected (${guarded}); only a person may change it.`,
    };
  }
  if (!inScope(rel, manifest.writeScope)) {
    return {
      decision: 'denied',
      why: 'out-of-scope',
      rel,
      reason:
        `"${rel}" is outside ${manifest.name}'s write scope (${manifest.file}): ` +
        (manifest.writeScope.length ? manifest.writeScope.join(', ') : 'it may write nothing') +
        '.',
    };
  }
  return { decision: 'allowed', why: 'in-scope', rel };
}

/** The last "Outcome: …" line of a final message, or null. */
export function parseOutcome(message) {
  const found = [...String(message ?? '').matchAll(/^\s*Outcome:\s*([a-z-]+)\s*\.?\s*$/gim)];
  const value = found.at(-1)?.[1]?.toLowerCase();
  return OUTCOMES.includes(value) ? value : null;
}

/**
 * The finish-gate decision. results: [{ script, passed, output }]. attempts: how many times this
 * run was already sent back.
 * @returns {{ action: 'stopped' | 'sent-back', outcome: string, reason?: string }}
 */
export function decideGate({ claimed, results, attempts, maxRetries }) {
  const failing = results.filter((r) => !r.passed);
  const canRetry = attempts < maxRetries;
  const details = failing
    .map(
      (r) =>
        `npm run ${r.script} failed:\n${String(r.output ?? '')
          .trim()
          .split('\n')
          .slice(-40)
          .join('\n')}`,
    )
    .join('\n\n');
  if (!claimed) {
    if (!canRetry) return { action: 'stopped', outcome: 'blocked' };
    return {
      action: 'sent-back',
      outcome: 'blocked',
      reason:
        `End your final message with one line: Outcome: ${OUTCOMES.join(' | ')}.` +
        (details ? `\n\n${details}` : ''),
    };
  }
  if (claimed !== 'passed') return { action: 'stopped', outcome: claimed };
  if (failing.length === 0) return { action: 'stopped', outcome: 'passed' };
  if (!canRetry) return { action: 'stopped', outcome: 'blocked' };
  return {
    action: 'sent-back',
    outcome: 'blocked',
    reason:
      `You said "Outcome: passed", but ${failing.length} gate check(s) failed. ` +
      `Fix them and finish again (${maxRetries - attempts} retry(ies) left), ` +
      'or finish with "Outcome: blocked".\n\n' +
      details,
  };
}

/** Runs npm scripts with the npm that sits next to this node, as the hooks may not have a PATH. */
export function runScripts(root, scripts) {
  const local = path.join(path.dirname(process.execPath), 'npm');
  const npm = existsSync(local) ? local : 'npm';
  return scripts.map((script) => {
    const r = spawnSync(npm, ['run', '-s', script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 600_000,
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });
    return { script, passed: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  });
}

// ---------- Run log ----------

let runLogValidator = null;
function validateRunLogEntry(entry) {
  if (!runLogValidator) {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    runLogValidator = ajv.compile(
      JSON.parse(readFileSync(path.join(SCHEMA_DIR, 'run-log.schema.json'), 'utf8')),
    );
  }
  return runLogValidator(entry) ? [] : runLogValidator.errors;
}
export { validateRunLogEntry };

/** The log file for a moment: knowledge-base/runs/YYYY-MM.jsonl (UTC). */
export function runLogFile(logDir, at) {
  return path.join(logDir, `${at.slice(0, 7)}.jsonl`);
}

/**
 * Appends one entry to the public run log. A strict writer: an entry that doesn't match the
 * schema throws, so nothing free-form or private can be written by mistake.
 */
export function appendRunLog(logDir, entry) {
  const errors = validateRunLogEntry(entry);
  if (errors.length) throw new Error(`run log entry rejected: ${JSON.stringify(errors)}`);
  mkdirSync(logDir, { recursive: true });
  appendFileSync(runLogFile(logDir, entry.at), `${JSON.stringify(entry)}\n`);
}

/** A run ID safe for the log and for state file names. */
export const safeRunId = (id) =>
  /^[A-Za-z0-9_-]{1,64}$/.test(String(id)) ? String(id) : 'unknown';
