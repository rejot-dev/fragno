# @fragno-dev/corpus

Code examples and documentation for Fragno, organized by subject. Used by the Fragno CLI and
documentation site to provide tested, type-checked examples for humans and LLMs.

## What is Corpus?

Corpus is a collection of working code examples organized into subjects like "defining routes" or
"database querying". All examples are:

- **Tested**: Code runs through vitest with type checking
- **Documented**: Each example includes explanations
- **Portable**: Can be consumed by CLI, docs, or other tools

## Usage

```typescript
import { getSubjects, getSubject, getAllSubjects } from "@fragno-dev/corpus";

// List available subjects
const subjects = getSubjects();
// [{ id: "defining-routes", title: "Defining Routes" }, ...]

// Get one or more subjects (deterministically ordered by subject tree)
const [routes] = getSubject("defining-routes");
// { id, title, description, imports, prelude, testInit, examples, sections }

// Get multiple subjects for combined context
const [adapters, kysely] = getSubject("database-adapters", "kysely-adapter");
```

## Markdown Format

Each subject is a markdown file in `src/subjects/` using code fence directives:

### @fragno-imports

Required block at the top with all imports:

\`\`\`typescript @fragno-imports import { defineRoute } from "@fragno-dev/core"; import { z } from
"zod"; \`\`\`

### @fragno-prelude (optional)

Setup code shown to users reading the corpus (e.g., schema definitions, configuration):

\`\`\`typescript @fragno-prelude:schema const userSchema = schema((s) => { return
s.addTable("users", (t) => { return t.addColumn("id", idColumn()); }); }); \`\`\`

Optional ID syntax (`:schema`) helps identify code blocks for agent references.

### @fragno-test-init (optional)

Test-only initialization code (not shown to users, only used in generated tests):

\`\`\`typescript @fragno-test-init const { fragment } = await
createDatabaseFragmentForTest(testFragmentDef, []); const orm = fragment.services.orm; \`\`\`

### @fragno-test

Runnable test code with optional IDs:

\`\`\`typescript @fragno-test:create-user // should create a single user const userId = await
orm.create("users", { id: "user-123", email: "john@example.com", });

expect(userId).toBeDefined(); \`\`\`

- Optional ID syntax (`:create-user`) helps agents reference specific examples
- First comment line becomes the test name
- IDs are optional - tests generate properly without them

Between code blocks, add markdown explanations.

## Adding Subjects

1. Create `src/subjects/your-subject.md`
2. Add `@fragno-imports` block at top
3. Add optional `@fragno-prelude` for user-visible setup code
4. Add optional `@fragno-test-init` for test-only initialization
5. Add multiple `@fragno-test` blocks with examples (optional IDs)
6. Write explanations between code blocks
7. Update `src/subject-tree.ts` to add subject to the tree structure
8. Run `pnpm test` to validate

## Testing

Tests use vitest `globalSetup` to:

1. Parse all markdown files
2. Extract `@fragno-prelude` (user-visible setup), `@fragno-test-init` (test-only), and
   `@fragno-test` blocks
3. Generate temporary `.test.ts` files with actual vitest test cases
4. Type-check and execute them

Each subject's test file includes:

- Imports from `@fragno-imports`
- Setup from `@fragno-prelude` (shown to users)
- Initialization from `@fragno-test-init` (test-only)
- Test cases from `@fragno-test` blocks

Test names come from the first comment line in each `@fragno-test` block.

Run tests: `pnpm test`

Generated tests are in `corpus-tests/` (temporary directory).

## CLI Integration

The corpus can be viewed via the Fragno CLI with various options:

```bash
# View a subject
fragno-cli corpus database-querying

# Show only headings and code block IDs with line numbers
fragno-cli corpus --headings database-querying

# Show specific line range with line numbers
fragno-cli corpus --line-numbers --start 1 --end 50 database-querying

# Multiple subjects (automatically ordered by subject tree)
fragno-cli corpus database-adapters kysely-adapter
```

## TODO: Future Subjects

- [ ] **databases**: Database adapters for different databases: PGLite, SQLite, etc.
- [ ] **dependencies**: Using `withDependencies` in fragments
- [ ] **services**: Defining and using services in fragments
- [ ] **client-state**: Client-side state management with hooks
- [ ] **database-schemas**: Defining database schemas with versioning
- [ ] **integration-nextjs**: Integrating fragments into Next.js
- [ ] **integration-nuxt**: Integrating fragments into Nuxt
- [ ] **integration-svelte**: Integrating fragments into SvelteKit
- [ ] **integration-astro**: Integrating fragments into Astro
- [ ] **integration-react-router**: Integrating fragments into React Router
