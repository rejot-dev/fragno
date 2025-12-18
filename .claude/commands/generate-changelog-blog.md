### Generate Changelog Blog Post

Use the `gh` and `git` CLI to read a changeset PR and generate a blog post about the release.

## Steps

1. Read the specified changeset PR using `gh pr view [NUMBER] --json title,body,number,author` to
   get the changelog information
1. Identify the most relevant packages (core, db, cli) and their major changes from the PR body
1. For commits with hashes mentioned in the changelog, use `git show [HASH]` to understand what
   changed
1. Deeply research the changes and understand the rationale behind them
1. Generate a blog post draft to `apps/docs/content/blog/<YYYY-MM-DD>-changelog.mdx` with:
   - Concise "What is Fragno?" intro at the top for new readers (2 sentences, not a pitch)
   - Focus on the most interesting features first
   - Include practical code examples where relevant (prefer real examples from the repo)
   - Include links to relevant source files when referencing concrete implementations
   - Explain why users should care about each change (problem → change → outcome)
   - Note any breaking changes or migration steps
   - Mention new packages/fragments if relevant
1. Generate a short image prompt for a future blog header image:
   - It must match Fragno's existing blog illustration style: flat vector, thick black outlines,
     minimal shading, soft gray drop shadows, lots of whitespace, and a playful "systems diagram"
     vibe (simple shapes connected by arrows/lines)
   - Use a 3-color palette: pink/red `#ff5a66`, yellow `#ffcc00`, and blue `#4da3ff`
   - DO NOT add this prompt to the draft, instead return it directly to the user
1. Present ONLY a link to the blog post file - no additional commentary
1. Take into account the user's feedback and keep iterating until satisfied

## Content Guidelines:

### Structure

- **Title**: Descriptive, feature-focused (don't include version numbers for pre-1.0)
- **Title style**: Use "Fragno Changelog: …" when appropriate for clarity in feeds
- **What is Fragno?**: Brief 2-sentence intro at the very top for new readers
- **Main sections**: Organize by feature importance, not by package
- **Code examples**: Include real examples from the codebase when possible
- **Links to code**: Link to the relevant implementation when it helps readers follow along
- **Conclusion**: Short "Learn more" with relevant docs links

### Writing Style

- **Match existing blog tone**: Similar voice to `apps/docs/content/blog/split-brain-stripe.mdx` and
  `apps/docs/content/blog/fragno-introduction.mdx`
- **Concise but not boring**: Get to the point, then explain why
- **Grounded**: Avoid marketing superlatives and generic hype
- **No obvious AI voice**: Avoid filler, repetition, and "announce-y" phrasing
- **No em dashes**: Rewrite sentences instead of using `—`
- **Spelling and grammar**: Do a final pass before presenting
- **Accuracy**: Do not invent API names or callback signatures; confirm usage in the repo
- **Practical examples**: Show real code usage from the repository
- **No version numbers**: Since pre-1.0, version numbers aren't that interesting

### What to Cover

- **Major features**: Highlight the biggest changes with examples and rationale
- **Developer experience improvements**: CLI changes, migration helpers, etc.
- **Bug fixes**: Important fixes that affect user experience
- **New packages**: Mention new fragments or utilities if relevant
- **Breaking changes**: Note any API changes users need to know about

### What to Merge/Remove

- **Combine related changes**: Group similar improvements into single sections
- **Skip internal changes**: Omit refactors that don't affect users (unless architecturally
  significant)
- **Merge small fixes**: Don't list every minor fix separately

### Code Examples Best Practices

- Use real code from the repository when available (check example-fragments/, example-apps/, etc.)
- Show before/after for API changes
- Include enough context to understand the feature
- Format consistently with proper syntax highlighting
- Prefer examples that are already used in production in this repo (dogfooding), and link to them
- If a feature is adapted from another project, add a short attribution footnote when appropriate

## File Naming

- Use format: `YYYY-MM-DD-changelog.mdx`
- Example: `2025-12-18-changelog.mdx`

## Frontmatter Template

```yaml
---
title: "[Feature-Focused Title]"
description: "[Brief description of the release highlights]"
date: "YYYY-MM-DD"
author: "Wilco Kruijer"
---
```

## Rules:

- Present the blog post in a file, show only the file path as a link
- Do NOT add any commentary or explanation when presenting the draft
- Keep iterating based on feedback until approved
- Use line length of 100
- Include practical code examples where they add value
- Focus on the "why" not just the "what"

## Image Prompt Guidelines

Write a single prompt that can be used later to generate the header image.

- **Style**: flat vector illustration with thick black outlines, white background, subtle gray drop
  shadows, limited bright palette, and a clean "explainer diagram" look. Keep shapes simple, add a
  little depth via light shading only (no gradients-heavy rendering).
- **Palette**: primarily pink/red `#ff5a66`, yellow `#ffcc00`, and blue `#4da3ff`, with black
  outlines and light gray shadows
- **Subject**: visually communicate the main release theme (durable hooks, transactions/commit,
  retries, Cloudflare edge, database layers)
- **Composition**: centered illustration with generous whitespace for blog layout
- **Text**: no embedded text in the image
