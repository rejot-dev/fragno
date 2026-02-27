# Fragno DB Query Policies — Spec

## 0. Open Questions

None.

## 1. Overview

This spec introduces a **generic query policy pipeline** for `@fragno-dev/db` so Unit of Work (UOW)
operations can be augmented with additional filters and write-time injections beyond shard
filtering. The goal is to make UOW query adjustment extensible for use cases such as:

- Row-level permissions (org/user scoping)
- Soft-delete filters
- Default value injection on create (e.g. `orgId`, `createdBy`)

The policy API follows the existing **UOW pattern** by exposing a `forSchema(...)` helper that
returns a typed builder for producing table-scoped conditions.

Sharding remains supported and is implemented as an **internal policy** that preserves current
behavior.

## 2. References

- Sharding spec (existing behavior to preserve): `specs/spec-db-sharding.md`
- UOW core + types: `packages/fragno-db/src/query/unit-of-work/unit-of-work.ts`
- UOW execution context (forSchema pattern):
  `packages/fragno-db/src/query/unit-of-work/execute-unit-of-work.ts`
- SQL compiler (current shard filtering):
  `packages/fragno-db/src/adapters/generic-sql/query/generic-sql-uow-operation-compiler.ts`
- In-memory UOW (current shard filtering):
  `packages/fragno-db/src/adapters/in-memory/in-memory-uow.ts`
- Adapter UOW config + merge behavior:
  `packages/fragno-db/src/adapters/shared/from-unit-of-work-compiler.ts`
- DB fragment wiring + shard context helpers:
  `packages/fragno-db/src/db-fragment-definition-builder.ts`
- Sharding types/helpers: `packages/fragno-db/src/sharding.ts`

## 3. Terminology

- **Query policy**: A declarative hook that can inject extra filters and write-time adjustments into
  UOW operations.
- **Policy context**: Data provided to policies (request/user context, operation metadata).
- **Policy condition**: A `Condition` produced by a policy and AND-ed into the query.
- **Policy schema context**: A typed helper obtained via `forSchema(...)` for building conditions on
  a specific schema.

## 4. Goals / Non-goals

### 4.1 Goals

1. Provide a **generic policy pipeline** for UOW operations.
2. Support **extra WHERE filters** on reads and mutations (permissions, soft-delete).
3. Support **join filtering** for `find` operations with joins.
4. Support **write-time injection** on `create` (e.g., `_shard`, `orgId`).
5. Expose a **typed `forSchema(...)` helper** for policy builders, following the existing UOW
   context pattern.
6. Rework **sharding** to use the policy pipeline (replacing existing shard-specific paths);
   breaking changes are explicitly acceptable for this migration.

### 4.2 Non-goals

- Schema-level row policies attached directly to table definitions (explicitly out of scope).
- Client-side policy enforcement or routing changes.
- Cross-fragment permissions or auth framework integration (policy context is caller-provided).

## 5. API Design

### 5.1 Policy Types

```ts
export type QueryPolicyOperation = "find" | "count" | "create" | "update" | "delete" | "check";

export type QueryPolicyContext<TCtx> = {
  ctx: TCtx;
  opType: QueryPolicyOperation;
  schema: AnySchema;
  namespace?: string | null;
  table: AnyTable;
  forSchema: <S extends AnySchema>(schema: S) => QueryPolicySchemaContext<S>;
};

export type QueryPolicySchemaContext<S extends AnySchema> = {
  schema: S;
  table: <TName extends keyof S["tables"] & string>(name: TName) => S["tables"][TName];
  where: <TName extends keyof S["tables"] & string>(
    table: TName,
    builder: (eb: IndexedConditionBuilder<S["tables"][TName]>) => Condition | boolean,
  ) => Condition | null;
};

export type QueryPolicy<TCtx = unknown> = {
  name: string;
  appliesTo?: (ctx: QueryPolicyContext<TCtx>) => boolean;
  assertContext?: (ctx: QueryPolicyContext<TCtx>) => void;
  mutateCreate?: (
    ctx: QueryPolicyContext<TCtx>,
    values: Record<string, unknown>,
  ) => Record<string, unknown>;
  extraWhere?: (ctx: QueryPolicyContext<TCtx>) => Condition | null;
  extraJoinWhere?: (ctx: QueryPolicyContext<TCtx>) => Condition | null;
};

export type QueryPolicyEntry<TCtx = unknown> = {
  policy: QueryPolicy<TCtx>;
  getContext: () => TCtx;
};
```

Notes:

- `forSchema(...)` mirrors the existing UOW context pattern in `execute-unit-of-work.ts`.
- `QueryPolicySchemaContext.where(...)` uses `IndexedConditionBuilder` to keep policy filters
  index-friendly. If a builder resolves to `true`, it returns `null` (no-op). If it resolves to
  `false`, it throws with a clear error (policies must use `assertContext` to deny access).
- `extraJoinWhere` receives the same `table` as `extraWhere`, but it is invoked for each joined
  table in a `find` op.

### 5.2 UnitOfWorkConfig Additions

```ts
export interface UnitOfWorkConfig {
  // existing fields...
  queryPolicies?: QueryPolicyEntry[];
}
```

Merge behavior:

- Adapter-level `uowConfig.queryPolicies` and UOW-level `createUnitOfWork(..., config)` policies are
  **concatenated** (adapter policies first).
- Each `QueryPolicyEntry` provides its own `getContext()` initializer.
- **Breaking change**: `shardingStrategy`, `getShard`, and `getShardScope` are removed from
  `UnitOfWorkConfig`. Shard behavior is configured by registering the built-in shard policy with its
  own inputs (see §7).

## 6. Execution Model

### 6.1 Policy Evaluation

When a UOW operation is added:

1. For each policy entry, resolve policy context via `entry.getContext()`.
2. Build a `QueryPolicyContext` object with `opType`, `schema`, `namespace`, and `table`.
3. For each policy (in order):
   - Skip if `appliesTo` returns `false`.
   - Call `assertContext` (may throw).
   - If `opType === "create"`, call `mutateCreate` and use the returned values.
   - For all operations, call `extraWhere` and merge the resulting condition with existing filters
     using AND.

For `find` operations with joins, `extraJoinWhere` is applied to each join target table and merged
into the join’s `where` condition before compilation.

### 6.2 Condition Merging

- Policy conditions are merged with user conditions and cursor filters using AND.
- A `null` policy condition is a no-op.
- Policy builders that resolve to `false` **throw** (use `assertContext` to deny instead).

## 7. Sharding as a Built-in Policy

Sharding is re-implemented as a built-in policy to validate the pipeline and avoid special-case
compiler logic. It no longer reads `shardingStrategy`, `getShard`, or `getShardScope` from
`UnitOfWorkConfig` (those fields are removed). Instead, adapter/fragment wiring registers the shard
policy explicitly and provides the shard inputs directly. Semantics remain the same:

- Adapter mode requires a shard unless scope is `global`.
- `_shard` is injected on create, and explicit `_shard` writes are rejected.
- Shard filtering is applied to read, update, delete, and check operations in row mode.
- `fragno_db_settings` remains exempt.

This policy replaces the current shard-specific filtering paths in:

- `packages/fragno-db/src/query/unit-of-work/unit-of-work.ts`
- `packages/fragno-db/src/adapters/generic-sql/query/generic-sql-uow-operation-compiler.ts`
- `packages/fragno-db/src/adapters/in-memory/in-memory-uow.ts`

## 8. Adapter / Compiler Updates

### 8.1 UnitOfWork

- Add policy plumbing to `UnitOfWorkConfig`.
- Build and cache merged `queryPolicies` for each UOW.
- Apply `mutateCreate` and `extraWhere` during `addMutationOperation` / `addRetrievalOperation`.
- Apply `extraJoinWhere` to compiled joins before storing the operation.

### 8.2 Generic SQL Compiler

- Merge `op.policyWhere` into the existing `combinedWhere` for `find`/`count`.
- Merge `op.policyWhere` into mutation conditions (`update`, `delete`, `check`).
- Remove shard-specific filtering logic once shard policy is in place.

### 8.3 In-memory UOW

- Merge `op.policyWhere` into all find/count conditions.
- For update/delete/check, validate row matches using the merged condition (replacing shard-specific
  checks).
- Ensure join filters apply via merged join `where` conditions.

## 9. Example Usage

### 9.1 Permissions Policy (org-scoped)

```ts
type PolicyContext = { orgId: string };

export const orgPermissionsPolicy: QueryPolicy<PolicyContext> = {
  name: "org-permissions",
  extraWhere: ({ ctx, table, forSchema, schema }) => {
    const s = forSchema(schema as typeof appSchema);
    if (table !== s.table("projects")) return null;
    return s.where("projects", (eb) => eb("orgId", "=", ctx.orgId));
  },
};
```

### 9.2 Soft-delete Policy

```ts
export const softDeletePolicy: QueryPolicy = {
  name: "soft-delete",
  extraWhere: ({ table, forSchema, schema }) => {
    const s = forSchema(schema as typeof appSchema);
    if (!("deletedAt" in table.columns)) return null;
    return s.where(table.name as "projects", (eb) => eb("deletedAt", "is", null));
  },
};
```

### 9.3 Adapter Configuration

```ts
const adapter = new SqlAdapter({
  dialect,
  driverConfig,
  uowConfig: {
    getQueryPolicyContext: () => ({ orgId: currentOrgId }),
    queryPolicies: [orgPermissionsPolicy, softDeletePolicy],
  },
});
```

## 10. Testing

- Unit tests for policy plumbing in `UnitOfWork`:
  - `extraWhere` is merged for read/mutation ops.
  - `mutateCreate` injects values and rejects overrides.
  - `forSchema(...).where(...)` provides typed columns and rejects `false`.
- SQL compiler tests ensuring policy conditions appear in compiled SQL.
- In-memory adapter tests ensuring policy filters apply to retrieval, joins, and mutations.
- Regression tests for sharding behavior using the built-in policy.

## 11. Documentation Updates

None (internal API). If we later expose a public policy API, add docs under `apps/docs`.

## 12. Decisions (Locked)

- Policies run at UOW operation creation time and are applied to both retrieval and mutation paths.
- `forSchema(...)` in policy contexts follows the UOW context pattern from
  `execute-unit-of-work.ts`.
- Sharding is re-implemented as a built-in policy to validate and exercise the generic pipeline.
- Schema-level row policies are explicitly out of scope.
