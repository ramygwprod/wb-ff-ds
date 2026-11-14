#!/usr/bin/env node
/**
 * PreToolUse hook: the write guard (spine step S5). Runs before every file-writing tool call.
 * - Main session (no agent_type): left to Claude Code's normal permissions.
 * - A sub-agent may write only inside its manifest's write scope, never a protected path, never
 *   outside the repository. A sub-agent without a manifest may not write at all.
 * - If anything goes wrong for a sub-agent, the write is denied: the guard fails closed. The
 *   settings entry also sets onFailure: "block", so a crash or a timeout blocks too.
 * Usage (from .claude/settings.json): node tools/hooks/pre-tool-use.mjs [--root dir] [--log-dir dir]
 */
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  appendRunLog,
  decideWrite,
  isPublished,
  loadManifests,
  readStdinJson,
  REPO_ROOT,
  safeRunId,
  WRITE_TOOLS,
} from './lib.mjs';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { root: { type: 'string' }, 'log-dir': { type: 'string' } },
});
const root = path.resolve(values.root ?? REPO_ROOT);
const logDir = path.resolve(values['log-dir'] ?? path.join(root, 'knowledge-base', 'runs'));

const deny = (reason) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
};

let input = null;
try {
  input = await readStdinJson();
  const agentType = input.agent_type;
  if (agentType && WRITE_TOOLS.includes(input.tool_name)) {
    const filePath = input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? '';
    const { manifests } = await loadManifests(root);
    const d = decideWrite({ agentType, filePath, root, manifests });
    const registered = manifests?.has(agentType) ?? false;
    const where =
      d.rel === null ? 'outside-repo' : isPublished(root, d.rel) ? 'published' : 'unpublished';
    appendRunLog(logDir, {
      v: 1,
      at: new Date().toISOString(),
      event: 'write',
      agent: registered ? agentType : 'unregistered',
      run: safeRunId(input.agent_id),
      tool: input.tool_name,
      path: where === 'published' ? d.rel : null,
      where,
      decision: d.decision,
      why: d.why,
    });
    if (d.decision === 'denied') deny(d.reason);
  }
} catch (error) {
  // Fail closed for sub-agents. The main session (no agent_type) is never blocked by a guard bug.
  if (!input || input.agent_type)
    deny(`The write guard failed, so the write is refused: ${error.message}`);
}
