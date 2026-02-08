# Commit Rules (Fragno)

The goal is a git history that tells a clear story and allows easy debugging, reverting, and
cherry-picking.

## General

- Always keep tests, types, and docs together with the code being changed.
- Each commit must leave the codebase in a working state; tests/types should pass after each commit.
- Commit everything unless it is gitignored.
- Each line of the commit message must be <= 72 characters.
- Use `git add -p` when a file contains multiple independent changes; otherwise keep related changes
  together.

## Conventional Commit Format

- Use `type(scope): description`.
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `style`, `ci`, `build`.
- Scopes are package-based; multiple scopes are allowed (see scopes reference).

## Atomic Grouping Guidelines

- Group by intent, not by file or change type.
- Prefer refactoring before features.
- Prefer infrastructure before code that uses it.
- Separate bug fixes from new features when possible.
- Consider dependency order, test coverage, type safety, semantic grouping, reversibility, and
  review clarity.
