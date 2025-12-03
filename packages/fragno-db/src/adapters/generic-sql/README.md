# Generic SQL Adapter

## Goals:

- Follow roughly the Kysely interfaces so that we can use Kysely adapters.
- Use this to replace ALL query execution logic.
- "Own" the result transformation step.
- Optionally able to create SQL migrations internally.
- Be able to map names (tables, columns, constraints, etc)
- Be able to run migrations directly from the Fragment

## Non-goal:

- Generate schemas in ORM-specific DSLs, this is left to the ORM adapters.
