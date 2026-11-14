<!-- Generated from knowledge-base/foundations/demo/sources.json by tools/registry/generate.mjs. Don't edit this file: change the JSON, then run npm run registry:generate. -->

# demo: sources

What a foundation agent is judged by, learns from and reuses. Rules cite these by ID.

**Scope:** Fixture foundation used only by the validator tests.

- **Verified**: how the source was checked, and when.
  - `read`: the content was read.
  - `reachable`: the page loaded.
  - `search-only`: seen in search results only.
  - `unreachable`: could not be loaded.
  - `local`: a local file, not published.
- **Cited by**: the rules in [rules.md](rules.md) that cite the source. A dash means none do yet.

## Judged by

A standard the work is checked against.

| ID       | Source        | Edition  | Uses                 | Verified         | Links                                       | Cited by |
| -------- | ------------- | -------- | -------------------- | ---------------- | ------------------------------------------- | -------- |
| S-DEMO-1 | Demo standard | Level AA | Governs demo sizing. | read, 2026-01-01 | [example.org](https://example.org/standard) | X-A1     |

## Reuse

An existing WideBot input, kept local and never published.

| ID     | Source           | Uses             | Verified | Cited by |
| ------ | ---------------- | ---------------- | -------- | -------- |
| U-DEMO | Demo local input | Starting values. | local    | X-A2     |

## Browser support

From demo-features 1.0, checked 2026-01-01.

| Feature      | Status | Use  |
| ------------ | ------ | ---- |
| Demo feature | widely | core |

- **Status**
  - `widely`: Baseline, widely available.
  - `newly`: Baseline, newly available.
  - `limited`: not Baseline.
- **Use**
  - `core`: the core layout relies on it.
  - `enhancement`: used only behind @supports, with a working fallback.
  - `not-relied-on`: may appear, but nothing depends on it.
  - `not-used`: not used.
