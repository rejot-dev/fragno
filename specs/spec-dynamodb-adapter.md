# Fragno DB DynamoDB Adapter — Spec and Implementation Plan

## 0. Open Questions

None. The decision ledger below keeps the design questions visible and records the chosen answer for
implementation.

## 1. Overview

Add a DynamoDB adapter for `@fragno-dev/db` that preserves Fragno's existing Unit of Work (UOW),
optimistic concurrency, indexes, cursor pagination, settings, and optional outbox behavior as much
as DynamoDB permits.

The adapter should look like `SqlAdapter` at the public boundary, but it should be implemented more
like the in-memory adapter internally: the compiler emits adapter-native operation plans, and the
executor translates those plans into DynamoDB SDK commands while maintaining Fragno sidecar indexes.

Primary design choice: build a **faithful Fragno adapter** first, not a Dynamo-native limited
adapter. Fragno schema indexes are represented by transactionally-maintained sidecar index rows
instead of DynamoDB GSIs. This keeps reads strongly consistent when requested, lets arbitrary Fragno
indexes work without table lifecycle churn, and avoids documenting large query-surface gaps for the
first version.

## 2. References

Current Fragno code paths:

- Adapter interface: `packages/fragno-db/src/adapters/adapters.ts`
- SQL adapter shell: `packages/fragno-db/src/adapters/generic-sql/generic-sql-adapter.ts`
- SQL operation compiler:
  `packages/fragno-db/src/adapters/generic-sql/query/generic-sql-uow-operation-compiler.ts`
- SQL executor: `packages/fragno-db/src/adapters/generic-sql/generic-sql-uow-executor.ts`
- In-memory adapter shell: `packages/fragno-db/src/adapters/in-memory/in-memory-adapter.ts`
- In-memory UOW executor/decoder: `packages/fragno-db/src/adapters/in-memory/in-memory-uow.ts`
- Query tree in-memory execution: `packages/fragno-db/src/adapters/in-memory/query-tree.ts`
- UOW contracts: `packages/fragno-db/src/query/unit-of-work/unit-of-work.ts`
- Condition model: `packages/fragno-db/src/query/condition-builder.ts`
- Cursor model: `packages/fragno-db/src/query/cursor.ts`
- Value encoding/decoding:
  - `packages/fragno-db/src/query/value-encoding.ts`
  - `packages/fragno-db/src/query/value-decoding.ts`
- Outbox spec: `specs/spec-outbox.md`

DynamoDB references:

- Query key conditions require partition-key equality and optional sort-key conditions:
  <https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.KeyConditionExpressions.html>
- `TransactWriteItems` supports up to 100 actions / 4 MB and rejects duplicate actions on the same
  item: <https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html>
- DynamoDB item size is 400 KB:
  <https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html>

## 3. Goals

1. Provide a production-capable `DatabaseAdapter` implementation for DynamoDB.
2. Preserve Fragno UOW semantics: two phases, optimistic concurrency, version conflicts returning
   `{ success: false }`, and created IDs returned after mutation execution.
3. Preserve Fragno schema indexes without requiring users to manually design DynamoDB GSIs.
4. Support strongly consistent reads for adapter-maintained indexes.
5. Support schema initialization/versioning through `prepareMigrations()`.
6. Support outbox/durable-hooks integration in the adapter MVP.
7. Keep the public API small and testable.

## 4. Non-goals

- Dynamo-native single-table design as the default.
- GSI-backed indexes in the MVP.
- Scans by default.
- Large-object storage beyond DynamoDB's 400 KB item limit.
- Perfect SQL-like query expressiveness for non-index-compatible filters.
- Physical column migrations for column additions/removals. DynamoDB is schemaless; migrations are
  table/index infrastructure plus schema-version bookkeeping.

## 5. Public API

Add a new public subpath:

```txt
@fragno-dev/db/adapters/dynamodb
```

The adapter depends on the AWS SDK DynamoDB document client types. The package should add optional
peer dependencies for `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb`, and the DynamoDB
subpath is the only code path that imports them.

```ts
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { SqlNamingStrategy } from "../../naming/sql-naming";
import type { UOWInstrumentation } from "../../query/unit-of-work/unit-of-work";

export interface DynamoDBAdapterOptions {
  client: DynamoDBDocumentClient;
  tablePrefix?: string;
  namingStrategy?: SqlNamingStrategy;
  consistentRead?: boolean;
  maxFilteredReadPages?: number;
  allowScans?: boolean;
  uowConfig?: DynamoDBUnitOfWorkConfig;
}

export interface DynamoDBUnitOfWorkConfig {
  dryRun?: boolean;
  instrumentation?: UOWInstrumentation;
  onCommand?: (command: DynamoDBCommandPlan) => void;
  consistentRead?: boolean;
  maxFilteredReadPages?: number;
  allowScans?: boolean;
}

export class DynamoDBAdapter implements DatabaseAdapter<DynamoDBUnitOfWorkConfig> {
  readonly namingStrategy: SqlNamingStrategy;
  readonly adapterMetadata: DatabaseAdapterMetadata;

  prepareMigrations<T extends AnySchema>(schema: T, namespace: string | null): PreparedMigrations;
  getSchemaVersion(namespace: string): Promise<string | undefined>;
  isConnectionHealthy(): Promise<boolean>;
  close(): Promise<void>;
}
```

`close()` is a no-op because the AWS SDK client owns its lifecycle.

`onCommand` mirrors SQL's `onQuery`, but exposes adapter command plans instead of raw AWS command
instances so tests do not depend on SDK internals.

## 6. Terminology

- **Base table**: DynamoDB table that stores actual row data for one Fragno table.
- **Index table**: DynamoDB sidecar table storing one or more sorted index entries for one Fragno
  table.
- **Index entry**: An item in the index table mapping an encoded index tuple to an external ID.
- **Unique sentinel**: An index-table item used to enforce a unique Fragno index.
- **Settings table**: DynamoDB table storing schema versions, internal ID counters, and outbox
  version rows.
- **DynamoDB command plan**: Adapter-native plan emitted by the UOW compiler and observed through
  `onCommand`.

## 7. Decision Ledger

| #   | Question                                                        | Choice                                                                                                                                                                                                                                                    | Rationale                                                                                                                                                           |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | One table per Fragno table or single-table design?              | Use one base table plus one index sidecar table per Fragno table, with one shared settings table per adapter prefix.                                                                                                                                      | Direct mapping is easier to debug, migrate, test, and reason about. Single-table design can be added later as an advanced storage profile.                          |
| 2   | Should Fragno indexes map to GSIs or sidecar rows?              | Use sidecar index rows.                                                                                                                                                                                                                                   | Sidecar rows can be updated in the same transaction as the base row, support arbitrary Fragno indexes, and avoid eventual-consistency surprises from GSIs.          |
| 3   | How are composite index keys encoded?                           | Implement an order-preserving tuple codec for DynamoDB string sort keys, with a stable external-ID tiebreaker appended for non-unique index entries.                                                                                                      | Cursor pagination needs deterministic ordering even when multiple rows share the same index values.                                                                 |
| 4   | How are namespaces represented physically?                      | Include namespace in physical table names through the naming resolver and `tablePrefix`.                                                                                                                                                                  | Keeps table data isolated, readable in AWS consoles, and aligned with existing Fragno naming concepts.                                                              |
| 5   | How is `_internalId: bigint` generated?                         | Use a per-physical-table counter row in the settings table. Reserve blocks before the mutation transaction. Gaps are allowed.                                                                                                                             | Deterministic, no collision path, and no need to write sentinel rows for internal IDs. DynamoDB transactions cannot return computed values needed by later actions. |
| 6   | Is `_internalId` unique globally, per namespace, or per table?  | Per physical base table.                                                                                                                                                                                                                                  | This matches typical SQL auto-increment behavior and existing adapter expectations.                                                                                 |
| 7   | How strict is query support?                                    | Strict by default: use an index query path or reject. Adapter-side filtering is allowed only over queried index entries, bounded by `maxFilteredReadPages`. Scans require `allowScans: true`.                                                             | Prevents accidental table scans and cost surprises.                                                                                                                 |
| 8   | How does `count()` work?                                        | Use `Query Select=COUNT` when the condition is fully represented by the index key. Otherwise count bounded queried index pages with adapter-side filtering. Reject unbounded counts unless scans are explicitly enabled.                                  | Exact counts are possible, but must remain cost-visible.                                                                                                            |
| 9   | How much join/query-tree support is in the MVP?                 | Query-tree joins are included after core indexed reads, implemented as N+1 indexed reads with batching where possible. Legacy `CompiledJoin` support follows only if existing conformance tests require it.                                               | Query-tree is the current canonical read shape; N+1 is correct and testable before optimizing.                                                                      |
| 10  | What happens when a UOW exceeds DynamoDB transaction limits?    | Preflight the transaction plan and throw a clear adapter limit error. Do not split transactions.                                                                                                                                                          | Splitting breaks UOW atomicity. DynamoDB transaction limits are hard boundaries.                                                                                    |
| 11  | How are large items / large JSON columns handled?               | Estimate item size before write and throw a clear adapter error before sending obviously oversized items. Do not add S3 overflow storage in this adapter.                                                                                                 | DynamoDB has a 400 KB item limit; overflow belongs in a storage/upload fragment, not the DB adapter.                                                                |
| 12  | What retry policy does the adapter own?                         | Use AWS SDK retries for transport/throttling and Fragno UOW retry semantics for OCC/version conflicts. Map transaction cancellation caused by version/settings contention to `{ success: false }` only when it is a retryable OCC-style conflict.         | Keeps retry ownership consistent with existing adapters.                                                                                                            |
| 13  | Are index rows strongly consistent?                             | Yes when `consistentRead` is true. Sidecar rows are written in the same transaction as base rows.                                                                                                                                                         | DynamoDB supports strongly consistent reads on tables; sidecar indexes are tables, not GSIs.                                                                        |
| 14  | How are unique indexes enforced?                                | Write unique sentinel items in the index table with conditional `attribute_not_exists(pk)`. Updates replace sentinels transactionally.                                                                                                                    | Gives SQL-like unique constraint behavior without GSIs.                                                                                                             |
| 15  | How are new indexes backfilled?                                 | `prepareMigrations()` creates missing sidecar tables and runs a paginated backfill for newly-added indexes, writing index rows in batches.                                                                                                                | DynamoDB has no column schema, but index sidecars are physical data that must be materialized.                                                                      |
| 16  | What does `prepareMigrations()` mean?                           | Ensure settings table, base tables, index tables, index backfills, and schema-version writes. It does not migrate columns.                                                                                                                                | This is the meaningful physical work for DynamoDB.                                                                                                                  |
| 17  | Should dropping columns/indexes physically clean up data?       | Dropping columns is a no-op. Dropping indexes marks them obsolete and optionally removes sidecar rows via an explicit compaction helper later.                                                                                                            | Avoid expensive destructive operations during normal migrations.                                                                                                    |
| 18  | Is outbox supported in the MVP?                                 | Yes.                                                                                                                                                                                                                                                      | Durable hooks rely on adapter-level outbox support; keeping it in the MVP avoids a second compatibility tier.                                                       |
| 19  | How are outbox versionstamps generated?                         | Use the settings table version row inside the same `TransactWriteItems` call. The executor strongly reads current value, writes `next`, and includes a condition that the old value still matches. Contention returns `{ success: false }` for UOW retry. | Preserves outbox atomicity and commit-order monotonicity without pre-reservation gaps.                                                                              |
| 20  | Where does the adapter live?                                    | In `@fragno-dev/db/adapters/dynamodb`.                                                                                                                                                                                                                    | Matches existing adapter subpaths and keeps AWS dependencies isolated to one entrypoint.                                                                            |
| 21  | Does config expose low-level AWS SDK options?                   | No. Users pass a configured `DynamoDBDocumentClient`; the adapter only exposes Fragno-specific behavior flags.                                                                                                                                            | Keeps API small and delegates AWS auth/endpoints/retry config to the SDK.                                                                                           |
| 22  | Should `onCommand` mirror SQL `onQuery`?                        | Yes.                                                                                                                                                                                                                                                      | It gives visibility for tests and debugging without leaking raw SDK command classes.                                                                                |
| 23  | Faithful adapter or Dynamo-native adapter?                      | Faithful adapter first.                                                                                                                                                                                                                                   | Fragno users should not have to redesign schemas for DynamoDB in the first version.                                                                                 |
| 24  | How are duplicate transaction actions on the same item handled? | Coalesce `check` with same-row `update`/`delete` conditions. Reject multiple writes to the same base item in one UOW with a clear error.                                                                                                                  | DynamoDB rejects transactions that target the same item more than once.                                                                                             |
| 25  | How are tests run?                                              | Unit tests use pure codecs/planners. Integration tests use DynamoDB Local through an endpoint helper and are skipped unless the endpoint is configured in local development; CI can opt in by starting DynamoDB Local.                                    | Avoids mocks while still keeping most behavior testable without AWS credentials.                                                                                    |

## 8. Physical Data Model

### 8.1 Table names

Given `tablePrefix = "fragno"`, namespace `shop`, and logical table `orders`:

```txt
fragno__settings
fragno__shop__orders
fragno__shop__orders__idx
```

The exact names are produced by a DynamoDB layout resolver that uses the adapter's
`SqlNamingStrategy` for logical table/column naming and then applies DynamoDB-safe escaping.

### 8.2 Settings table

```ts
type SettingsItem =
  | {
      pk: "schema_version";
      sk: string; // namespace
      value: string;
    }
  | {
      pk: "internal_id_counter";
      sk: string; // physical base table name
      value: string; // decimal bigint
    }
  | {
      pk: "outbox_version";
      sk: "global";
      value: string; // decimal bigint
    };
```

Primary key:

```txt
pk: string
sk: string
```

### 8.3 Base table

Each Fragno table gets a base table with a simple string hash key:

```txt
pk: string // external ID
```

Item shape:

```ts
type BaseRowItem = {
  pk: string;
  id: string;
  _internalId: string; // bigint encoded as decimal string
  _version: number;
  // physical column names follow
};
```

Bigints are stored as decimal strings to avoid DynamoDB number precision issues. Dates/timestamps
are stored as ISO strings. Binary values are stored as binary attributes. JSON values are stored as
DocumentClient-compatible maps/lists/scalars.

### 8.4 Index table

Each Fragno table gets one sidecar index table:

```txt
pk: string
sk: string
```

Non-unique index entry:

```ts
type IndexEntry = {
  pk: `idx#${string}`; // index name, including idx#_primary
  sk: string; // encoded tuple + external id tiebreaker
  externalId: string;
  internalId: string;
};
```

Unique index sentinel:

```ts
type UniqueIndexSentinel = {
  pk: `unique#${string}`;
  sk: string; // encoded tuple only
  externalId: string;
};
```

Primary index entries are stored in the same sidecar table as `idx#_primary`, ordered by external ID
unless the primary index is later changed to internal ID ordering by a breaking adapter version.

## 9. Index Key Codec

Implement `dynamodb-index-codec.ts` with an order-preserving tuple encoding that supports Fragno
column types:

- `string` / `varchar(n)`
- `integer`
- `decimal`
- `bigint`
- `bool`
- `date`
- `timestamp`
- `json` only for equality/sentinel encoding; reject JSON range ordering
- `binary` only for equality/sentinel encoding; reject binary range ordering
- `null`

Encoding requirements:

1. Lexicographic string order must match Fragno's adapter ordering for supported scalar values.
2. Each tuple segment must be type-tagged.
3. Segment boundaries must be unambiguous.
4. Nulls sort before non-null values in ascending order.
5. Descending reads should use DynamoDB `ScanIndexForward: false`; the encoded key remains
   ascending.
6. Non-unique index entries append the encoded external ID as a tiebreaker.

The first implementation should keep the codec local to the DynamoDB adapter. It can be generalized
later if another KV adapter appears.

## 10. Operation Compiler

Add `DynamoDBUOWOperationCompiler extends UOWOperationCompiler<DynamoDBCommandPlan>`.

The compiler should emit semantic plans, not raw SDK commands:

```ts
type DynamoDBCommandPlan =
  | DynamoDBFindPlan
  | DynamoDBCountPlan
  | DynamoDBCreatePlan
  | DynamoDBUpdatePlan
  | DynamoDBDeletePlan
  | DynamoDBCheckPlan;
```

Plans include:

- schema and namespace
- table layout
- selected columns
- index metadata
- encoded values
- compiled Fragno conditions
- cursor metadata
- original mutation operation for outbox planning

The executor turns these plans into `QueryCommand`, `BatchGetCommand`, `GetCommand`,
`UpdateCommand`, and `TransactWriteCommand` calls.

## 11. Retrieval Execution

### 11.1 Find

Default path:

1. Query the sidecar index table with `pk = idx#<indexName>`.
2. Apply key bounds from cursor/range-compatible conditions when possible.
3. Page through index entries up to `pageSize + 1` for cursor reads.
4. Batch-get base rows by external ID.
5. Reorder batch-get results according to index-entry order.
6. Apply any remaining condition in adapter code, bounded by `maxFilteredReadPages`.
7. Select/decode rows through `DynamoDBUOWDecoder`.

If an operation cannot use an index and `allowScans` is false, throw a clear error that explains
which table/index/condition caused the fallback.

### 11.2 Count

- If the condition is fully representable as a sidecar index key condition, use DynamoDB `Query`
  with `Select: "COUNT"`.
- If additional filtering is needed, page index entries and count matching base rows, bounded by
  `maxFilteredReadPages`.
- If a scan would be required and `allowScans` is false, throw.

### 11.3 Query tree joins

Query-tree joins are evaluated in the executor using indexed child reads:

1. Fetch root rows through the normal find path.
2. For each child node, derive the child index condition from the parent row.
3. Query the child sidecar index table.
4. Batch-get child base rows.
5. Recurse for nested children.
6. Produce raw rows in the shape expected by `DynamoDBUOWDecoder`.

This is intentionally correctness-first. Optimization can batch equal child lookups later.

## 12. Mutation Execution

The executor should preflight the whole mutation batch before calling `TransactWriteItems`:

- Compute all base-row targets.
- Reject multiple write operations targeting the same base item.
- Coalesce `check` operations into same-item write conditions when possible.
- Count transaction actions and estimated item sizes.
- Build outbox plan if enabled.

### 12.1 Create

For each create operation:

1. Reserve an internal ID from the per-table counter block.
2. Encode values and defaults.
3. Put base row with `attribute_not_exists(pk)`.
4. Put `_primary` sidecar index entry.
5. Put custom sidecar index entries.
6. Put unique sentinel entries with `attribute_not_exists(pk)` / `attribute_not_exists(sk)`
   conditions.
7. Return created internal IDs in create-operation order.

### 12.2 Update

For each update operation:

1. Strongly read current base row by external ID.
2. Check version if requested.
3. Encode updated values and compute new row.
4. Compute old and new index keys.
5. In the transaction:
   - update base row with `_version = expected` condition when version checking is enabled,
   - delete changed old index entries,
   - put changed new index entries,
   - update unique sentinels for changed unique indexes.

The base row update increments `_version` by one.

### 12.3 Delete

For each delete operation:

1. Strongly read current base row.
2. Check version if requested.
3. In the transaction:
   - delete base row with version condition,
   - delete all sidecar index entries,
   - delete unique sentinels.

### 12.4 Check

A check without a same-item mutation becomes a `ConditionCheck` on the base row:

```txt
pk = externalId AND _version = expectedVersion
```

A check on the same row as an update/delete is folded into that write's condition because DynamoDB
transactions cannot target the same item twice.

### 12.5 Conflict/error mapping

Return `{ success: false }` for:

- version-condition failures,
- missing row when a version check was requested,
- outbox version row contention,
- retryable transaction cancellation caused by OCC-style conditions.

Throw normalized errors for:

- unique constraint violations,
- foreign key violations once FK enforcement exists,
- item-size errors,
- transaction action/size limit errors,
- unsupported query shapes,
- AWS service errors that are not retryable OCC conflicts.

## 13. Outbox

Outbox support is included in the adapter MVP.

Algorithm:

1. Build the same logical outbox plan as the SQL and in-memory executors using
   `buildOutboxPlan(...)`.
2. Strongly read the settings item `{ pk: "outbox_version", sk: "global" }`.
3. Let `next = current + 1`, or `0` if missing.
4. Add a settings update/put to the same `TransactWriteItems` call:
   - existing row: condition `value = current`, set `value = next`
   - missing row: condition `attribute_not_exists(pk)`, put `value = 0`
5. Write outbox mutation rows and outbox entry rows in the same transaction.
6. If the settings condition fails, return `{ success: false }` so the UOW retry loop can rerun.

This preserves the outbox spec's atomicity and commit-order monotonicity. The outbox version row is
a global serialization point for outbox-enabled UOWs, which is acceptable for the first version.

## 14. Migrations and Schema Versioning

`prepareMigrations(schema, namespace)` returns a DynamoDB-flavored `PreparedMigrations` compatible
with the existing adapter surface.

Responsibilities:

1. Ensure the settings table exists.
2. Ensure each base table exists.
3. Ensure each sidecar index table exists.
4. Read the current schema version from settings.
5. For added indexes, backfill sidecar rows by scanning the base table in pages and writing index
   rows in batches.
6. Write the new schema version to settings.

Column additions/removals are metadata-only. Existing items are not rewritten during normal
migration. Defaults are applied on future writes.

Backfill should be idempotent: writing an already-existing sidecar row is safe when it points to the
same external ID, and unique conflicts fail the migration with a useful message.

## 15. Value Encoding and Decoding

Add a DynamoDB-specific value codec instead of reusing SQL serializers directly.

Rules:

- `string` / `varchar(n)`: string
- `integer`: number
- `decimal`: number initially; revisit decimal precision if Fragno adds a decimal object type
- `bigint`: decimal string
- `bool`: boolean
- `json`: DocumentClient-compatible JSON value
- `binary`: `Uint8Array` / binary attribute
- `date` / `timestamp`: ISO string
- references: internal ID decimal string
- `_internalId`: decimal string internally, decoded to `bigint`
- `_version`: number

`DynamoDBUOWDecoder` mirrors `UnitOfWorkDecoder` and `InMemoryUowDecoder`: it converts raw base rows
into application rows, hides hidden columns, and constructs `FragnoId` / `FragnoReference` values.

## 16. Limits and Validation

The adapter should validate before execution where possible:

- transaction actions > 100: throw `DynamoDBTransactionLimitError`
- transaction item aggregate likely > 4 MB: throw `DynamoDBTransactionLimitError`
- base or index item likely > 400 KB: throw `DynamoDBItemSizeError`
- unsupported index key value type: throw `DynamoDBUnsupportedQueryError`
- query would scan and `allowScans` is false: throw `DynamoDBUnsupportedQueryError`
- filtered query pages exceed `maxFilteredReadPages`: throw `DynamoDBReadLimitError`

The first implementation may estimate item sizes conservatively using serialized JSON byte length
plus attribute-name lengths. It does not need to perfectly match DynamoDB billing size to be useful.

## 17. Package and Export Changes

Update `packages/fragno-db/package.json` exports:

```json
{
  "./adapters/dynamodb": {
    "types": "./dist/adapters/dynamodb/index.d.ts",
    "default": "./dist/adapters/dynamodb/index.js"
  }
}
```

Update `packages/fragno-db/tsdown.config.ts` to build the new entrypoint.

Do not export DynamoDB implementation internals from `mod.ts` or barrel files. Public files should
be exported through `package.json` subpaths, following repository guidance.

## 18. Implementation Plan — Testable Slices

Each slice should leave the codebase in a working state and include focused tests. Use Turbo with
`--output-logs=errors-only` after each implementation slice, for example:

```sh
pnpm exec turbo types:check --filter=@fragno-dev/db --output-logs=errors-only
pnpm exec turbo test --filter=@fragno-dev/db --output-logs=errors-only
```

### Slice 1 — DynamoDB layout, value codec, and index codec

- [x] Complete this slice.

Spec sections: 8, 9, 15, 16.

Files:

- `packages/fragno-db/src/adapters/dynamodb/dynamodb-layout.ts`
- `packages/fragno-db/src/adapters/dynamodb/dynamodb-value-codec.ts`
- `packages/fragno-db/src/adapters/dynamodb/dynamodb-index-codec.ts`
- colocated tests

Work:

- Resolve physical settings/base/index table names.
- Encode/decode DynamoDB attribute values for all supported Fragno scalar types.
- Encode/decode ordered index tuples and non-unique tiebreakers.
- Add item-size estimation helpers.

Tests:

- Value codec round-trips `Date`, `bigint`, JSON, binary, booleans, nulls.
- Index codec ordering matches expected order for strings, numbers, bigints, timestamps, booleans,
  and nulls.
- Non-unique entries with equal index values order by external ID tiebreaker.
- Unsupported JSON/binary range ordering throws.

### Slice 2 — Adapter shell, package export, command-plan compiler

- [x] Complete this slice.

Spec sections: 5, 10, 17.

Files:

- `packages/fragno-db/src/adapters/dynamodb/dynamodb-adapter.ts`
- `packages/fragno-db/src/adapters/dynamodb/dynamodb-uow-operation-compiler.ts`
- `packages/fragno-db/src/adapters/dynamodb/index.ts`
- `packages/fragno-db/package.json`
- `packages/fragno-db/tsdown.config.ts`

Work:

- Implement `DynamoDBAdapter` shell matching `DatabaseAdapter`.
- Register schemas and namespaces like `SqlAdapter` / `InMemoryAdapter`.
- Compile UOW operations into semantic `DynamoDBCommandPlan` objects.
- Wire `onCommand` through normalized UOW config.
- Add public subpath export.

Tests:

- Adapter identity is `dynamodb@1`.
- `createUnitOfWork()` and `createBaseUnitOfWork()` compile retrieval/mutation plans.
- `onCommand` observes plans for creates, updates, deletes, checks, finds, and counts.
- Package type checks with the new export.

### Slice 3 — Migrations, health, schema version, and DynamoDB Local test harness

- [x] Complete this slice.

Spec sections: 14, 18.

Files:

- `packages/fragno-db/src/adapters/dynamodb/migration/prepared-migrations.ts`
- `packages/fragno-db/src/adapters/dynamodb/test-utils.ts`
- migration tests

Work:

- Implement `prepareMigrations()` for settings/base/index table creation.
- Implement `getSchemaVersion()` and schema-version writes.
- Implement `isConnectionHealthy()` with a lightweight settings-table describe/list path.
- Add a test helper that connects to DynamoDB Local via `FRAGNO_DYNAMODB_ENDPOINT` and skips
  integration tests when absent.

Tests:

- Migration creates settings/base/index tables for a sample schema.
- Re-running migration is idempotent.
- `getSchemaVersion()` returns `undefined` before migration and current version after migration.
- Health check succeeds against DynamoDB Local.

### Slice 4 — Create and primary-index find end to end

- [x] Complete this slice.

Spec sections: 8, 11.1, 12.1, 15.

Files:

- `packages/fragno-db/src/adapters/dynamodb/dynamodb-uow-executor.ts`
- `packages/fragno-db/src/adapters/dynamodb/dynamodb-uow-decoder.ts`
- integration tests

Work:

- Implement internal ID block reservation.
- Execute create operations transactionally.
- Write base rows and `_primary` sidecar index entries.
- Execute primary-index finds via sidecar query + batch-get.
- Decode rows into Fragno application values.

Tests:

- Migrate sample schema, create a row, find it by primary index, and assert decoded `FragnoId` has
  external ID, internal ID, and version `0`.
- Multiple creates in one UOW return created IDs in create-operation order.
- Duplicate external ID maps to thrown constraint/service error, not `{ success: false }`.

### Slice 5 — Update, delete, check, and OCC conflicts end to end

- [ ] Complete this slice.

Spec sections: 12.2, 12.3, 12.4, 12.5.

Files:

- executor tests
- planner preflight tests

Work:

- Strongly pre-read rows for update/delete.
- Increment `_version` on update.
- Delete base and sidecar rows on delete.
- Implement standalone checks and check coalescing.
- Detect duplicate writes to the same base item.
- Map version conflicts to `{ success: false }`.

Tests:

- Update changes a row and increments version.
- Delete removes base row and primary sidecar entry.
- `.check()` succeeds with current version and fails with stale version.
- Stale update/delete returns `{ success: false }`.
- Check + update same row compiles to one write condition.
- Two writes to the same row in one UOW throw a clear adapter error.

### Slice 6 — Secondary indexes, unique indexes, cursor pagination, and count

- [ ] Complete this slice.

Spec sections: 9, 11.1, 11.2, 12.1, 12.2, 14.

Files:

- executor index maintenance
- migration backfill code
- pagination/count tests

Work:

- Write secondary sidecar index entries on create.
- Update/delete changed secondary entries on update/delete.
- Enforce unique indexes through sentinels.
- Add cursor pagination over sidecar index entries.
- Implement `count()` fast path and bounded filtered path.
- Backfill added index entries during migration.

Tests:

- Find by secondary index returns rows in index order.
- Updating an indexed column moves the row to the new index position.
- Deleting a row removes secondary entries.
- Unique constraint violation throws.
- Cursor pagination returns `pageSize` rows, `hasNextPage`, and a usable cursor.
- Count by index returns the expected value.
- Added index migration backfills existing rows.

### Slice 7 — Query-tree joins and reference columns

- [ ] Complete this slice.

Spec sections: 9, 11.3, 15.

Files:

- `packages/fragno-db/src/adapters/dynamodb/dynamodb-query-tree.ts`
- reference resolution helpers
- query-tree tests

Work:

- Encode reference columns as internal IDs.
- Resolve reference external IDs on create/update by indexed lookup.
- Execute query-tree child nodes as indexed child reads.
- Decode nested child results.

Tests:

- Create parent/child rows using reference columns.
- Query root rows with one-child and many-child query-tree joins.
- Nested query-tree joins decode correctly.
- Missing referenced row throws a foreign-key-style error when constraints are enforced.

### Slice 8 — Outbox integration end to end

- [ ] Complete this slice.

Spec sections: 13, 14.

Files:

- executor outbox support
- internal schema mapping for DynamoDB settings/outbox tables
- outbox tests

Work:

- Reuse `buildOutboxPlan()` and `finalizeOutboxPayload()`.
- Add outbox version row read/update inside mutation transaction.
- Write outbox entry and outbox mutation rows.
- Resolve outbox reference maps from created internal IDs.
- Treat outbox version contention as `{ success: false }`.

Tests:

- Outbox-disabled adapter writes no outbox rows.
- Outbox-enabled create/update/delete writes one outbox entry per successful UOW.
- Outbox versionstamps are monotonic and payload order matches UOW mutation order.
- Failed/stale mutation writes no outbox rows.
- Simulated outbox version contention returns `{ success: false }`.

### Slice 9 — Limits, validation, errors, and observability

- [ ] Complete this slice.

Spec sections: 12.5, 16.

Files:

- `packages/fragno-db/src/adapters/dynamodb/errors.ts`
- preflight helpers
- docs comments/tests

Work:

- Add explicit adapter error classes.
- Preflight transaction action count and size estimates.
- Enforce item-size estimates.
- Enforce query scan/filter limits.
- Improve `onCommand` snapshots for debugging.

Tests:

- UOW with too many transaction actions throws `DynamoDBTransactionLimitError` before SDK call.
- Oversized item throws `DynamoDBItemSizeError`.
- Unsupported unindexed query throws `DynamoDBUnsupportedQueryError` unless scans are enabled.
- Filtered query beyond `maxFilteredReadPages` throws `DynamoDBReadLimitError`.
- `onCommand` output is stable enough for snapshot-style assertions.

### Slice 10 — Shared conformance, docs, and examples

- [ ] Complete this slice.

Spec sections: all.

Files:

- shared adapter conformance tests where practical
- `apps/docs/content/docs/fragno/for-users/database-fragments/*`
- package README or adapter docs
- example fragment/app using DynamoDB Local endpoint

Work:

- Add DynamoDB to the adapter conformance suite for supported behavior.
- Document setup with AWS SDK client, table prefix, migrations, and local testing.
- Document DynamoDB-specific limits and unsupported query shapes.
- Add an example server configuration.

Tests:

- Run targeted `@fragno-dev/db` typecheck and test tasks.
- Run DynamoDB integration tests against local endpoint in CI when configured.
- Ensure docs examples typecheck if the repo has example validation for docs snippets.

## 19. Future Work

- GSI-backed indexes for read-heavy deployments that accept eventual consistency or explicit GSI
  consistency limits.
- Single-table storage profile.
- Batched query-tree child lookup optimization.
- Physical compaction for dropped indexes and removed columns.
- Optional maintained counter rows for cheap counts.
- S3 overflow integration through a separate storage/upload fragment rather than this adapter.
