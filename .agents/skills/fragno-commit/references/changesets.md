# Changesets (Fragno)

- Include the changeset file in the same commit as the change.
- Create a changeset only if changes affect end users (library authors or app developers using
  Fragno).
- Do create for: new features/APIs/functionality, bug fixes affecting user code, breaking changes.
- Do not create for: internal refactors without API change, tests-only, build tooling/CI, dev
  workflow improvements, example app changes (unless they demonstrate new features).
- Changeset should be a single line.
- Wrap changeset line breaks at 100 characters.
- Prefix changeset description with `feat`/`fix`/etc.
- Default to patch release unless explicitly asked for a major or minor release.
