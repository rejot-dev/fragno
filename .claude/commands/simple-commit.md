### Simple Commit

Create a concise & conventional commit message and description for the current changes IN THIS AGENT
session.

## Steps

1. Take into account the context of the current chat
1. If you're unsure, use `git status` and `git diff` to analyze the nature of changes
1. Create a changeset if the changes are relevant to end users of Fragno (see Changesets section)
1. Present the commit message, (optional, concise) description and (optional) changeset to the user
1. Ask: "If this looks good, say 'yes'. If you'd like to adjust the message or description, let me
   know what to change."
1. Iterate on feedback until the user is satisfied
1. Execute the commits in order using `git add` (with specific files/patches as needed) and
   `git commit`
1. After the commit is created, run `git log --oneline -n [number]` to show the final result

## Rules

### General

- DO NOT run destructive commands, INCLUDING BUT NOT LIMITED TO: `git reset`, `git clean`.
- DO NOT push
- ALWAYS keep tests, types, and docs together with the actual code that is being changed.
- Each line of the commit message should be less than 72 characters.

### Commit Structure

- Use conventional commits: `type(scope): description`
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `style`, `ci`, `build`
- Scopes are package based, commits can have multiple scopes.

### Packages Based Scopes:

[SCOPE] - [FOLDER]

- core - packages/fragno
- cli - apps/fragno-cli
- db - packages/fragno-db

- docs - apps/docs

- examples - example-apps/, example-fragments/

- create - packages/create, packages/create-cli

- node packages/fragno-node
- unplugin-fragno packages/unplugin-fragno

### File Splitting

- Use `git add -p` when a single file contains multiple independent changes
- Only split when changes are truly independent
- When in doubt, keep related changes together

### Changesets

- The changeset file HAS TO BE part of the commit that includes the changes
- Create a changeset ONLY if the changes affect end users of Fragno (library authors or app
  developers using Fragno)
- DO create changesets for:
  - New features, APIs, or functionality
  - Bug fixes that affect user code
  - Breaking changes
- DO NOT create changesets for:
  - Internal refactoring that doesn't change public APIs
  - Test-only changes
  - Build tooling or CI updates
  - Development workflow improvements
  - Example app changes (unless they demonstrate new features)

The goal is a git history that tells a clear story and allows easy debugging, reverting, and
cherry-picking.
