# Contribution Guidelines

We welcome all contributions!

This repository builds [Backoffice](README.md) and Fragno, the framework Backoffice is built with.
The project overview, architecture, common commands, tools, and development practices can all be
found in the [AGENTS.md](AGENTS.md) file.

## Rules

- Use common sense and be nice ;)

## How can I contribute?

- **Spreading the word**:
  - Tell your friends, co-workers, family, neighbors, followers, etc
  - Speak about it in meetups and conference

- **Creating issues**:
  - Please check if an existing issue or thread doesn't exist before submitting.
  - If an existing issue is only somewhat relevant, please submit a new issue and reference the old
    one instead of commenting on the existing one.
  - Be very _precise_ in the problem you're describing: reproduction steps, expected behavior,
    actual behavior, error messages, etc.

- **Updating documentation**:
  - Running and deploying Backoffice is documented in the [README](README.md) and
    [`apps/backoffice/README.md`](apps/backoffice/README.md).
  - Fragno's documentation, published at [fragno.dev](https://fragno.dev/docs), is located in the
    `apps/docs/content/docs` directory as Markdown files.

- **Opening PRs**:
  - Opening an issue beforehand is always a good idea
  - Submitting a PR directly is also fine, but that has a higher chance of being rejected

## Contacting the maintainers

If you want to contact us in a more casual manner than creating an issue, you can reach us on X:

- [Wilco Kruijer](https://x.com/wilcokr)
- [Jan Schutte](https://x.com/jan_schutte)

## Getting Started

1. Clone the repository
1. Run `pnpm exec turbo build types:check test`
1. Start Backoffice as described in [Run Backoffice locally](README.md#run-backoffice-locally)

## Common Commands

Note: Always run tasks through `turbo` and always include `--output-logs=errors-only`.

All commands use Turbo as the monorepo task runner. Always include `--output-logs=errors-only` to
reduce noise and only show errors.

- `pnpm exec turbo build --output-logs=errors-only` - Build all packages
- `pnpm exec turbo types:check --output-logs=errors-only` - TypeScript type checking across all
  packages
- `pnpm test:changed` - Run the tests of affected packages, selecting within Backoffice. Use this to
  verify your work (see [Changed tests](#changed-tests))
- `pnpm exec turbo test --output-logs=errors-only` - Run every test across all packages
- `pnpm run lint` - Run oxlint for the repo

Use `--filter` to target specific packages or directories:

- `--filter=@fragno-dev/core` - Target a specific package by name
- `--filter=./packages/fragno-db` - Target by path
- `--filter=./packages/*` - Target all packages in a directory
- `--filter=...@fragno-dev/core` - Target a package and all its dependencies

Examples:

- `pnpm exec turbo build --filter=@fragno-dev/db --output-logs=errors-only`
- `pnpm exec turbo test --filter=./packages/fragment-workflows --output-logs=errors-only`
- `pnpm exec turbo test:changed --filter=@fragno-apps/backoffice-rr --output-logs=errors-only`
- `pnpm run lint`

## Tools

- pnpm + Node
- Turbo(repo) for monorepo management
- TSDown for building packages
- Vitest
- Lefthook for pre-commit hooks
- oxfmt
- oxlint
- Changesets

## Development Practices

- [IMPORTANT]: Always run tests and type-check for relevant packages after making changes.
- DO NOT export things from barrel files (e.g. index.ts or mod.ts). Export files from package.json
  instead.
- ALWAYS assume full breaking changes.

### Testing

- When testing _types_, do NOT use `.toMatchTypeOf(..)`, it's deprecated. Use either
  toMatchObjectType or toExtend instead:
  - Use toMatchObjectType to perform a strict check on a subset of your type's keys
  - Use toExtend to check if your type extends the expected type
- Tests are colocated, e.g. `route.ts` -> `route.test.ts`
- DO NOT use mocks. Instead write the implementation such that real objects can be mocked in tests.

### Changed tests

`pnpm test:changed` runs `test:changed` in the packages Turbo marks affected since `TURBO_SCM_BASE`
(default `main`; CI uses `origin/main`). Pull requests run `test:changed`; main runs every test with
`test`.

The root `test:changed` task depends on `test`, so most packages simply run their full, cached
`test`. Only Backoffice, whose suite is slow, defines a `test:changed` script and overrides the
task's `dependsOn` to drop `test`. Its script, `scripts/run-changed-tests.mjs`, runs the tests whose
imports reach a changed Backoffice file, including uncommitted and untracked files. It runs the full
suite instead when a dependency package, a repository file outside the workspaces, a deleted file,
or a non-code file changed. Markdown is ignored unless a trigger matches.

Selection follows imports, so a Backoffice test that reaches a file another way needs that file in
`forceRerunTriggers` in `apps/backoffice/vitest.config.ts`. This covers `?raw` and
`import.meta.glob` imports, files read with `fs`, and tests that run code in a subprocess.

Backoffice's `test:changed` never runs the `cloudflare` Vitest project (`*.cloudflare.test.ts`),
because it is slow. Its Workers load Durable Objects from the Wrangler entry point, so import-graph
selection cannot narrow it; it would always run in full. CI runs it on pull requests through
`test:cloudflare`.

Backoffice's `test:changed` is never cached: a cache hit would replay a partial run as a pass.
