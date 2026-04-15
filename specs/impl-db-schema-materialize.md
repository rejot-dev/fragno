# Impl: Materialize public schema types to reduce TypeScript type complexity

## Goal

Reduce the public type complexity of schemas created in `packages/fragno-db/src/schema/create.ts` by
materializing the final schema shape at the schema boundary.

The immediate target is large exported schema constants such as:

```ts
const formsSchema: Schema<AddTableToTables<Record<"form", Table<AddColumnToColumns<...>>>>
```

These builder-history-heavy types are expensive for declaration serialization and contribute to
`TS7056` failures in downstream packages like `packages/auth`.

## Problem

Today, the exported schema type preserves the full builder construction history:

- `AddTableToTables<...>`
- `AddColumnToColumns<...>`
- `AddIndexToIndexes<...>`

Even when the final schema shape is simple, TypeScript serializes the entire chain of helper types
instead of a normalized final object shape.

This leaks into:

- exported schema constants such as `authSchema`
- route factories that close over those schema values
- fragment definitions that extend `withDatabase(schema)`

## Proposed direction

Introduce a **materialized public schema type** that preserves semantics but remaps the final schema
into a fresh object shape.

This is intentionally a **non-lossy first pass**:

- preserve exact table names
- preserve exact columns
- preserve exact relation names
- preserve exact index names / `columnNames`
- do **not** widen relation targets yet

The goal of the first pass is to eliminate public exposure of builder-history helper chains, without
changing runtime behavior or query typing behavior.

## Proposed types

Add helper types in `packages/fragno-db/src/schema/create.ts`:

```ts
type Materialize<T> = {
  [K in keyof T]: T[K];
};

type MaterializeColumns<TColumns extends Record<string, AnyColumn>> = Materialize<TColumns>;

type MaterializeIndexes<TIndexes extends Record<string, Index>> = Materialize<TIndexes>;

type MaterializeRelations<TRelations extends Record<string, AnyRelation>> = Materialize<TRelations>;

type MaterializeTable<TTable extends AnyTable> =
  TTable extends Table<infer TColumns, infer TRelations, infer TIndexes>
    ? Table<
        MaterializeColumns<TColumns>,
        MaterializeRelations<TRelations>,
        MaterializeIndexes<TIndexes>
      >
    : never;

type MaterializeTables<TTables extends Record<string, AnyTable>> = Materialize<{
  [K in keyof TTables]: MaterializeTable<TTables[K]>;
}>;

export type MaterializeSchema<TTables extends Record<string, AnyTable>> = Schema<
  MaterializeTables<TTables>
>;
```

## API changes

### Change `SchemaBuilder.build()`

Current:

```ts
build(): Schema<TTables>
```

Proposed:

```ts
build(): MaterializeSchema<TTables>
```

Implementation would still build the same runtime object and cast the return value to the
materialized public type.

### Change `schema()`

Current:

```ts
export function schema<const TTables extends Record<string, AnyTable> = {}>(
  name: string,
  callback: (builder: SchemaBuilder<{}>) => SchemaBuilder<TTables>,
): Schema<TTables> {
  return callback(new SchemaBuilder(name)).build();
}
```

Proposed:

```ts
export function schema<const TTables extends Record<string, AnyTable> = {}>(
  name: string,
  callback: (builder: SchemaBuilder<{}>) => SchemaBuilder<TTables>,
): MaterializeSchema<TTables> {
  return callback(new SchemaBuilder(name)).build();
}
```

## Expected outcome

Instead of exposing builder-history-heavy types like:

```ts
Schema<AddTableToTables<Record<...>, ...>>
```

public exports should become closer to:

```ts
Schema<{
  form: Table<{
    id: ...;
    title: ...;
    description: ...;
    ...
  }, {
    ...
  }, {
    ...
  }>;
  response: Table<...>;
}>
```

This should make exported schema constants significantly easier for TypeScript to serialize.

## Why this is low risk

This first pass only changes the **public representation** of built schemas.

It does **not**:

- change runtime behavior
- change how `SchemaBuilder` constructs schemas at runtime
- remove relation information
- widen relation target tables
- alter query-time typing behavior intentionally

It only remaps the final `TTables` shape into a fresh object type.

## Limitations

This may not fully solve all `TS7056` cases, because recursive relation target types can still leak
through `Relation<..., TTable, ...>`.

So this should be treated as the first simplification boundary:

1. materialize the public schema shape
2. measure whether downstream exported schemas get smaller
3. only if needed, consider a second-stage public simplification of relation targets

## Non-goals for this pass

- no lossy widening of relation target tables
- no changes to `DatabaseFragmentDefinitionBuilder.build()` public types yet
- no `TableBuilder` / `SchemaBuilder` generic-state refactor yet
- no query-layer changes

## Validation plan

After implementing:

1. Run:
   - `pnpm exec turbo build --filter=@fragno-dev/db --output-logs=errors-only`
   - `pnpm exec turbo types:check --filter=@fragno-dev/db --output-logs=errors-only`
   - `pnpm exec turbo test --filter=@fragno-dev/db --output-logs=errors-only`
2. Run:
   - `pnpm exec turbo types:check --filter=@fragno-dev/auth --output-logs=errors-only`
3. Inspect whether exported schema types in downstream packages are now serialized as materialized
   object shapes instead of `Add*` helper chains.
4. If `TS7056` still persists on exported schemas, evaluate a second-stage public simplification for
   relation targets.

## Follow-up options if this is not enough

### Option A: public relation simplification

If relation target recursion still dominates, consider a second-stage helper such as:

```ts
type PublicRelation<TRelation extends AnyRelation> =
  TRelation extends Relation<infer TRelationType, infer _TTable, infer TTableName>
    ? Relation<TRelationType, AnyTable, TTableName>
    : TRelation;
```

This would be higher risk because it weakens relation target precision on the exported schema value.

### Option B: builder state refactor

If builder-history helper chains still dominate inside `create.ts`, refactor `TableBuilder` and
`SchemaBuilder` to use a single state generic instead of multiple growing generic parameters.

### Option C: downstream public API simplification

If `auth` still fails on route factories or fragment definitions, simplify those exported public
surfaces separately.
