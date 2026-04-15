# Fragno DB Type Performance Analysis

Yes — I dug through the data in `~/Downloads/mcp` and the main offenders are pretty clear.

## What the trace data says

From `~/Downloads/mcp/analyze-trace.json`:

- `recursiveTypeRelatedTo_DepthLimit`: **409 events**
- all other depth-limit categories: **0**
- duplicate packages: basically irrelevant here
  - only `@vitest/runner` duplicated (`4.1.0` + `4.1.4`)
- `hotSpots` was empty, so I used `trace.json`, `types.json`, and `type-graph.json` directly

## Worst files

Approx `checkSourceFile` time from `trace.json`:

- `packages/fragno-db/src/query/unit-of-work/execute-unit-of-work.ts` — **96.1ms**
- `packages/fragno-db/src/schema/create.ts` — **88.1ms**
- `packages/fragno-db/src/db-fragment-definition-builder.ts` — **79.0ms**
- `packages/fragno-db/src/query/unit-of-work/unit-of-work.ts` — **28.1ms**

A lot of tests are hotter than the library files, but they’re hot because they instantiate the
library’s heavy public types.

## The actual bad types

### 1) `TypedUnitOfWork` + `find` / `findFirst` / `findWithCursor`

File:

- `packages/fragno-db/src/query/unit-of-work/unit-of-work.ts`

This is the biggest one.

Depth-limit event presence:

- `TypedUnitOfWork`: **225 / 409**
- `find`: **162 / 409**
- `findFirst`: **132 / 409**
- `findWithCursor`: **73 / 409**

Top expensive type relations:

- `TypedUnitOfWork ↔ TypedUnitOfWork` — **269.6ms**
- `find ↔ find` — **92.6ms**
- `findFirst ↔ findFirst` — **58.4ms**
- `findWithCursor ↔ findWithCursor` — **27.6ms**

Why it blows up:

- every call appends to a tuple:
  - `[..., TRetrievalResults, NewResult]`
- the appended result is deeply computed:
  - `SelectResult<... ExtractJoinOut<TBuilderResult> ... ExtractSelect<TBuilderResult> ...>`
- the builder arg uses:
  - `Omit<FindBuilder<...>, "build">`
- `ExtractSelect` / `ExtractJoinOut` then have to reason about both:
  - `FindBuilder`
  - `Omit<FindBuilder, ...>`

That creates a lot of structural comparison work, and the recursive depth-limit stack shows it.

---

### 2) `ServiceTxBuilder` / `ServiceTxCallbacks` / `InferBuilderResultType`

File:

- `packages/fragno-db/src/query/unit-of-work/execute-unit-of-work.ts`

This is the second big cluster.

Interesting counts from `types.json`:

- `ServiceTxBuilder`: **311 instantiations**, up to **12 type args**
- `HandlerTxBuilder`: **392 instantiations**, up to **11 type args**
- `InferBuilderResultType`: **49**
- `AwaitedPromisesInObject`: **42**

Depth-limit stacks repeatedly go through:

- `DatabaseFragmentDefinitionBuilder.build`
- `DatabaseServiceContext.serviceTx`
- `ServiceTxBuilder`
- `ServiceTxBuilderState`
- callback type like `(uow) => TypedUnitOfWork<...>`
- then into `TypedUnitOfWork.find`

So this file is a multiplier: it feeds the already-heavy UOW types into another very generic builder
state machine.

The problematic patterns are:

- many top-level generic params
- multiple boolean generic flags:
  - `HasRetrieve`
  - `HasTransformRetrieve`
  - `HasMutate`
  - `HasTransform`
- repeated conditional inference types:
  - `InferBuilderResultType`
  - `InferBuilderRetrieveSuccessResult`
- recursive mapped helper:
  - `AwaitedPromisesInObject`

---

### 3) `DatabaseFragmentDefinitionBuilder`

File:

- `packages/fragno-db/src/db-fragment-definition-builder.ts`

Counts:

- `DatabaseFragmentDefinitionBuilder`: **302 instantiations**
- max type args seen: **12**
- involved in **98 / 409** depth-limit events

The trace shows the bad path is specifically around `build()` and the service context it exposes:

- `DatabaseServiceContext.serviceTx(...)`
- returns fully instantiated `ServiceTxBuilder<...>`
- which then drags in the whole `TypedUnitOfWork.find` machinery

So this builder isn’t the root cause, but it amplifies the heavy query/builder types by exposing
them in a large generic wrapper.

---

### 4) Secondary hotspot: schema builder types

File:

- `packages/fragno-db/src/schema/create.ts`

This is more “lots of work” than “depth-limit disaster”.

Counts:

- `TableBuilder`: **1030 instantiations**
- `SchemaBuilder`: **605**
- `Table`: **1133**

Likely expensive pieces:

- `RefreshRelationTargets`
- `RefreshTableTargets`
- `UpdateTableRelations`
- `ColumnsToTuple`
- `UpdateColumn`
- `NullableColumn`

These are not the main recursive depth-limit source, but they do contribute a lot of checker volume.

---

### 5) `Prettify` and intermediate query helpers

Files:

- `packages/fragno-db/src/util/types.ts`
- `packages/fragno-db/src/query/simple-query-interface.ts`

Notable counts:

- `Prettify` internals show up a lot
- `MainSelectResult`: **1474 instantiations**
- `ExtractSelect`: **423**
- `ExtractJoinOut`: **412**

This is classic “pretty hover types are costing checker work”.

## Highest-confidence improvements

### 1) Replace `Omit<FindBuilder<...>, "build">` with an explicit public interface

This is the first change I’d make.

Instead of:

```ts
builder: Omit<FindBuilder<TTable>, "build">;
```

introduce something like:

```ts
export interface FindQueryBuilder<
  TTable extends AnyTable,
  TSelect extends SelectClause<TTable> = true,
  TJoinOut = {},
> {
  whereIndex<...>(...): this;
  select<const TNewSelect extends SelectClause<TTable>>(
    columns: TNewSelect,
  ): FindQueryBuilder<TTable, TNewSelect, TJoinOut>;
  join<TNewJoinOut>(...): FindQueryBuilder<TTable, TSelect, TNewJoinOut>;
  // etc
}
```

Then:

- `FindBuilder` implements that interface
- public APIs accept `FindQueryBuilder`
- `ExtractSelect` / `ExtractJoinOut` only need to understand that one interface

This should remove a lot of mapped-type expansion from `Omit`.

High ROI, low conceptual risk.

---

### 2) Split `ServiceTxBuilder` into stages instead of one mega-builder with boolean flags

Right now the builder encodes state with lots of generics + booleans.

That’s very expensive.

A better shape would be stage-specific builders, e.g.

- `ServiceTxBuilderBase`
- `ServiceTxBuilderWithRetrieve`
- `ServiceTxBuilderWithMutate`
- `ServiceTxBuilderFinal`

or a single `TState` object generic instead of 10 separate params.

Why this helps:

- fewer type arguments being compared
- fewer nested conditionals
- less recomputation of `InferBuilderResultType<...>`

This is probably the biggest structural improvement after the `FindBuilder` interface fix.

---

### 3) Stop exposing the full heavy builder type directly from service/handler context

In `db-fragment-definition-builder.ts`:

```ts
serviceTx<TSchema extends AnySchema>(schema: TSchema): ServiceTxBuilder<...>
handlerTx(...): HandlerTxBuilder<...>
```

These fully-expanded return types show up everywhere.

At minimum, define aliases:

```ts
type EmptyServiceTxBuilder<TSchema extends AnySchema, THooks extends HooksMap> = ...
type EmptyHandlerTxBuilder<THooks extends HooksMap> = ...
```

Better: make the builder types themselves shallower.

This won’t solve the root issue alone, but it will reduce how much type surface gets propagated.

---

### 4) Reduce `Prettify` usage on intermediate types

Use `Prettify` only on final user-facing result types, not intermediate machinery.

Good candidates to simplify:

- `SelectResult`
- `MainSelectResult`
- `UpdateColumn`
- possibly `TableToInsertValues`

It’s often useful for IDE display, but it definitely adds work when used deep inside other generics.

---

### 5) Simplify `AwaitedPromisesInObject`

This helper is reasonable, but expensive when layered on top of already-large conditional types.

If possible:

- only await at the API boundary
- avoid recursively remapping complex object results unless really needed
- normalize callback return types earlier so `execute()` doesn’t need such a big conditional wrapper

---

### 6) Schema builder: consider less eager relation retargeting

`RefreshTableTargets` / `RefreshRelationTargets` are expensive.

If you can defer some of that work, or make relation typing reference table names instead of eagerly
rebuilding table types, you’ll likely cut checker volume in `schema/create.ts`.

This feels secondary, though.

## My suggested order

If the goal is “best chance of a noticeable improvement fast”:

1. **Replace `Omit<FindBuilder, "build">` with explicit public builder interfaces**
2. **Refactor `ServiceTxBuilder` / `HandlerTxBuilder` away from boolean-flag generic state**
3. **Reduce propagation of fully-expanded builder return types in `DatabaseServiceContext` /
   `DatabaseHandlerContext`**
4. **Trim `Prettify` from intermediate helper types**
5. **Then revisit `schema/create.ts`**

## Short version

The real bad types are:

- `TypedUnitOfWork` result accumulation
- `find` / `findFirst` / `findWithCursor`
- `ServiceTxBuilder` / `HandlerTxBuilder`
- `DatabaseFragmentDefinitionBuilder` as the wrapper that propagates them

The single most suspicious pattern is:

- tuple-growing result types
- plus deeply inferred `SelectResult`
- plus `Omit<FindBuilder, "build">`
- plus mega generic builder state machines

If you want, I can do the next step and patch the most promising one first: **replace
`Omit<FindBuilder, "build">` with a dedicated public builder interface**, then run a fresh trace and
compare.
