# Remove AI code slop

Check the diff against main, and remove all AI generated slop introduced in this branch.

This includes:

- Extra comments that a human wouldn't add or is inconsistent with the rest of the file
- Extra defensive checks or try/catch blocks that are abnormal for that area of the codebase
  (especially if called by trusted / validated codepaths)
- Casts to any to get around type issues
- Any other style that is inconsistent with the file
- Make sure the code adheres to the style guide below

Report at the end with only a 1-3 sentence summary of what you changed

## Style Guide

- Do NOT use `any` unless absolutely necessary
- Use proper JSDoc comments for public APIs
- Prefer to destruct objects in things like for-loops.
- In Typescript, never use Array<T>, always use T[]
- Use Javascript private (#) for private members, NEVER use `private` in Typescript.
- Always use `import type` and indicate `type` as needed
- Always use curly braces, even for single-line blocks. You may add parentheses if you find a block
  without them.
- Avoid:
  - Enums
  - Constructor parameter members
  - TypeScript constructs that don't work with type stripping
- When using unsafe casts (`x as Y`), always add a comment explaining why it's safe. Prefer not to
  use them.

### Import/Export Patterns

- Use named exports over default exports
- Use relative imports within packages, package imports across packages
