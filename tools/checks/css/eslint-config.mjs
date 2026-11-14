/**
 * Builds the ESLint flat config for CSS from tools/checks/registry.json, so the lint that runs
 * on the project is exactly the set of registered checks: nothing added by hand, nothing lost.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import css from '@eslint/css';

import wbff from './rules.mjs';

export const REGISTRY_PATH = fileURLToPath(new URL('../registry.json', import.meta.url));

/**
 * The repository root. Check globs are relative to it, whichever eslint.config.js includes them:
 * without this, a project's own config would read them relative to its folder and match nothing.
 */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The registered source checks. */
export function sourceChecks(path = REGISTRY_PATH) {
  return JSON.parse(readFileSync(path, 'utf8')).checks.filter((c) => c.kind === 'source');
}

/** The plugins every CSS config needs. */
export const cssPlugins = { css, wbff };

/** One flat config object per check, each limited to its own files. */
export function cssConfigs(path = REGISTRY_PATH) {
  return sourceChecks(path).map((check) => ({
    name: `wb-ff-ds/${check.id}`,
    basePath: REPO_ROOT,
    files: check.files,
    ...(check.ignores ? { ignores: check.ignores } : {}),
    language: 'css/css',
    plugins: cssPlugins,
    rules: check.eslint,
  }));
}
