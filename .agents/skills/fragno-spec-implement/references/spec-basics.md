# Spec Basics (Fragno)

## Key Principles

- Specs are living documents: no versions, no "draft" stamps.
- Decisions are locked once captured in the spec.
- Open questions live at the top and are numbered.
- Specs are concrete: include types, schemas, routes, naming, and examples.
- Prefer live code paths/URLs for references; avoid frozen snapshots.

## Finding the Spec

- Use `specs/INDEX.md` to locate the relevant spec file.
- Read the spec before starting implementation work.
- If external references are needed, add them under `specs/references/` and cite them in the spec.

## Using the Spec During Implementation

- Treat the spec as the single source of truth for scope and acceptance criteria.
- If implementation uncovers gaps or new decisions, update the spec first, then proceed.
- Keep changes aligned with existing repo conventions described in `AGENTS.md`.
