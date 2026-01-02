# Blog post checklist (Step 2)

Distilled from: `/Users/wilco/Downloads/Technical Blog Post Writing Guide.md`

Use this after completing **Step 1** (the interview). This is the “pre-flight checklist” for turning
answers into a publishable post.

## Phase 1 — Preparation & scope

- [ ] **Persona defined**: I can describe the target reader in one sentence.
- [ ] **Prerequisites listed**: OS/tools/framework assumptions are explicit.
- [ ] **Problem statement**: The first 1–2 paragraphs say what problem we’re solving and why it
      matters.
- [ ] **Anti-scope**: I explicitly state what’s out of scope.
- [ ] **One takeaway**: I can point to a single sentence that captures the main lesson.
- [ ] **Worked example chosen**: One scenario/example carries through the post.
- [ ] **Terms planned**: Acronyms/jargon to “define on first use” are listed.

## Phase 2 — Structure & narrative

- [ ] **Right post shape**: Tutorial (procedural) _or_ deep dive (problem → solution → trade-offs).
- [ ] **F-pattern optimized**: The most important info appears early (top 10–20% of the page).
- [ ] **Heading hierarchy**: H2/H3 structure is logical and scannable.
- [ ] **Headings are sentence case**.
- [ ] **Chunking**: Long ideas are segmented; paragraphs are short (avoid walls of text).
- [ ] **Transitions**: Each section explains why we’re moving to the next.
- [ ] **Trade-offs included**: I show rejected options / constraints, not just “the final answer.”

## Phase 3 — Language & style (clarity engineering)

- [ ] **Second person for instructions**: Use “you” when guiding.
- [ ] **Active voice dominant**.
- [ ] **Present tense** for system behavior (avoid “will” where possible).
- [ ] **No minimizers**: Removed “simple”, “easy”, “just”, “obviously”, “basically”.
- [ ] **Sentence length**: Most sentences are under ~25 words.
- [ ] **One idea per sentence** (especially near code).
- [ ] **Consistent terminology**: One name per concept/UI element throughout.
- [ ] **Inclusive language**: Prefer allowlist/blocklist, primary/replica, etc.

## Phase 4 — Code & examples (trustworthiness)

- [ ] **Code blocks are hygienic**: No irrelevant boilerplate; only what supports the point.
- [ ] **Snippets are runnable** (or clearly labeled as partial/pseudocode).
- [ ] **Every snippet has context**: Explain _why_ before it appears, and _what happened_ after.
- [ ] **Syntax highlighting**: Code fences specify a language.
- [ ] **Names are cognitive anchors**: Variables/types are meaningful (avoid `x`, `data1`).
- [ ] **Copy/paste path**: Readers can see what to change (placeholders called out clearly).

## Phase 5 — Visuals & accessibility (reduce cognitive load)

- [ ] **A diagram exists** when explaining relationships/architecture/flow.
- [ ] **Diagrams are maintainable** where possible (diagrams-as-code mindset).
- [ ] **Alt text for every image/diagram**: Describes the information, not “a screenshot of…”.
- [ ] **Link text is descriptive** (avoid “click here”).
- [ ] **Contrast/readability**: Code screenshots/themes are legible.

## Phase 6 — Tutorial-specific checks (only if it’s procedural)

- [ ] **Prerequisite contract** at the top (versions/access/knowledge).
- [ ] **Steps are numbered** and each step has:
  - [ ] **Why** (context)
  - [ ] **Action** (command/code)
  - [ ] **What you should see** (verification/expected output)
  - [ ] **Recovery** (common error + fix) where likely

## Phase 7 — Verification & review (docs-as-code mindset)

- [ ] **Reproducibility**: I ran the code in a clean environment (or validated the flow end-to-end).
- [ ] **Technical review**: A knowledgeable reviewer checked correctness/security/edge cases.
- [ ] **Editorial review**: Someone checked clarity, flow, and tone.
- [ ] **Prose lint** (optional but recommended): Run a style linter (e.g. Vale) or equivalent
      checks.
- [ ] **Readability sanity check**: Skim for friction points; simplify where readers will
      context-switch.

## Phase 8 — Shipping (promotion without “being an ad”)

- [ ] **Idea-first framing**: The post teaches a concept that stands alone, even without Fragno.
- [ ] **Fragno tie-in is concrete**: One or two small snippets/figures show how Fragno embodies the
      idea.
- [ ] **Clear CTA**: One next step (docs / quickstart / repo) and one feedback question.
- [ ] **Title + description match reality**: No bait; expectations are accurate.
