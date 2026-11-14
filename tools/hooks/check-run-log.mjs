#!/usr/bin/env node
/**
 * Scans the public run log before it is committed (DEC-021): every line must parse, match the
 * closed schema, and name only paths git publishes. Exit code 1 on any problem.
 * Usage: node tools/hooks/check-run-log.mjs [--root dir] [--log-dir dir]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { isPublished, REPO_ROOT, validateRunLogEntry } from './lib.mjs';

/** Every problem in the log folder, as "file:line message". */
export function scanRunLog(root, logDir) {
  if (!existsSync(logDir)) return { lines: 0, problems: [] };
  const problems = [];
  let lines = 0;
  for (const name of readdirSync(logDir).sort()) {
    const file = path.relative(root, path.join(logDir, name)).split(path.sep).join('/');
    if (!/^\d{4}-\d{2}\.jsonl$/.test(name)) {
      problems.push(`${file} isn't a run log file (expected YYYY-MM.jsonl)`);
      continue;
    }
    readFileSync(path.join(logDir, name), 'utf8')
      .split('\n')
      .forEach((text, i) => {
        if (!text) return;
        lines += 1;
        const at = `${file}:${i + 1}`;
        let entry;
        try {
          entry = JSON.parse(text);
        } catch {
          problems.push(`${at} is not valid JSON`);
          return;
        }
        const errors = validateRunLogEntry(entry);
        if (errors.length) {
          problems.push(
            `${at} doesn't match the run log schema: ${errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`,
          );
          return;
        }
        if (entry.path && !isPublished(root, entry.path)) {
          problems.push(`${at} names a path git doesn't publish`);
        }
        if (!name.startsWith(entry.at.slice(0, 7))) {
          problems.push(`${at} is dated ${entry.at.slice(0, 7)} but sits in ${name}`);
        }
      });
  }
  return { lines, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { root: { type: 'string' }, 'log-dir': { type: 'string' } },
  });
  const root = path.resolve(values.root ?? REPO_ROOT);
  const logDir = path.resolve(values['log-dir'] ?? path.join(root, 'knowledge-base', 'runs'));
  const { lines, problems } = scanRunLog(root, logDir);
  for (const p of problems) console.log(`RUN LOG ${p}`);
  console.log(`run log: ${lines} line(s), ${problems.length} problem(s).`);
  process.exitCode = problems.length ? 1 : 0;
}
