---
name: fragno-spec
description:
  Create or update Fragno specs in `specs/` using the repo spec process and FP issue planning
  workflow. Use when asked to draft a spec, define a feature, or structure implementation work as FP
  issues instead of separate implementation plan documents.
---

# Fragno Spec

## Overview

Create living spec documents in `specs/` and structure the implementation plan as FP issues. Make
sure all FP issues are clearly link to a paragraph in the spec.

## Workflow

1. Read the specs reference for process, requirements, and example outline.
2. Review existing specs for patterns.
3. Gather context from code/docs; collect external references into `specs/references/` and cite them
   in the spec.
4. Do deep research on the current code base. Use internet search tool if needed.
5. Draft and iterate the spec with the user:
   - List open questions at the top and number them for easy responses.
   - Capture concrete interfaces, schemas, routes, naming conventions, and examples.
   - Align with existing code and documentation.
6. Create the plan as FP issues using the FP planning reference.

## References

(These paths are relative to this SKILL file)

- **Specs**: Read `references/specs.md` for spec requirements and process.
- **FP planning**: Read `references/fp.md` for the FP planning workflow.
