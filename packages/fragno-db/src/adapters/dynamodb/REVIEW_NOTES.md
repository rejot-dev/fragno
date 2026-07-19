# DynamoDB Adapter Review Notes

This document captures snapshot-review findings for `packages/fragno-db/src/adapters/dynamodb/`,
possible fixes, structural improvements, and test-suite additions that would help future adapter
implementations catch the same classes of bugs.

## Implementation status

The immediate DynamoDB fixes have been implemented in this worktree:

- leading equality predicates are pushed into DynamoDB `QueryCommand` sort-key conditions;
- `BatchGetCommand` unprocessed keys are retried before rows are returned;
- migrations wait for created/existing tables to become `ACTIVE`;
- unique-index backfill uses conditional writes and fails on duplicate existing data;
- adapter `namingStrategy` is passed into UOW compilation;
- DynamoDB cursors include an internal external-id tiebreaker for duplicate non-unique index values.

The broader structural split and shared query-engine contract tests below remain recommendations for
follow-up work, especially if the same cursor/keyset guarantees are extended across all adapters.

## 1. Equality-index reads still scan the whole index partition

**Location:** `dynamodb-uow-executor.ts` (`#queryRowsByIndex`, `#assertQuerySupported`)

### Problem

`#assertQuerySupported` allows queries when the condition contains equality on the leading index
column, but `#queryRowsByIndex` sends only:

```ts
KeyConditionExpression: "#pk = :pk";
```

The actual condition is evaluated client-side after loading index entries and fetching base rows.
This means a query that looks selective at the Fragno API layer can still read an arbitrary number
of DynamoDB index pages before finding matches. In production, a valid query such as `status = "z"`
can fail with `DynamoDBReadLimitError` if enough earlier `status` values exist.

### Potential solutions

- Extract the leading equality condition from the query condition tree and encode it with
  `encodeDynamoDBIndexTuple`.
- Use the encoded equality prefix in DynamoDB's key condition, for example
  `begins_with(#sk, :skPrefix)` for composite indexes.
- For full equality across all indexed columns, use an exact sort-key lookup/range where possible.
- Keep residual predicates client-side only for conditions DynamoDB cannot express, but make the
  leading equality restriction part of the DynamoDB `QueryCommand`.
- Consider separating query planning into:
  - `keyCondition`: DynamoDB-native key predicate.
  - `residualPredicate`: local post-filter.
  - `readSafety`: whether the query requires bounded scan permission.

### Structural change

Introduce a small DynamoDB query planner module, e.g. `dynamodb-query-planner.ts`, that converts a
Fragno `Condition` plus index metadata into a DynamoDB key-condition plan. This would avoid coupling
support checks and execution details across `#assertQuerySupported` and `#queryRowsByIndex`.

## 2. `BatchGet` silently drops `UnprocessedKeys`

**Location:** `dynamodb-uow-executor.ts` (`#batchGetRowsFromLayout`)

### Problem

DynamoDB may return partial `BatchGetItem` results with `UnprocessedKeys` under throttling or
capacity pressure. The current implementation reads only `Responses`, so query results and filtered
counts can silently miss rows.

### Potential solutions

- Retry `UnprocessedKeys` until empty.
- Add bounded exponential backoff with jitter.
- If retries are exhausted, throw a specific adapter error rather than returning incomplete data.
- Keep row ordering logic after all retries complete.

### Structural change

Create shared helpers for DynamoDB retryable batch APIs:

- `batchGetAll(client, request, options)`
- `batchWriteAll(client, request, options)`

The test cleanup code already handles `BatchWriteCommand` unprocessed items; the production executor
should have equivalent resilience for reads.

## 3. Migrations use newly-created tables before they are active

**Location:** `migration/prepared-migrations.ts` (`ensureTable`)

### Problem

`CreateTableCommand` can return while the table is still `CREATING`. The migration then immediately
writes schema versions, scans base tables, or writes index entries. Against real AWS DynamoDB this
can fail intermittently because the table may not yet be active.

### Potential solutions

- After `CreateTableCommand`, wait until `DescribeTable` reports `TableStatus === "ACTIVE"`.
- If `DescribeTableCommand` finds an existing table in `CREATING` or `UPDATING`, wait instead of
  returning immediately.
- Use AWS SDK waiters if available, or implement a small bounded polling loop with backoff.
- Fail loudly with a timeout error if the table does not become active.

### Structural change

Extract table lifecycle handling into a migration utility:

- `ensureDynamoDBTableActive(...)`
- `createDynamoDBTableIfMissing(...)`

This keeps migration execution readable and makes table readiness behavior reusable across future
migration operations.

## 4. Unique index backfill overwrites duplicates instead of failing

**Location:** `migration/prepared-migrations.ts` (`backfillRowIndexes`)

### Problem

Backfilled unique sidecar entries use unconditional `PutCommand`. If existing rows contain duplicate
values for a newly-added unique index, later rows overwrite earlier `unique#...` entries. The
migration succeeds while the table violates the unique constraint.

### Potential solutions

- Use conditional puts for unique sidecar entries:
  - `ConditionExpression: "attribute_not_exists(#pk) AND attribute_not_exists(#sk)"`
- If a duplicate is found, throw `DatabaseConstraintError` or a migration-specific uniqueness error
  with table/index context.
- Consider using transactional writes per source row where feasible, while respecting DynamoDB
  transaction limits.
- For non-unique index entries, unconditional idempotent put may be acceptable; for unique entries
  it is not.

### Structural change

Unify index-entry construction between runtime writes and migration backfill. Runtime writes already
create conditional unique index sidecar entries; migration backfill should reuse the same
index-entry model plus a mode-specific write strategy.

Possible extraction:

- `dynamodb-index-items.ts`
  - `createPrimaryIndexEntry(...)`
  - `createSecondaryIndexItems(...)`
  - `createAllIndexItems(...)`
  - metadata identifying whether an item enforces uniqueness

Then runtime and migration code can share the same encoding and uniqueness semantics.

## 5. Custom `namingStrategy` is ignored by unit-of-work operations

**Location:** `dynamodb-adapter.ts` / `dynamodb-uow-operation-compiler.ts`

### Problem

Migrations receive `this.namingStrategy`, but `createBaseUnitOfWork` constructs
`DynamoDBUOWOperationCompiler` with only `tablePrefix`. Reads/writes therefore compile plans using
the default naming strategy even if migrations created tables with a custom naming strategy.

### Potential solutions

- Add `namingStrategy?: SqlNamingStrategy` to `DynamoDBOperationCompilerOptions`.
- Pass `this.namingStrategy` from `DynamoDBAdapter.createBaseUnitOfWork`.
- Use the provided strategy in `createDynamoDBLayout` inside
  `DynamoDBUOWOperationCompiler.#basePlan`.

### Structural change

Make `DynamoDBLayoutOptions` construction centralized. The adapter, compiler, migrations, and
internal-table setup should all flow through one layout factory configured by the adapter instance,
reducing the risk of divergent table naming.

## 6. Cursors skip duplicate values on non-unique indexes

**Location:** `dynamodb-uow-decoder.ts` / `dynamodb-uow-executor.ts` (`createCursorPagination`)

### Problem

DynamoDB non-unique index sort keys include the external-id tiebreaker, but cursors generated by the
decoder only include declared index columns. If a page ends in the middle of several rows with the
same indexed value, the next `after` cursor cannot resume after the exact row and can skip remaining
duplicates.

### Potential solutions

- Include a DynamoDB-specific external-id tiebreaker in cursor index values, e.g.
  `__fragnoExternalId`.
- Ensure `createCursorPagination` uses that tiebreaker to build the precise `ExclusiveStartKey`.
- Preserve opaque cursor compatibility by adding the tiebreaker as internal metadata rather than
  exposing a public schema column.
- Add validation that cursor `indexName` and direction match the current query.

### Structural change

Introduce adapter cursor metadata support:

- Generic cursor creation stays schema-column based.
- Adapters may append internal tiebreaker metadata for stable pagination.
- The query engine contract should require stable pagination across duplicate non-unique index
  values.

## Cross-cutting structural recommendations

### A. Split executor responsibilities

`dynamodb-uow-executor.ts` currently handles retrieval, mutation preflight, transaction assembly,
index maintenance, outbox writes, condition evaluation, cursor handling, and error classification.
Consider splitting it into focused modules:

- `dynamodb-retrieval-executor.ts`
- `dynamodb-mutation-executor.ts`
- `dynamodb-index-items.ts`
- `dynamodb-condition-evaluator.ts`
- `dynamodb-cursor.ts`
- `dynamodb-retry.ts`
- `dynamodb-transaction-errors.ts`

This would make future adapter behavior easier to reason about and test in isolation.

### B. Share index item construction between migrations and runtime

Runtime writes and migration backfill should not duplicate index entry construction. Shared index
helpers would prevent migration/runtime divergence for:

- primary sidecar index entries
- non-unique secondary entries
- unique secondary entries
- null handling for unique indexes
- external-id tiebreakers

### C. Model query planning explicitly

Instead of using a boolean support check plus local predicate filtering, represent the plan
explicitly:

```ts
interface DynamoDBIndexQueryPlan {
  keyConditionExpression: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, unknown>;
  residualPredicate?: (row: DynamoDBRawRow) => boolean;
  requiresScanAllowance: boolean;
}
```

This makes it testable that supported equality queries are pushed down into DynamoDB rather than
accidentally converted into bounded scans.

### D. Standardize DynamoDB retry/backoff behavior

Create one retry policy for:

- `BatchGetCommand` unprocessed keys
- `BatchWriteCommand` unprocessed items
- transient table lifecycle waits
- conditional internal-id reservation retries

Avoid silent local recovery; retries should either produce complete results or throw a stable,
actionable error.

## Suggested contract tests for `adapters/test-suite/query-engine-suite.ts`

The following tests should live in the shared query-engine suite where possible so future adapters
must satisfy the same behavior. DynamoDB-specific mechanics can be verified in adapter-local tests,
but the observable behavior belongs in the shared suite.

### 1. Stable cursor pagination across duplicate non-unique index values

**Why shared:** All adapters should paginate without skipping or duplicating rows when many rows
share the ordered index value.

**Scenario:**

- Create 5 users with the same `name`, ordered by a non-unique index such as `users_name_idx`.
- Page with `pageSize(2)`.
- Fetch pages with `.after(cursor)` until `hasNextPage === false`.
- Assert the union of IDs is exactly all 5 IDs in deterministic order, with no skips or duplicates.

This would catch cursor implementations that do not include a tie-breaker.

### 2. Equality predicates on leading index columns must be selective enough to avoid bounded-scan failure

**Why partially shared:** The exact no-scan mechanism is adapter-specific, but the observable
contract is that a leading equality query should work even with many non-matching rows in the same
index.

**Scenario:**

- Seed many rows with `name = "A"` and one row with `name = "Z"`.
- Query `whereIndex("users_name_idx", eb => eb("name", "=", "Z"))`.
- Assert the `Z` row is returned.

For DynamoDB, run this with a very low `maxFilteredReadPages` in the adapter harness. The shared
suite could expose a harness option such as `strictLeadingEqualityPushdown: true` or an adapter
factory override.

### 3. Filtered counts must not silently miss rows under partial batch reads

**Why mostly adapter-local:** Partial `BatchGet` behavior is DynamoDB-specific, but the shared
contract is that counts are complete.

**Shared scenario:**

- Create rows matching a secondary index condition.
- Run `selectCount()` with an additional residual predicate.
- Assert the count is exact.

**DynamoDB-local addition:**

- Use a fake client that returns `UnprocessedKeys` on the first `BatchGetCommand` and the rows on
  retry.
- Assert the executor retries and returns complete rows/counts.

### 4. Adding a unique index over duplicate existing data must fail migration

**Why adapter-local or migration-suite:** This is migration behavior, not normal query behavior. If
a shared migration contract suite exists, it should go there rather than `query-engine-suite.ts`.

**Scenario:**

- Migrate a schema without a unique index.
- Insert two rows with the same future unique-index value.
- Run migration that adds the unique index.
- Assert migration fails and does not silently pick one duplicate.

### 5. Custom naming strategies must be honored by runtime reads/writes

**Why shared adapter contract:** If an adapter accepts naming strategies, migrations and runtime
operations must use the same layout.

**Scenario:**

- Create an adapter with a custom naming strategy that visibly changes table names.
- Run migrations.
- Create and read a row through a UOW.
- Assert the row round-trips.

This may need a shared adapter harness option to provide custom adapter construction.

### 6. Newly-created migration resources must be usable immediately after migration

**Why adapter-local:** Table readiness is specific to services with asynchronous DDL.

**Scenario:**

- Against real/local DynamoDB, run `prepareMigrations(...).execute(0)`.
- Immediately create a UOW and insert/read a row.
- Assert no resource-not-ready errors.

A deterministic unit test can fake `DescribeTable` returning `CREATING` before `ACTIVE` and assert
the migration waits.

## Suggested adapter-local tests

Some issues require DynamoDB command-level assertions and should remain in
`packages/fragno-db/src/adapters/dynamodb/`.

### Pushdown test

Use a fake client and inspect the `QueryCommand` generated for a leading equality query. Assert the
command includes an `sk` key condition/prefix and not only `#pk = :pk`.

### BatchGet retry test

Use a fake client that returns:

1. `Responses` for half of the requested keys and `UnprocessedKeys` for the rest.
2. `Responses` for the remaining keys.

Assert all rows are returned in the original index order.

### Migration readiness test

Use a fake client sequence:

1. `DescribeTable` throws not found.
2. `CreateTable` succeeds.
3. `DescribeTable` returns `CREATING`.
4. `DescribeTable` returns `ACTIVE`.

Assert migration does not proceed to writes/scans until the active state is observed.

### Unique backfill collision test

Use real DynamoDB local or a fake client to verify unique sidecar puts use conditional expressions
and duplicate existing rows fail migration.

## Implementation priority

1. Fix `BatchGet` unprocessed keys: prevents silent data loss.
2. Wait for table active during migrations: prevents production migration flakes.
3. Enforce unique constraints during backfill: prevents invalid migrated data.
4. Push leading equality into DynamoDB key conditions: prevents valid queries from failing under
   normal data volume.
5. Pass `namingStrategy` through runtime plans: fixes custom configuration correctness.
6. Add cursor tiebreakers: fixes pagination correctness for duplicate non-unique values.
