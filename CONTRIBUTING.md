# Contribution Guidelines

We welcome all contributions!

The project overview, architecture, command commands, tools, and development practices can all be
found in the [CLAUDE.md](CLAUDE.md) file.

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
  - Documentation is located in the `packages/docs/content/docs` directory as Markdown files.

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

## Common Commands

Note: Always run tasks through `turbo` and always include `--output-logs=errors-only`.

All commands use Turbo as the monorepo task runner. Always include `--output-logs=errors-only` to
reduce noise and only show errors.

- `pnpm exec turbo build --output-logs=errors-only` - Build all packages
- `pnpm exec turbo types:check --output-logs=errors-only` - TypeScript type checking across all
  packages
- `pnpm exec turbo test --output-logs=errors-only` - Run tests across all packages
- `pnpm run lint` - Run oxlint for the repo

Use `--filter` to target specific packages or directories:

- `--filter=@fragno-dev/core` - Target a specific package by name
- `--filter=./packages/fragno-db` - Target by path
- `--filter=./packages/*` - Target all packages in a directory
- `--filter=...@fragno-dev/core` - Target a package and all its dependencies

Examples:

- `pnpm exec turbo build --filter=@fragno-dev/db --output-logs=errors-only`
- `pnpm exec turbo test --filter=./packages/fragment-workflows --output-logs=errors-only`
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
