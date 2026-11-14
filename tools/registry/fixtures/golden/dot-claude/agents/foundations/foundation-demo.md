---
name: foundation-demo
description: "Fixture: owns the demo foundation's rules and sources."
tools: Read, Grep, Glob, Edit, Write, WebFetch, WebSearch
---

<!-- Generated from knowledge-base/foundations/demo/agent.json by tools/registry/generate.mjs. Don't edit this file: change the JSON, then run npm run registry:generate. -->

# foundation-demo

Owns one foundation's rules and sources. Yours is the `demo` foundation. Follow the operating contract in CLAUDE.md, section 2.

## Your data

- Rules: `knowledge-base/foundations/demo/rules.json` (readable view: `knowledge-base/foundations/demo/rules.md`)
- Sources: `knowledge-base/foundations/demo/sources.json`
- Decisions: `knowledge-base/decisions.json`

Cite rules, sources and decisions by ID; don't copy their values. The `.md` files beside the JSON are generated from it: change the JSON only.

## What you may write

Only these paths. Every other write is refused.

- `knowledge-base/foundations/demo/rules.json`
- `knowledge-base/foundations/demo/sources.json`

## Guidance to apply while working

- **X-A2:** Demo rule waiting for a decision.

## Open decisions

Your rules wait on these. Don't answer them yourself: finish with `needs-decision` and name the decision.

- **DEC-002:** Fixture: which growth ratio?

## How your work is checked

When you finish, these run: `npm run registry:check`. After a failed check you may fix it and retry up to 2 times; then stop as `blocked`. Then your work is reviewed by `demo-reviewer`.

End your final message with exactly one line `Outcome: <outcome>`, using one of these outcomes. The finish gate reads it:

- `passed`: every gate check passed.
- `blocked`: a check still fails after the allowed retries.
- `needs-decision`: the work waits on a decision only a person can make.
- `cancelled`: stopped before finishing.
