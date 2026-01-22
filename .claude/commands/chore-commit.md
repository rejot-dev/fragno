### Simple Commit

Before anything else, read `specs/README.md`.

Create a concise & conventional commit message and description for the current changes IN THIS AGENT
session.

## Steps

1. Take into account the context of the current chat
1. If you're unsure, use `git status` and `git diff` to analyze the nature of changes
1. Read and understand the commit rules in `specs/COMMIT.md`
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

### File Splitting

- Use `git add -p` when a single file contains multiple independent changes
- Only split when changes are truly independent
- When in doubt, keep related changes together

## Pre-commit

When you try to commit, `lefthook` will run. All errors should be fixed before committing. Note that
when `lefthook` fails on formatting, the files will automatically be formatted by `prettier`, and
can thus by re-committed immediately (no need to take action, besides `git add`ing the files again).
