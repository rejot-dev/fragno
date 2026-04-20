# Fragno DB query-tree join API sketch

This document captures the shape of the query-tree `find()` API for the Fragno DB query engine.

It originally described the `findNew()` migration path. The query-tree API is now the canonical
`find()` / `findFirst()` / `findWithCursor()` surface, and this document remains the reference for
its nested-join model.

## Goals

- Build a **query tree**, not a flat join list
- Keep joins constrained to **indexes**, like `whereIndex()` and `orderByIndex()`
- Support nested object/array results naturally
- Match how the SQL adapter already builds nested results with `json_agg`
- Avoid requiring the schema `references` system, though references may later become optional sugar

## High-level model

- `find()` creates a root query node
- `joinOne()` creates a child object node
- `joinMany()` creates a child array node
- Each child node is attached through `onIndex(...)`
- `onIndex(...)` uses a new correlated variant of `IndexSpecificConditionBuilder`
- Correlated join conditions may reference the **direct parent only**

## Core decisions

### Query tree, not flat joins

The new API should model nested results directly:

- root row
- child objects via `joinOne`
- child arrays via `joinMany`
- recursively nested children

### Explicit cardinality

Cardinality is explicit in the API:

- `joinOne(...)` => `T | null`
- `joinMany(...)` => `T[]`

Do not infer cardinality from references or index uniqueness.

### Direct-parent correlation only

`onIndex(...)` may reference only the **immediate parent**.

This keeps each edge locally plannable and avoids introducing root / ancestor scoping rules in v1.

### `joinOne` first-row semantics

`joinOne()` should not require uniqueness.

If multiple rows match, it should return the first row the database happens to produce.

There should be:

- **no default ordering**
- no implicit `orderByIndex(...)`
- no attempt to enforce deterministic selection unless the user explicitly adds ordering/limiting

### Left-join style expansion

For missing children:

- `joinOne(...)` => `null`
- `joinMany(...)` => `[]`

This API is for shape expansion, not for filtering parents by child existence.

### References are optional sugar

The new API must work without schema references.

Later, references may be used as optional sugar, but they should not be required by the query model.

## Proposed API surface

## Root

```ts
uow.find("posts", (q) =>
  q.whereIndex("primary", (eb) => eb("id", "=", postId)).select(["id", "title", "content"]),
);
```

### Root builder methods

```ts
whereIndex(indexName, condition?)
select(columns)
orderByIndex(indexName, direction)
pageSize(n)
joinOne(alias, tableName, builder)
joinMany(alias, tableName, builder)
```

## Child nodes

### `joinOne`

```ts
.joinOne("author", "users", (author) =>
  author
    .onIndex("primary", (eb) => eb("id", "=", eb.parent("user_id")))
    .select(["id", "name"]),
)
```

### `joinMany`

```ts
.joinMany("comments", "comments", (comments) =>
  comments
    .onIndex("comments_post_idx", (eb) => eb("post_id", "=", eb.parent("id")))
    .select(["id", "text", "user_id"]),
)
```

### Child builder methods

```ts
onIndex(indexName, condition);
select(columns);
orderByIndex(indexName, direction);
pageSize(n);
joinOne(alias, tableName, builder);
joinMany(alias, tableName, builder);
```

## Correlated condition builder

`onIndex(...)` should use a new variant of `IndexSpecificConditionBuilder`.

Suggested mental model:

```ts
CorrelatedIndexSpecificConditionBuilder<TChildTable, TParentTable, TIndexName>;
```

It should behave like the existing index-specific builder, but add:

```ts
eb.parent("columnName");
```

Example:

```ts
.onIndex("comments_post_idx", (eb) =>
  eb("post_id", "=", eb.parent("id")),
)
```

## Rules for `eb.parent(...)`

- only references the **direct parent**
- uses logical column names
- only valid inside `onIndex(...)`
- intended primarily for equality-based correlation
- compiler may perform the same column/id coercions already used elsewhere in the query engine

## Example: post with comments and comment authors

```ts
uow.find("posts", (q) =>
  q
    .whereIndex("primary", (eb) => eb("id", "=", postId))
    .select(["id", "title", "content"])
    .joinMany("comments", "comments", (comments) =>
      comments
        .onIndex("comments_post_idx", (eb) => eb("post_id", "=", eb.parent("id")))
        .select(["id", "text", "user_id"])
        .joinOne("author", "users", (author) =>
          author
            .onIndex("primary", (eb) => eb("id", "=", eb.parent("user_id")))
            .select(["id", "name"]),
        ),
    ),
);
```

Expected result shape:

```ts
{
  id: FragnoId;
  title: string;
  content: string;
  comments: Array<{
    id: FragnoId;
    text: string;
    user_id: FragnoReference;
    author: {
      id: FragnoId;
      name: string;
    } | null;
  }>;
}
```

## Example: current nested join test rewritten

Equivalent shape for:

- `comments -> post -> author`
- `comments -> commenter`

```ts
uow.find("comments", (q) =>
  q
    .whereIndex("primary")
    .select(["id", "text", "post_id", "user_id"])
    .joinOne("post", "posts", (post) =>
      post
        .onIndex("primary", (eb) => eb("id", "=", eb.parent("post_id")))
        .select(["id", "title", "content", "user_id"])
        .joinOne("author", "users", (author) =>
          author
            .onIndex("primary", (eb) => eb("id", "=", eb.parent("user_id")))
            .select(["id", "name", "age"]),
        ),
    )
    .joinOne("commenter", "users", (commenter) =>
      commenter
        .onIndex("primary", (eb) => eb("id", "=", eb.parent("user_id")))
        .select(["id", "name"]),
    ),
);
```

## Index constraints

The API should preserve the existing indexed-query philosophy.

### Root

Root queries continue to use `whereIndex(...)` and optional `orderByIndex(...)`.

### Child nodes

Child nodes use `onIndex(...)` as the indexed access path.

At least in v1:

- child nodes should not also have a separate `whereIndex(...)`
- `onIndex(...)` is both the correlation and the child lookup predicate

This keeps planning simple.

## Ordering and pagination semantics

### `joinMany`

- `orderByIndex(...)` defines array order when specified
- `pageSize(n)` limits child rows before aggregation
- if no ordering is specified, result order is database-dependent

### `joinOne`

- no default ordering
- if multiple rows match, first row wins according to database behavior
- `orderByIndex(...)` and `pageSize(1)` may still be allowed when callers want deterministic
  selection

## SQL compilation model

The new tree should map naturally to the current SQL approach:

- root query selects root rows
- `joinOne` compiles to a correlated subquery producing a single JSON object or `null`
- `joinMany` compiles to a correlated subquery using `json_agg`
- nested child nodes recurse inside the child subquery

This is not a classic flat SQL join API. It is a structured, index-aware graph query API.

## Non-goals for v1

- ancestor / root references from inside `onIndex(...)`
- filtering parents by child existence
- requiring references for join definition
- enforcing uniqueness for `joinOne`
- deterministic row selection for `joinOne` unless explicitly requested

## Migration stance

- keep current `find()` join API working
- add `find()` alongside it
- use `find()` to validate the new query tree representation and compiler
- later decide whether old joins become sugar over the new tree model
