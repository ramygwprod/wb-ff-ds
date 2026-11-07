# Vendored skills: source record

Copied by hand from the official Angular repo, not installed with `npx skills` (a community tool). Files are unchanged from the source.
Integrity check: `cd .claude/skills && shasum -a 256 -c SOURCES.sha256` must report every file as OK.

| Skill | Source | Commit | Built | Copied | License |
|---|---|---|---|---|---|
| `angular-developer` | https://github.com/angular/skills | `9274c6e0c832610eefcb2204951fc8ecaac21a35` | 2026-11-07 09:16 UTC, from angular/angular `b4089e5f53f5ca7975dda34ae10f631e82f9c585` | 2026-11-07 | MIT (Google LLC, per SKILL.md) |

Not copied: `angular-new-app`. It's for apps, and its `--ai-config` values don't match Angular CLI 22.2 (see conversation 2026-11-07).
Updating: re-copy from a new commit, replace this row, regenerate SOURCES.sha256, and get Ramy's approval.
