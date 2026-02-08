---
name: fragno-commit
description:
  Create and execute git commits for the Fragno repo using project commit rules. Use when asked to
  draft or perform commits, split changes into atomic commits, craft conventional commit
  messages/scopes, or decide on changesets (including approval and execution).
---

# Fragno Commit

## Overview

Create conventional commit message(s) and optional description(s) for the current changes in this
agent session. Decide between a single commit or multiple atomic commits, propose a plan, get user
approval, then run git add/commit and show the final log.

## Always

- Read `specs/README.md` before anything else.
- Consider the current chat context for what changes belong together.
- Run `git status` and `git diff` (or read changed files) to understand changes.
- Do not run destructive commands (including `git reset`, `git clean`) and do not push.

## Commit Workflow (Single or Multiple Commits)

1. Analyze and group changes into logical, atomic commits based on intent, dependency order, and
   file relationships. If everything belongs together, plan a single commit.
2. Ensure each commit leaves the codebase working and keeps tests/types/docs with their code.
3. Build a commit plan that includes, for each commit:
   - Commit order (numbered; use one item for a single-commit plan)
   - Conventional commit message
   - Brief description
   - Files/changes included (use globs to keep it brief)
   - Changeset info (include type and default to patch unless asked otherwise)
4. Present the plan in a markdown code block.
5. Ask: "If this looks good, say 'yes'. If you'd like to adjust the grouping or order, let me know
   what to change."
6. Iterate until approved.
7. Create changeset files for commits that need them.
8. Execute commits in order using `git add` (use `git add -p` when splitting within a file) and
   `git commit`.
9. After all commits, run `git log --oneline -n [number]`.
10. Respond with: "✓ Created [N] commits" and mention changesets if created.

## References

- **Commit rules**: Read `references/rules.md` for conventional commit rules and atomic grouping
  guidelines.
- **Changesets**: Read `references/changesets.md` when deciding if a changeset is needed or when
  writing one.
- **Scopes**: Read `references/scopes.md` when choosing or validating commit scopes.

## Pre-commit Hooks

- `lefthook` runs on commit; fix any errors before committing.
- If formatting fails, `prettier` will autoformat; re-add files and re-commit.
