# Specs (Fragno)

## Contents

- [Process Overview](#process-overview)
- [Spec Requirements](#spec-requirements)
- [Example Outline](#example-outline)
- [Reference Handling](#reference-handling)

## Process Overview

1. Read `AGENTS.md` to understand project conventions.
2. Review existing specs for patterns and language; use the example outline below as a baseline.
3. Review other specs to understand adjacent domains and prior decisions.
4. Review current project code and documentation for context and alignment.
5. Collaborate with the user iteratively to refine the spec. Ask questions to close gaps.
6. When the user references outside code or docs, collect those references and add them to
   `specs/references/`.
7. Produce the spec and the FP issue plan together; FP issues replace separate implementation plan
   files (see FP planning reference).

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
- References can point to this repo, other local repos, or external sources. Capture outside
  references into `specs/references/` and cite them in the spec.

## Example Outline

Adapt this outline to the feature’s scope and complexity:

- Open Questions (numbered)
- Overview
- References
- Terminology
- Goals / Non-goals
- Packages / Components (if relevant)
- User-facing API (types, routes, hooks, contracts)
- Responsibilities (fragment vs host app)
- Data Model (tables, indexes, migrations)
- Execution Model / Lifecycle
- Integrations (adapters, hooks, background runners)
- HTTP API (routes, payloads, status codes)
- Security / Authorization
- Limits & Validation
- Operational concerns (GC, observability, testability)
- Upgrade / Compatibility (if needed)
- Decisions (locked)
- Documentation updates

## Reference Handling

- Specs should reference **live code paths** or external URLs directly.
- Do not copy code into `specs/references/`; avoid frozen snapshots.
- Keep references scoped to what the spec needs; do not bulk-copy unrelated material.
