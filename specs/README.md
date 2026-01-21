# Specs

## Contents

- [Process Overview](#process-overview)
- [Spec Requirements](#spec-requirements)
- [Implementation Plan Requirements](#implementation-plan-requirements)
- [Reference Handling](#reference-handling)
- [Specifications](#specifications)
- [Implementation Plans](#implementation-plans)
- [Implementation Plans (Finished)](#implementation-plans-finished)

This repo uses specs and implementation plans to define and build features. The goal is to produce
very detailed, living documents that guide implementation without constraining the order of work.

## Process Overview

1. Read repo `README.md` and `CLAUDE.md` first to understand the project and its conventions.
2. Review existing specs for patterns and language; use `specs/workflows-fragment-spec.md` as the
   quality bar.
3. Review other specs to understand adjacent domains and prior decisions.
4. Review current project code and documentation for context.
5. Collaborate with the user iteratively to refine the spec. Ask questions to close gaps.
6. When the user references outside code or docs, collect those references and add them to
   `specs/references/`.
7. Produce the spec and the implementation plan together; they are a matched pair.

## Spec Requirements

- A spec is a living document: no versions, no "draft" stamps.
- Decisions are locked as long as they are part of the spec.
- If open questions exist, list them at the top of the spec. Keep interviewing the user until they
  are resolved.
- When asking questions, always number them for easy responses.
- Specs are detailed and concrete and can include (not limited to) any relevant material:
  - Interfaces and types
  - Database schemas and migrations
  - Naming conventions
  - HTTP routes and payloads
  - Example snippets
- Be mindful of existing code and documentation in this repo. Prefer aligning with current
  conventions.
- References can point to this repo, other local repos, or external sources. Capture outside
  references into `specs/references/` and cite them in the spec.

## Implementation Plan Requirements

- Every spec must have a corresponding implementation plan.
- The plan is a list of tasks required to implement the spec.
- Tasks must refer back to the spec.
- No phases. Do not group tasks into phases or impose an ordering.
- Tasks should be as independent as possible. If a dependency exists, explicitly note it.
- The plan describes what needs to be done, not the order it must be done in.
- Tasks must be concrete implementation work. No research, discovery, or vague items.
- Tasks use checkboxes for status and start unchecked: `[ ]`.

## Reference Handling

- If the user references code or documentation during spec writing, obtain the source and store it
  in `specs/references/` (even when the source lives in this repo or another local repo).
- References can be from external URLs, this repo, or other local repos on this system. Capture a
  snapshot and cite the original source path or URL.
- Keep references scoped to what the spec needs; do not bulk-copy unrelated material.

## Specifications

- [Fragno Workflows Fragment — Spec](./workflows-fragment-spec.md) — End-to-end workflows fragment
  design: public API shape, database schema and indexes, lifecycle semantics
  (run/replay/wait/sleep), runner/tick behavior, durable hooks wiring, HTTP routes, and
  CLI/management surface.
- [Fragno Prisma Support — Prisma Schema Generator Adapter — Spec](./prisma-adapter-spec.md) —
  Prisma integration spec covering schema generation rules, adapter responsibilities, naming
  conventions, provider-specific type mappings, migration expectations, and runtime serialization
  constraints.
- [Fragno AI Fragment — Spec](./ai-fragment-spec.md) — AI fragment architecture and contract:
  thread/message/run models, NDJSON streaming semantics, persistence guarantees, webhook handling,
  runner execution behavior, config surface, and client hooks.

## Implementation Plans

- [AI Fragment — Implementation Plan](./ai-fragment-implementation-plan.md)

## Implementation Plans (Finished)

- [Workflows Fragment — Implementation Plan (Complete)](./implementation-plans/finished/workflows-fragment-implementation-plan.md)
- [Prisma Adapter — Implementation Plan (Complete)](./implementation-plans/finished/prisma-adapter-implementation-plan.md)
