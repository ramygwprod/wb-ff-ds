# WB-FF-DS

WideBot's AI-native, white-label design system for Angular, with WCAG AA/AAA themes, RTL Arabic, light and dark modes, and layouts for mobile and desktop.

## Live docs

**Ferrofluid Design System:** https://ramygwprod.github.io/wb-ff-ds/

## Status

**v0.3.x: the pipeline is in place, with no tokens or components yet.** The workspace, library build, linting, CI, branch protection and docs deployment all work end to end. Design content comes next.

Every release has a changelog in [`releases/`](releases/).

## What's inside

| Path                     | What it is                                                                       |
| ------------------------ | -------------------------------------------------------------------------------- |
| `projects/wb-ff-ds`      | The design system library (Angular, `@angular/cdk` + `@angular/aria`)            |
| `projects/ferrofluid-ds` | The **Ferrofluid Design System** docs site, an Angular app that uses the library |
| `releases/`              | One changelog per release (semver)                                               |
| `knowledge-base/`        | Design knowledge, turned into guidelines over time (added once it has content)   |
| `tools/`                 | Design-system pipeline tools (added once it has content)                         |
| `.claude/skills/`        | The official Angular agent skill, vendored and SHA-256 pinned                    |
| `CLAUDE.md`              | Rules and commands for AI agents working in this repo                            |

## Goals

- **Accessibility:** WCAG AA and AAA as two switchable theme levels: the same components with different values.
- **Languages and direction:** English (LTR) and Arabic (RTL). Built-in text switches at runtime.
- **Themes:** light and dark, per brand.
- **Responsive:** desktop and mobile.
- **White-label:** components configurable per brand. The default brand is WideBot.

## Getting started

Requirements: **Node 26** (see `.nvmrc`) and **npm 11.20**. Other versions are refused.

```bash
npm ci              # install exactly what's in the lockfile
npm run build       # build the library, then the docs site
npm start           # docs site dev server
npm test            # unit tests
npm run lint        # lint, including template accessibility rules
npm run format      # format the code
```

The full list is in [`CLAUDE.md`](CLAUDE.md#3-commands).

## How changes land

1. Every change goes through a **pull request**. `main` is protected, with no direct pushes and no bypass.
2. **CI decides:** a clean install from the lockfile, signature verification, a dependency audit (only explicitly accepted advisories pass), format check, lint, build, unit tests, plus dependency review on PRs.
3. A maintainer merges once CI is green. Each merge to `main` deploys the docs site.

Supply-chain rules: exact dependency versions, only releases at least 7 days old, install scripts blocked unless reviewed, and GitHub Actions pinned by commit SHA.

## Licence

Not decided yet. Until a licence is added, all rights are reserved.
