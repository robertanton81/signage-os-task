# Monorepo Tooling Design Spec

**Date:** 2026-09-08
**Status:** Draft
**TODO items:** 1. Založení projektu — pnpm monorepo, sdílená striktní TypeScript konfigurace, lint / formátování / testovací runner, rootové skripty, `.gitignore` a `.env.example`
**Scope:** repository root, `packages/shared`, `apps/emulator`, `apps/ingest`, `apps/processing` (package skeletons only — no service code)

## Problem

The assignment fixes pnpm, strictly typed TypeScript and Node.js but leaves tooling open. Step 1 must produce a workspace where `pnpm lint && pnpm typecheck && pnpm test && pnpm build` works from a clean clone, with one shared TypeScript configuration, one place for dependency versions, and a test runner that separates unit tests from integration tests against the Docker Compose services. Only tooling is decided here. The message contract and the runtime libraries (AMQP client, MongoDB driver, validation, logging, config) are decided in TODO steps 0 and 2.

## Decisions Log

| #   | Question                          | Decision                                                                                                                                                                                                                                                                   | Reasoning                                                                                                                                                                                                                                                                                                                                                                       |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Node.js version                   | 24 (Active LTS "Krypton"), pinned in `.nvmrc` and `engines`                                                                                                                                                                                                                | Current LTS line; the local runtime is 24.14.0; ESLint 10 and Vitest 4 support it. Node 26 is not LTS until October 2026.                                                                                                                                                                                                                                                       |
| 2   | Package manager                   | pnpm 10.29.2 pinned via `packageManager`; a workspace **catalog** holds every dev-dependency version                                                                                                                                                                       | The assignment requires pnpm. `catalog:` keeps exactly one version of each tool across packages and makes upgrades a one-line change.                                                                                                                                                                                                                                           |
| 3   | TypeScript version                | 6.0.3, not 7.0.2                                                                                                                                                                                                                                                           | typescript-eslint 8.70.0 declares the peer range `typescript >=4.8.4 <6.1.0`, so the native TypeScript 7 (released 2026-09-08) is not usable with the lint toolchain yet. TypeScript 6 is the transition release whose defaults already match 7; no deprecated option is used, so the upgrade later is a version bump.                                                          |
| 4   | Module system                     | ESM (`"type": "module"`), `module` and `moduleResolution` = `nodenext`, `target` and `lib` = `es2024`, `types` = `["node"]`                                                                                                                                                | Node 24 runs ESM natively and `nodenext` mirrors its resolution (relative imports carry the `.js` extension). TypeScript 6 defaults `types` to `[]`, so `node` must be listed explicitly.                                                                                                                                                                                       |
| 5   | Strictness beyond `strict`        | `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`                                                                                                                             | Indexed access on arrays and records is where telemetry parsing bugs hide; `verbatimModuleSyntax` keeps type-only imports explicit for ESM. `exactOptionalPropertyTypes` is left off to avoid fighting third-party option types in a time-boxed task.                                                                                                                           |
| 6   | Build and typecheck               | TypeScript project references: every package is `composite`, apps reference `packages/shared`; root `tsconfig.json` lists all packages. `pnpm build` and `pnpm typecheck` both run `tsc -b`                                                                                | No extra build tooling. References build `packages/shared` before the apps and type errors surface across package boundaries. Build mode rejects `--noEmit` for referenced projects (TS6310, verified locally with TypeScript 6.0.3 — see Research), so typecheck necessarily emits; the output goes to gitignored `dist/`, which the Docker images run as `node dist/main.js`. |
| 7   | Cross-package resolution in tests | Root Vitest config aliases `@telemetry/shared` to `packages/shared/src/index.ts`; the package's `exports` points at `dist/` for runtime                                                                                                                                    | Tests never need a prior build and run against current sources; runtime (Docker, `node dist/…`) uses the built output.                                                                                                                                                                                                                                                          |
| 8   | Test runner                       | Vitest 4.1.11 (not 5.0.0), one root config with two projects: `unit` (`*/src/**/*.test.ts`) and `integration` (`*/test/integration/**/*.test.ts`, longer timeouts, no file parallelism)                                                                                    | Vitest 5.0.0 is three days old; 4.x is the proven line. Projects allow `--project unit` for fast feedback while integration tests need the Compose services. Test files sit next to the code they test (unit) or under `test/integration` (real broker + database).                                                                                                             |
| 9   | Lint                              | ESLint 10.10.0 flat config (`defineConfig`), `@eslint/js` 10.0.1, typescript-eslint 8.70.0 with the **type-checked** recommended config via `projectService`; extra rules: `no-console`, `no-non-null-assertion`, `consistent-type-imports`, `switch-exhaustiveness-check` | Type-aware rules (`no-floating-promises`, `no-misused-promises`) directly enforce the resilience conventions in `CLAUDE.md`; the codebase is small, so the type-check cost is negligible. Root config files are linted without type information.                                                                                                                                |
| 10  | Format                            | Prettier 3.9.6, `eslint-config-prettier` 10.1.8 (flat entry) last in the ESLint config                                                                                                                                                                                     | Formatting is Prettier's job; the config disables every stylistic ESLint rule that would fight it.                                                                                                                                                                                                                                                                              |
| 11  | Package names                     | `@telemetry/shared`, `@telemetry/emulator`, `@telemetry/ingest`, `@telemetry/processing`; all `"private": true`; cross-package deps via `workspace:*`                                                                                                                      | Matches `CLAUDE.md`; the scope keeps `pnpm --filter` commands unambiguous.                                                                                                                                                                                                                                                                                                      |
| 12  | Version ranges                    | Exact versions in the catalog (no `^`), `pnpm-lock.yaml` committed                                                                                                                                                                                                         | Reproducible for the reviewers; dependency bumps are out of scope for the assignment.                                                                                                                                                                                                                                                                                           |
| 13  | Dependency vetting                | typescript, @types/node, vitest, eslint, @eslint/js, typescript-eslint, prettier, eslint-config-prettier                                                                                                                                                                   | All eight are maintained by their upstream organisations, published within the last 14 months and have 53M–384M weekly downloads (npm registry, 2026-09-08). No security advisory check beyond that was run for these ubiquitous dev tools.                                                                                                                                     |

## Chosen Approach

A plain pnpm workspace with four packages, one shared `tsconfig.base.json`, TypeScript project references for build and typecheck, one root Vitest config with unit and integration projects, and one root ESLint flat config with type-aware rules. Every tool is configured once at the root; packages only carry their `package.json`, `tsconfig.json` and sources.

**Why this over alternatives:** no bundler, no task runner and no per-package config duplication. The assignment is assessed on architecture and explainable decisions, not on build sophistication; every piece here can be explained in one sentence.

## Research (source links)

- [Node.js release schedule](https://nodejs.org/en/about/previous-releases) — v24 is the Active LTS line ("Krypton"); v26 is Current without LTS status (checked via `https://nodejs.org/dist/index.json`, 2026-09-08).
- [pnpm catalogs](https://pnpm.io/catalogs) — `catalog:` protocol in `package.json`, definitions in `pnpm-workspace.yaml`, `catalogMode` setting since 10.12.1.
- [TypeScript 6.0 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html) — `strict`, `module: esnext` and `types: []` defaults, `rootDir` defaults to the tsconfig directory, deprecations of `baseUrl` / `moduleResolution node` / `esModuleInterop false`, `es2025` target.
- `npm view typescript-eslint peerDependencies` (2026-09-08) — `typescript: ">=4.8.4 <6.1.0"`, which rules out TypeScript 7.0.2 for now.
- Local probe (2026-09-08, `typescript@6.0.3`): in a two-project reference graph `tsc -b --noEmit` fails with `TS6310: Referenced project … may not disable emit`; `tsc -b` builds both packages in dependency order. Every `package.json` must carry `"type": "module"`, otherwise `verbatimModuleSyntax` reports TS1287/TS1295 because the files are treated as CommonJS.
- [Vitest test projects](https://vitest.dev/guide/projects) — `test.projects` with inline configs, `extends: true` to inherit root options, `--project <name>` filtering, project names must be unique.
- [typescript-eslint quickstart](https://typescript-eslint.io/getting-started) and [typed linting](https://typescript-eslint.io/getting-started/typed-linting) — `defineConfig` from `eslint/config`, `tseslint.configs.recommendedTypeChecked`, `parserOptions.projectService: true`.
- [ESLint v10 migration guide](https://eslint.org/docs/latest/use/migrate-to-10.0.0) — flat config only, config lookup from the linted file's directory, Node ≥ 20.19 / ≥ 22.13 / 24.
- [eslint-config-prettier README](https://github.com/prettier/eslint-config-prettier#installation) — flat entry `eslint-config-prettier/flat`, placed last.
- npm registry (`npm view <pkg> version time.modified`, `api.npmjs.org/downloads/point/last-week`, 2026-09-08): typescript 6.0.3 / 244M weekly; @types/node 24.13.3 / 384M; vitest 4.1.11 / 93M; eslint 10.10.0 / 138M; @eslint/js 10.0.1 / 123M; typescript-eslint 8.70.0 / 76M; prettier 3.9.6 / 114M; eslint-config-prettier 10.1.8 (2025-07-20) / 54M.

## Design

### Repository layout after step 1

```
package.json              private root: scripts, engines, packageManager, dev-dependencies via catalog
pnpm-workspace.yaml       packages globs + catalog with exact versions
tsconfig.base.json        shared compiler options (decisions 4–5)
tsconfig.json             root: files [], references to the four packages
vitest.config.ts          alias @telemetry/shared -> src; projects unit + integration
eslint.config.js          flat config (decision 9–10)
.prettierrc.json .prettierignore .editorconfig .nvmrc .env.example .gitignore README.md
packages/shared/          package.json (exports -> dist), tsconfig.json (composite), src/index.ts + src/*.test.ts
apps/emulator|ingest|processing/
                          package.json (workspace:* on shared), tsconfig.json (references shared), src/main.ts
docs/specs/ docs/plans/   design specs and implementation plans
```

### Root `package.json`

- `"private": true`, `"type": "module"`, `"packageManager": "pnpm@10.29.2"`, `"engines": { "node": ">=24 <25", "pnpm": ">=10" }`.
- Scripts: `build` (`tsc -b`), `typecheck` (`tsc -b` as well — see decision 6), `lint` (`eslint .`), `lint:fix`, `format` (`prettier --write .`), `format:check`, `test` (`vitest run`), `test:unit` (`vitest run --project unit`), `test:integration` (`vitest run --project integration`), `test:watch`.
- Dev-dependencies (all `catalog:`): typescript, @types/node, vitest, eslint, @eslint/js, typescript-eslint, prettier, eslint-config-prettier.

### Package skeletons

- `packages/shared`: `"exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }`; `src/index.ts` exports `assertNever(value: never, context?: string): never` — the exhaustiveness helper the event-type switches will use from step 2 on — with a unit test covering the thrown message. Nothing else until step 2.
- `apps/*`: `src/main.ts` declares the service name only; the real entry points are wired in steps 3–5. Each app depends on `@telemetry/shared` via `workspace:*` so the reference graph and the alias are exercised by `typecheck` and `build` from day one.
- Per-package scripts: `build` and `typecheck` (both `tsc -b`), `lint` (`eslint .`), `test` (`vitest run --root ../.. <package dir>`), so `pnpm --filter @telemetry/<pkg> <script>` works as `CLAUDE.md` documents.

### `tsconfig.base.json`

`module` / `moduleResolution` `nodenext`; `target` / `lib` `es2024`; `types: ["node"]`; `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`, `composite`, `declaration`, `declarationMap`, `sourceMap`, `skipLibCheck`. Packages set only `rootDir: "src"`, `outDir: "dist"`, `include: ["src"]` and `references`. Test files live under `src/` (unit) so they are type-checked with the code; they are emitted to `dist/` as well, which is harmless and avoids a second tsconfig per package.

### `vitest.config.ts`

`resolve.alias['@telemetry/shared'] = packages/shared/src/index.ts`; `test.projects`: `{ extends: true, test: { name: 'unit', include: ['{apps,packages}/*/src/**/*.test.ts'] } }` and `{ extends: true, test: { name: 'integration', include: ['{apps,packages}/*/test/integration/**/*.test.ts'], testTimeout: 30000, hookTimeout: 60000, fileParallelism: false } }`; `environment: 'node'` for both.

### `eslint.config.js`

`defineConfig` with `globalIgnores(['**/dist/**', '**/node_modules/**', '**/coverage/**'])`; for `**/*.ts`: `js.configs.recommended`, `tseslint.configs.recommendedTypeChecked`, `languageOptions.parserOptions = { projectService: true, tsconfigRootDir: import.meta.dirname }`, rules `no-console: error`, `@typescript-eslint/no-non-null-assertion: error`, `@typescript-eslint/consistent-type-imports: error`, `@typescript-eslint/switch-exhaustiveness-check: error`, `@typescript-eslint/no-unused-vars` with `_`-prefixed exceptions; root config files (`*.config.ts`, `*.config.js`) get `tseslint.configs.disableTypeChecked`; `eslint-config-prettier/flat` last.

### `.env.example`

Keys only, no values, one comment per key. The final key set is decided in step 2 (shared config); step 1 ships the keys that are certain from the assignment: `RABBITMQ_URL`, `MONGODB_URL`, `LOG_LEVEL`, `INGEST_HOST`, `INGEST_PORT`, `EMULATOR_DEVICE_COUNT`, `EMULATOR_EVENT_INTERVAL_MS`.

## Consistency & Failure Modes

N/A — this spec touches no message, queue or device-state behaviour.

## Scaling

N/A for tooling. The layout is ready for `docker compose --scale` in step 6: each app builds to its own `dist/` and has its own entry point.

## Alternatives Considered

### TypeScript 7.0 (native compiler)

Faster, but typescript-eslint's peer range excludes it today. Revisit after the assignment; TypeScript 6 uses no option that 7 removes.

### Vitest 5.0

Released 2026-09-05. Too new to trust for a time-boxed task; nothing in the plan needs a 5.x feature.

### Biome instead of ESLint + Prettier

One tool, faster, but no type-aware rules; `no-floating-promises` and `no-misused-promises` are worth more here than speed.

### tsx / Node type stripping instead of a build

Node 24 can run TypeScript directly, but the Docker images and the `exports` of `packages/shared` are simpler with a plain `tsc -b` build, and declaration output is what makes cross-package types reliable.

### Turborepo / Nx task runner

Four packages and five scripts do not justify a task runner; `pnpm -r` and `tsc -b` already order the work.
