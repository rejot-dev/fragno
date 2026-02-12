## Rules

The goal is a git history that tells a clear story and allows easy debugging, reverting, and
cherry-picking.

### General

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
- dispatch - packages/fragno-db/src/dispatchers
- forms - packages/forms
- node - packages/fragno-node
- stripe - packages/stripe
- unplugin - packages/unplugin-fragno
- wf - apps/fragno-wf

### Changesets

- The changeset file HAS TO BE part of the commit that includes the changes.
- Create a changeset ONLY if the changes affect end users of Fragno (library authors or app
  developers using Fragno).
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
- Changesets should be a single line.
- In changesets, wrap line breaks at 100 characters.
- Also add feat/fix/etc prefix to changeset description.
- ALWAYS use patch release unless explicitly asked for a major or minor release.
