# Fragno Query Language Specification

## Overview

Index-constrained query construction layer. All queries must specify an index and can only filter on
indexed columns.

## Retrieval Operations

### Find Operation

**Required:**

- `type`: `"find"`
- `indexName`: Index name (`"_primary"` for primary key)
- `options.useIndex`: Same as `indexName`

**Optional:**

- `options.select`: `true` (all columns) or `string[]` (specific columns)
- `options.where`: Condition function (indexed columns only)
- `options.orderByIndex`: `{ indexName: string, direction: "asc" | "desc" }`
- `options.after`: Encoded cursor string (forward pagination)
- `options.before`: Encoded cursor string (backward pagination)
- `options.pageSize`: Number (limit results)
- `options.joins`: Array of compiled joins

### Count Operation

**Required:**

- `type`: `"count"`
- `indexName`: Index name
- `options.useIndex`: Same as `indexName`

**Optional:**

- `options.where`: Condition function (indexed columns only)

## Conditions

All conditions must reference indexed columns only.

**Condition Types:**

- `{ type: "compare", a: Column, operator: Operator, b: Value | null }`
- `{ type: "and" | "or", items: Condition[] }`
- `{ type: "not", item: Condition }`

**Operators:**

- Value: `=`, `!=`, `>`, `>=`, `<`, `<=`, `is`, `is not`
- Array: `in`, `not in`
- String: `contains`, `starts with`, `ends with`, `not contains`, `not starts with`, `not ends with`
- Special: `isNull(column)`, `isNotNull(column)`

**Boolean shortcuts:** `true` (no WHERE), `false` (impossible condition)

## Ordering

Index-based only. Orders by all columns in the specified index.

**Fields:**

- `orderByIndex.indexName`: Index name
- `orderByIndex.direction`: `"asc"` | `"desc"`

## Pagination

Cursor-based using encoded cursor strings.

**Fields:**

- `after`: Encoded cursor (forward)
- `before`: Encoded cursor (backward)
- `pageSize`: Number

**Cursor structure:** `{ indexName, orderDirection, pageSize, indexValues }` encoded as base64 JSON.
Requires `orderByIndex` to match.

## Joins

Relation-based joins with nested join support. Joins are compiled into subqueries (lateral joins).

**Required:**

- `relation`: `{ type: "one" | "many", on: [sourceColumn, targetColumn][], table: Table }`
  - `type`: `"one"` returns single object or null, `"many"` returns array
  - `on`: Array of column pairs defining the join condition
  - `table`: Target table schema

**Optional:**

- `options.select`: `true` (all columns) or `string[]` (specific columns)
- `options.where`: Condition function (indexed columns on target table only)
- `options.orderBy`: `[column, "asc"|"desc"][]` (must be index columns)
- `options.limit`: Number (limits joined records)
- `options.join`: Array of nested joins (recursive structure)

**Constraints:**

- Where clauses restricted to indexed columns on target table
- Ordering uses index columns only
- Nested joins supported (joins within joins)
- Join conditions use internal IDs (`_internalId`) for foreign key relationships

## Mutation Operations

### Create

**Required:**

- `type`: `"create"`
- `table`: Table name
- `values`: Column values object
- `generatedExternalId`: External ID string

**Note:** Foreign keys accept FragnoId objects or external ID strings (resolved via subquery).

### Update

**Required:**

- `type`: `"update"`
- `table`: Table name
- `id`: FragnoId or external ID string
- `checkVersion`: Boolean (adds version check to WHERE if true)
- `set`: Column values object

**Note:** Version auto-incremented. ID column cannot be updated.

### Delete

**Required:**

- `type`: `"delete"`
- `table`: Table name
- `id`: FragnoId or external ID string
- `checkVersion`: Boolean (adds version check to WHERE if true)

### Check

**Required:**

- `type`: `"check"`
- `table`: Table name
- `id`: FragnoId (must have version)

**Note:** Generates SELECT query to verify version without modification.

## Index Constraints

- All queries require an index (`indexName` field)
- `"_primary"` refers to primary key index
- Where clauses restricted to indexed columns only
- Ordering uses `orderByIndex` with index name

## Column Selection

- `true`: All columns (default)
- `string[]`: Specific column names

Hidden columns (`_internalId`, `_version`) auto-included when needed for FragnoId construction.

## Foreign Key Handling

Foreign keys accept FragnoId objects, external ID strings, or internal ID (bigint). Compiler
resolves to internal ID via subqueries when needed.
