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
1. Run `bun install`
1. Run `bun run build:watch` (or just `build`)
1. `cd packages/<package-name>` & `bunx vitest` to run tests, or if in an app directory run
   `bun run dev` to start the app
