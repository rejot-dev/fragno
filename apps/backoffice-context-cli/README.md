# Backoffice context CLI

The Backoffice context CLI explains how files in `apps/backoffice/content/static/` can enter an
agent's context. It generates a Markdown call graph rooted at the automatically injected `SYSTEM.md`
and every discoverable `SKILL.md`.

The graph shows:

- references to `/static/...` files and relative Markdown links;
- `__BACKOFFICE_CODEMODE_DTS__` expanded through `/static/codemode/system.d.ts`;
- each skill's frontmatter description, which tells the agent when to load it;
- recursive follow-up reads, cycles, repeated expansions, and missing targets;
- files that are not reachable from `SYSTEM.md` or any skill.

## Generate the checked-in graph

From the repository root, run:

```bash
pnpm backoffice:context
```

This writes and formats `content/CONTEXT-GRAPH.md`. The generator loads the repository's
`.oxfmtrc.json`, so the checked-in document uses the same Markdown formatting as the rest of the
repository.

## Check that the graph is current

Check the working-tree file against freshly generated and formatted content:

```bash
pnpm backoffice:context:check
```

The Lefthook pre-commit pipeline performs the stronger staged-file check:

```bash
pnpm backoffice:context:check-staged
```

The staged check requires both the working-tree and index copies of `content/CONTEXT-GRAPH.md` to
match the generated content. A generated but unstaged graph therefore cannot pass pre-commit.
Regenerate and stage the file when either check fails:

```bash
pnpm backoffice:context
git add content/CONTEXT-GRAPH.md
```

Lefthook runs the staged check after updating generated codemode declarations, so changes to static
guidance, skills, or provider declarations cannot silently leave the committed graph stale.

## Print a graph without updating the checked-in file

Run the package CLI directly:

```bash
pnpm --filter @fragno-private/backoffice-context-cli backoffice-context
```

Pass another static content directory to inspect it instead:

```bash
pnpm --filter @fragno-private/backoffice-context-cli backoffice-context \
  ./path/to/content/static
```

The CLI writes Markdown to standard output. Redirect it when an ad hoc file is useful:

```bash
pnpm --filter @fragno-private/backoffice-context-cli backoffice-context > context-graph.md
```

## Parsing rules

The scanner reads every file recursively as UTF-8 and assigns it a `/static/...` path. It finds
references textually rather than parsing Markdown or TypeScript syntax trees.

- Absolute `/static/...` file paths are recognized in every file type.
- Inline relative Markdown links are resolved relative to their containing `.md` file.
- Every `/SKILL.md` must contain string `name` and `description` YAML frontmatter fields.
- Markdown summaries use the first level-one heading.
- TypeScript declaration summaries use the first non-triple-slash line comment.
- `SYSTEM.md` receives a synthetic expansion edge to `/static/codemode/system.d.ts` when it contains
  `__BACKOFFICE_CODEMODE_DTS__`.

Bare relative paths, reference-style Markdown links, glob paths, and instructions without a concrete
file path do not create graph edges.

## Development

Run the package checks with:

```bash
pnpm --filter @fragno-private/backoffice-context-cli run lint:package
pnpm --filter @fragno-private/backoffice-context-cli run types:check
pnpm --filter @fragno-private/backoffice-context-cli test
```
