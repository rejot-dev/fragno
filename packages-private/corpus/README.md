# @fragno-private/corpus

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
import { getSubjects, getSubject, getAllSubjects } from "@fragno-private/corpus";

// List available subjects
const subjects = getSubjects();
// [{ id: "defining-routes", title: "Defining Routes" }, ...]

// Get one or more subjects
const [routes] = getSubject("defining-routes");
// { id, title, description, imports, init, examples }

// Get multiple subjects for combined context
const [adapters, kysely] = getSubject("database-adapters", "kysely-adapter");
```

## Markdown Format

Each subject is a markdown file in `src/subjects/` using code fence directives:

### @fragno-imports

Required block at the top with all imports:

\`\`\`typescript @fragno-imports import { defineRoute } from "@fragno-dev/core"; import { z } from
"zod"; \`\`\`

### @fragno-init (optional)

Initialization code needed for examples:

\`\`\`typescript @fragno-init const config = { apiKey: "test-key" }; \`\`\`

### @fragno-test:route or @fragno-test:database

Runnable test code with type annotations:

\`\`\`typescript @fragno-test:route // test name from first comment line const route = defineRoute({
method: "GET", path: "/hello", outputSchema: z.string(), handler: async (\_, { json }) =>
json("Hello"), });

expect(route.method).toBe("GET"); \`\`\`

- Use `@fragno-test:route` for route tests (uses `@fragno-dev/core/test`)
- Use `@fragno-test:database` for database tests (uses `@fragno-dev/test`)
- Omit `:route` or `:database` for documentation-only examples (no test generation)
- First comment line becomes the test name

Between code blocks, add markdown explanations.

## Adding Subjects

1. Create `src/subjects/your-subject.md`
2. Add `@fragno-imports` block at top
3. Add optional `@fragno-init` if needed
4. Add multiple `@fragno-test` blocks with examples
5. Write explanations between code blocks
6. Run `pnpm test` to validate

## Testing

Tests use vitest `globalSetup` to:

1. Parse all markdown files
2. Extract `@fragno-test:route` and `@fragno-test:database` blocks
3. Generate temporary `.test.ts` files with actual vitest test cases
4. Type-check and execute them

Each test block becomes a `describe()` suite with `it()` test cases. Test names come from the first
comment line in each block.

Run tests: `pnpm test`

Generated tests are in `.corpus-tests/` (temporary directory).

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
