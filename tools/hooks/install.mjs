#!/usr/bin/env node
/**
 * Installs the pipeline hooks into .claude/settings.json (spine step S5). Agents can't edit
 * settings files, so a person runs this. It keeps everything else in the file, replaces only
 * the entries that point at these hook scripts, and is safe to run again.
 * Usage: node tools/hooks/install.mjs          writes .claude/settings.json
 *        node tools/hooks/install.mjs --check  exit 1 unless the hooks are installed exactly
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { REPO_ROOT, WRITE_TOOLS } from './lib.mjs';

const SCRIPTS = {
  PreToolUse: 'tools/hooks/pre-tool-use.mjs',
  SubagentStop: 'tools/hooks/subagent-stop.mjs',
};

/** The hook entries, with the absolute path of the node running this (hooks may lack a PATH). */
export function hookEntries(node = process.execPath) {
  const command = (script, extra) => ({
    type: 'command',
    command: node,
    args: [`\${CLAUDE_PROJECT_DIR}/${script}`],
    ...extra,
  });
  return {
    PreToolUse: {
      matcher: WRITE_TOOLS.join('|'),
      hooks: [command(SCRIPTS.PreToolUse, { timeout: 30, onFailure: 'block' })],
    },
    SubagentStop: { hooks: [command(SCRIPTS.SubagentStop, { timeout: 900 })] },
  };
}

const ours = (group) =>
  (group.hooks ?? []).some((h) =>
    (h.args ?? []).some((a) => Object.values(SCRIPTS).some((s) => a.endsWith(s))),
  );

/** Settings with our entries replaced or added, and every other setting kept. */
export function merge(settings, entries) {
  const out = structuredClone(settings);
  out.hooks ??= {};
  for (const [event, entry] of Object.entries(entries)) {
    const others = (out.hooks[event] ?? []).filter((group) => !ours(group));
    out.hooks[event] = [...others, entry];
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { check: { type: 'boolean' } },
  });
  const file = path.join(REPO_ROOT, '.claude', 'settings.json');
  const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const wanted = merge(current, hookEntries());
  const same = JSON.stringify(current) === JSON.stringify(wanted);
  if (values.check) {
    console.log(
      same
        ? 'hooks: installed.'
        : 'hooks: not installed or out of date. Run: node tools/hooks/install.mjs',
    );
    process.exitCode = same ? 0 : 1;
  } else if (same) {
    console.log(`hooks: already installed in ${path.relative(REPO_ROOT, file)}.`);
  } else {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(wanted, null, 2)}\n`);
    console.log(
      `hooks: installed in ${path.relative(REPO_ROOT, file)} (PreToolUse write guard, SubagentStop finish gate).`,
    );
  }
}
