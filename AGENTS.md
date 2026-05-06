# Repository Guidelines

## Project Structure & Module Organization

This is a Bun/Turbo monorepo. The main library lives in
`packages/oqronkit`, with TypeScript source in `packages/oqronkit/src` and
Vitest suites in `packages/oqronkit/test`. Runtime examples and local backend
experiments live in `apps/backend`. The documentation site is a Next/Fumadocs
app in `apps/docs`, with MDX content under `apps/docs/content/docs` and static
assets in `apps/docs/public`. Long-form exported documentation also exists in
`apps/documentations`.

## Build, Test, and Development Commands

Use Bun as the package manager (`bun@1.3.9`).

- `bun install`: install workspace dependencies.
- `bun run build`: run Turbo builds; `oqronkit` emits `dist` via `tsup` and
  TypeScript declarations.
- `bun run test`: build dependencies, then run package tests through Turbo.
- `bun --filter oqronkit test`: run only the library Vitest suite.
- `bun --filter oqronkit test:watch`: run library tests in watch mode.
- `bun run dev`: start persistent dev tasks for apps/packages.
- `bun --filter docs dev`: run the docs site locally.
- `bun run check`: run Biome checks and apply safe fixes across the workspace.
- `bun run format`: format tracked workspace files with Biome.

## Coding Style & Naming Conventions

Source is TypeScript. Follow Biome defaults configured in `biome.json`: 2-space
indentation, 80-column line width, double quotes, recommended lint rules, and
organized imports. Package modules use kebab-case filenames such as
`queue-engine.ts`, `define-cron.ts`, and `missed-fire.handler.ts`. Keep exported
APIs centralized through `src/index.ts` or relevant module index files.

## Testing Guidelines

Tests use Vitest with globals enabled and `*.test.ts` naming under
`packages/oqronkit/test`. Place tests near the domain folder they exercise
(`test/queue`, `test/scheduler`, `test/webhook`, etc.). Prefer focused tests for
new behavior, plus regression coverage for crash-safety, retries, persistence,
or adapter contracts. Use `bun --filter oqronkit test:coverage` when changing
shared engine behavior.

## Commit & Pull Request Guidelines

Commits follow Conventional Commits enforced by `commitlint`, with allowed types
including `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `deps`, and
`security`. Use `bun run commit` for the Commitizen prompt. PRs should include a
clear summary, test results, linked issues when applicable, and screenshots or
recordings for docs UI changes. Add a Changeset with `bun run changeset` for
publishable package changes.

## Security & Configuration Tips

Keep secrets in local `.env` files and avoid committing credentials. Treat
`apps/backend/data` SQLite files as local runtime state unless a fixture is
explicitly required.
