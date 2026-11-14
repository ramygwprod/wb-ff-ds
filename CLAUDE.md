# WB-FF-DS

## 1. What this is

WB-FF-DS is WideBot's AI-native, white-label design system, built in Angular.

- **Library `wb-ff-ds`** (`projects/wb-ff-ds`): the design system that ships. Selector prefix `lib`.
- **Docs site `ferrofluid-ds`** (`projects/ferrofluid-ds`): the **Ferrofluid Design System** site. It's an Angular app that uses the real library, and it deploys to GitHub Pages from `main`.
- **This repository is public.** It holds the design system only: nothing about any platform's backend, services or architecture.

## 2. Operating contract

- **You propose, CI decides, Ramy approves.** Never approve your own work.
- **Done means CI is green, plus evidence** (command output, test results). Never report success you haven't checked.
- **After 3 failed attempts at the same thing, stop and report BLOCKED** with what you tried.
- **Ask when anything is unknown.** Never invent, assume, or add dummy content or fake data.
- **No new runtime dependencies** without approval.
- **Never change tests, CI gates or checks to make something pass.**
- Consume master components only. **Edit a passing component; never regenerate it.**
- Start each task from `knowledge-base/`, never from rules held in memory. Its JSON is the source; the `.md` files are generated from it, so change the JSON and run `npm run registry:generate`. Entries are approved through the milestone PR (DEC-025).
- The `.gitignore` is an **allowlist**: only cleared design-system content is published. Never un-ignore a path without Ramy's approval.

## 3. Commands

CI runs these same scripts, so what passes locally is what CI checks.

| Command                     | What it does                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `npm ci`                    | Install exactly what's in the lockfile                                               |
| `npm start`                 | Docs site dev server (build the library first)                                       |
| `npm run build`             | Build the library, then the docs site                                                |
| `npm run build:lib`         | Build the library only                                                               |
| `npm run build:docs`        | Build the docs site only                                                             |
| `npm run watch:lib`         | Rebuild the library on change                                                        |
| `npm test`                  | Unit tests (the docs site; the library gets added when it has tests)                 |
| `npm run lint`              | Lint both projects, including template accessibility rules and the CSS checks        |
| `npm run format`            | Format allowed files (`.prettierignore` protects vendored skills and changelogs)     |
| `npm run format:check`      | Check formatting without changing anything                                           |
| `npm run registry:check`    | Validate the knowledge registry, check generated files are current, scan the run log |
| `npm run registry:generate` | Regenerate the knowledge-base Markdown (and local agent files) from the JSON         |
| `npm run test:tools`        | Tests for the pipeline tools: registry, generator, CSS checks, hooks                 |

Requires Node 26 (`.nvmrc`) and npm 11.20 (`packageManager`). `engine-strict` refuses other versions.

## 4. Standards

- **Accessibility:** WCAG **AA and AAA** as two switchable theme levels: the same components with different values, like light/dark. Follow the latest WCAG updates.
- **Direction:** RTL Arabic and LTR English. Use `@angular/cdk/bidi` for direction, and CSS logical properties (`margin-inline-start`, not `margin-left`).
- **Text:** built-in component text (EN/AR) comes from a **runtime label service**. It switches language without a rebuild, and white-label customers can override labels.
- **Layout:** responsive, desktop and mobile.
- **Theme axes:** brand × scheme (light/dark) × direction × compliance (AA/AAA) × density. What "density" means is not defined yet; ask before using it.
- **Standards referenced:** WAI-ARIA Authoring Practices, DTCG 2025.10 (design tokens), EN 301 549 (version still to confirm).
- Brand colours, fonts and tokens are not set yet. Don't add them.

## 5. Supply chain

- **Never bypass the install-script rules** (`--dangerously-allow-all-scripts` is forbidden). If a new package's install script blocks `npm ci`, report it for review. Approvals and denials live in `package.json` `allowScripts`.
- `.npmrc`: exact versions (`save-exact`), only versions published at least 7 days ago (`min-release-age=7`), strict install scripts, strict engines.
- New dependencies need approval and a passing audit. The CI audit gate allows only advisories that are explicitly accepted and recorded in the changelog.
- GitHub Actions are pinned by full commit SHA.
- `.claude/skills/` holds vendored copies, pinned by SHA-256 (`SOURCES.sha256`). Never edit them. To update one, re-copy it from source with approval.

## 6. Releases

- Semver, plus one changelog per release in `releases/vX.Y.Z.md` (date, time, goal achieved). Published changelogs are never rewritten.
- `main` is protected: every change goes through a PR, and both CI checks must pass. There's no bypass.
- **Agents never push, open PRs or merge.** You prepare the commands and Ramy runs them.

## 7. Angular best practices

These are Angular's own guidelines, generated by `ng new --ai-config=claude-code`. For deeper guidance, use the `angular-developer` skill (`.claude/skills/angular-developer`) and the Angular CLI MCP server (`.mcp.json`).

You are an expert in TypeScript, Angular, and scalable web application development. You write functional, maintainable, performant, and accessible code following Angular and TypeScript best practices.

### TypeScript Best Practices

- Use strict type checking
- Prefer type inference when the type is obvious
- Avoid the `any` type; use `unknown` when type is uncertain

### Angular Best Practices

- Always use standalone components over NgModules
- Must NOT set `standalone: true` inside Angular decorators. It's the default in Angular v20+.
- Do NOT set `changeDetection: ChangeDetectionStrategy.OnPush` explicitly. `OnPush` is the default in Angular v22+.
- Use signals for state management
- Implement lazy loading for feature routes
- Do NOT use the `@HostBinding` and `@HostListener` decorators. Put host bindings inside the `host` object of the `@Component` or `@Directive` decorator instead
- Use `NgOptimizedImage` for all static images.
  - `NgOptimizedImage` does not work for inline base64 images.

### Accessibility Requirements

- It MUST pass all AXE checks.
- It MUST meet WCAG AA and AAA (the two switchable theme levels in section 4), including focus management, color contrast, and ARIA attributes.

### Components

- Keep components small and focused on a single responsibility
- Use `input()` and `output()` functions instead of decorators
- Use `model()` for two-way bound properties with `[(prop)]` syntax instead of pairing `input()` with `output()`
- Use `computed()` for derived state
- Use `linkedSignal()` for state derived from multiple reactive sources that must stay synchronized
- Prefer inline templates for small components
- Prefer Signal Forms (`@angular/forms/signals`) for new forms. They are stable in Angular v22+ and provide signal-based state, type-safe field access, and schema-based validation
- When not using Signal Forms, prefer Reactive forms instead of Template-driven ones
- Do NOT use `ngClass`, use `class` bindings instead
- Do NOT use `ngStyle`, use `style` bindings instead
- Do NOT import `CommonModule`, import only the directives and pipes the template uses, such as `AsyncPipe` or `DatePipe`
- When using external templates/styles, use paths relative to the component TS file.

### State Management

- Use signals for local component state
- Use `computed()` for derived state
- Keep state transformations pure and predictable
- Do NOT use `mutate` on signals, use `update` or `set` instead

### Templates

- Keep templates simple and avoid complex logic
- Use native control flow (`@if`, `@for`, `@switch`) instead of `*ngIf`, `*ngFor`, `*ngSwitch`
- Use the async pipe to handle observables
- Do not assume globals like (`new Date()`) are available.

### Services

- Design services around a single responsibility
- Use the `providedIn: 'root'` option for singleton services
- Prefer the `@Service` decorator over `@Injectable({providedIn: 'root'})` for new singleton services (Angular v22+)
- Use the `inject()` function instead of constructor injection
