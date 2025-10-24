### Atomic Commits

Intelligently split current changes into multiple atomic commits that are logical, functional, and
follow best practices.

## Steps

1. Run `git status` to understand what files have changed
1. Run `git diff` (or read changed files) to analyze the nature of changes
1. Analyze and group changes into logical, atomic commits based on:
   - Related functionality (features that work together)
   - Change types (refactoring, new features, fixes, tests, docs)
   - Dependencies (what must come before what)
   - File relationships (changes that span multiple files for one feature)
1. Create a commit plan showing:
   - Commit order (numbered)
   - Commit message (with conventional commit format)
   - Files/changes included in each commit
   - Brief rationale for the grouping
1. Present the plan in a markdown code block
1. Ask: "If this looks good, say 'yes'. If you'd like to adjust the grouping or order, let me know
   what to change."
1. Iterate on feedback until the user approves
1. Execute the commits in order using `git add` (with specific files/patches as needed) and
   `git commit`
1. After all commits are done, run `git log --oneline -n [number]` to show the final result
1. Respond with: "✓ Created [N] atomic commits" and show the log output

## Rules

### Commit Structure

- Use conventional commits: `type(scope): description`
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `style`, `ci`, `build`
- Scope is optional (e.g., `feat(db): add migration support`)

### Atomicity & Functionality

- **CRITICAL**: Each commit MUST leave the codebase in a working state
- Tests and types must work after each commit
- Features and their tests go together
- Type definitions and implementations go together
- Don't separate interdependent changes

### Logical Grouping

- Group by intent, not by file or change type
- Refactoring before features
- Infrastructure before code that uses it
- Bug fixes separate from new features when possible

### File Splitting

- Use `git add -p` when a single file contains multiple independent changes
- Only split when changes are truly independent
- When in doubt, keep related changes together

### Special Cases

- Docs: Separate if unrelated, together if documenting new feature
- Tests: Together with the code they test
- Types: Together with implementation unless preparatory
- Migrations: Usually separate commits
- Package updates: Together with the feature that needs them

## Analysis Guidelines

When analyzing changes, consider:

1. **Dependency order**: What must exist before other things can work?
1. **Test coverage**: Does the commit include tests that would pass?
1. **Type safety**: Do types and implementation go together?
1. **Semantic grouping**: Do these changes serve one clear purpose?
1. **Reversibility**: Could this commit be reverted cleanly if needed?
1. **Review clarity**: Would a reviewer understand this commit in isolation?

The goal is a git history that tells a clear story and allows easy debugging, reverting, and
cherry-picking.
