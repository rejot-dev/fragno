# Create or Update Corpus

Create or update code examples and documentation for Fragno, for a specific subject. Subjects go
into the `packages/corpus/src/subjects` directory.

## What is Corpus?

Corpus is a collection of working code examples organized into subjects like "defining routes" or
"database querying". All examples are:

- **Tested**: Code runs through vitest with type checking
- **Documented**: Each example includes explanations
- **Portable**: Can be consumed by CLI, docs, or other tools

## Steps

1. Determine the subject the user wants to create or update a Corpus entry for.
1. Read `src/subject-tree.ts` to get the tree structure of the Corpus.
1. In the Corpus directory (`packages/corpus/src/subjects`), look for pre-existing files to figure
   out if you need tou update or create a new file.
1. Search in the contents of the files and read the content.
1. Determine the file and position in the tree.
1. Create a new file for the subject if it doesn't exist. exist.
1. Add code blocks with directives: `@fragno-imports`, `@fragno-prelude`, `@fragno-test-init`, and
   `@fragno-test`. (See below for more details)
1. Write explanations between code blocks.
1. Update `src/subject-tree.ts` to add subject to the tree structure.
1. Run `pnpm test` to validate.

## Rules

- Corpus subjects and entries are additive. Nothing should be duplicated, every example should add
  something new to help aid in the understanding of the subject for humans and LLMs
- Every entry should pass type checking and run without errors, after Fragno directives have been
  taken into account.
- Give each code block an ID using the ID syntax.
- The distinction between subjects for Fragment (library) authors and users is VERY important.
- ONLY give the recommended approach, don't offer legacy or alternative approaches.
- Be VERY concise and to the point in everything you write.
- Merge sections in subjects when appropriate.

## How users will use the Corpus

Users generally run `fragno-cli corpus` to view available topics in tree structure. Then they can
run `fragno-cli corpus --headings <subject-1> <subject-2> <subject-N>` to view the headings and code
block IDs for these subjects. Lastly they will zoom in on specific subjects they want to learn more
about.

LLMs use the Corpus in the same way.

## Corpus file Markdown format

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
