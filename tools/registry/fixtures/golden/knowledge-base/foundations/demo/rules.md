<!-- Generated from knowledge-base/foundations/demo/rules.json by tools/registry/generate.mjs. Don't edit this file: change the JSON, then run npm run registry:generate. -->

# demo: rules

One testable sentence per rule, with its kind, sources, decisions and consumers.

**Status:** draft. **Contract:** 0.1.0.

- **Kind**
  - `check`: a machine enforces it (lint, test or CI); a rule a script can't test isn't a check.
  - `guidance`: the agent loads it while working.
  - `reference`: read when deciding.
- **Basis:** the sources ([sources.md](sources.md)), decisions ([decisions.md](../../decisions.md)) and other rules the rule rests on.
- **Consumers**
  - `layout`: the layout agent.
  - `a11y`: the accessibility reviewer.
  - `rtl`: the RTL and i18n reviewer.
  - `ci`: automated checks.
  - `qa`: the QA engineer.
  - `docs`: the documentation writer.
  - `platform`: the platform engineer.
- **Status**
  - `draft`: written, not approved.
  - `proposed`: awaiting a decision.
  - `approved`: agreed.
  - "waits on" names an open decision that blocks the rule.
- **Check:** the kind of check, then the check itself. The check that enforces this rule, in tools/checks/registry.json. Check rules only.
  - `data`: our scripts check token files and generated output.
  - `source`: lint checks the CSS source.
  - `rendered`: a check runs on a rendered page.

## 1. Demo group

| ID   | Rule                              | Kind     | Basis                 | Consumers | Status                     | Check                   |
| ---- | --------------------------------- | -------- | --------------------- | --------- | -------------------------- | ----------------------- |
| X-A1 | Demo rule enforced by a check.    | check    | S-DEMO-1, DEC-001     | ci        | approved                   | source: `chk-demo-size` |
| X-A2 | Demo rule waiting for a decision. | guidance | U-DEMO, DEC-002, X-A1 | layout    | proposed, waits on DEC-002 | —                       |

## Decisions these rules rest on

Answers, options and history are in [decisions.md](../../decisions.md).

| ID      | Question                     | Status   |
| ------- | ---------------------------- | -------- |
| DEC-001 | Fixture: which base size?    | answered |
| DEC-002 | Fixture: which growth ratio? | open     |

## Gaps to close

| Gap       | Blocks | Owner         | Decision |
| --------- | ------ | ------------- | -------- |
| Demo gap. | X-A2   | Fixture owner | DEC-002  |
