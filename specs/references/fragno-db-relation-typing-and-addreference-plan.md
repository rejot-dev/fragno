# Fragno DB FK model rewrite, relation typing removal, and schema `noOp()` plan

## Status

Current working plan after the explicit query-tree join API landed.

This reflects the decisions made so far:

- remove relation-name-driven public APIs and typing
- make real foreign keys authored at the column site via `referenceColumn({ table })`
- remove `addReference(...)` completely
- remove old relation-driven join APIs completely
- make query-tree the only public join API
- preserve schema history length with one-for-one `noOp()` replacements
- treat this as a full repo-wide breaking change fixed forward

---

## Final direction

## 1. Querying no longer depends on schema-declared relations

Explicit query-tree joins are the canonical and only public join API.

That means joins are defined by:

- alias
- target table name
- cardinality (`joinOne` / `joinMany`)
- indexed correlation via `onIndex(...)`

Consequences:

- remove the old relation-key-driven join DSLs
- remove legacy `find`-surface join support
- relation names are no longer part of the public query authoring model
- public `table.relations` ergonomics are intentionally gone

## 2. Remove relation precision from public table types

Target public shape:

```ts
interface Table<TColumns, TIndexes> {
  columns: TColumns;
  indexes: TIndexes;
}
```

Consequences:

- remove public `relations` from `Table`
- remove exact relation-map typing entirely
- remove `TableWithRelations<...>`
- remove relation-map widening from schema builder return types
- remove public `relations.author`-style typing completely

## 3. Real FK declarations move onto `referenceColumn(...)`

New authored FK declaration model:

```ts
.addColumn("userId", referenceColumn({ table: "user" }))
```

This replaces the old split model:

```ts
.addColumn("userId", referenceColumn())
.addReference("sessionOwner", {
  from: { table: "session", column: "userId" },
  to: { table: "user", column: "id" },
  type: "one",
})
```

### Agreed rules

- `referenceColumn({ table: "..." })` is the authored FK declaration
- bare `referenceColumn()` is removed
- target table is required
- author input uses a table name string
- validation happens after full schema assembly, so forward references to later tables are allowed
- local table/column order during builder use does not matter; final built state is what is
  validated
- target must be another table in the same schema
- target table must have the standard Fragno `idColumn()`
- source must be an actual `referenceColumn(...)`, not an arbitrary column
- nullable reference columns remain supported
- self-referencing foreign keys remain supported
- retargeting an existing FK in place is not supported
- in `alterTable(...)`, adding a new reference column is allowed; mutating an existing non-reference
  column into an FK column is not supported
- renaming an FK-bearing reference column preserves its FK semantics
- changing nullability of an FK-bearing reference column remains allowed
- defaults are disallowed on `referenceColumn({ table: ... })`
- the public/authored model is explicitly single-column only

## 4. No separate `addForeignKey(...)` API

We considered adding `addForeignKey(...)`, but the chosen direction is simpler:

- **no `addForeignKey(...)` API**
- the FK declaration lives entirely on `referenceColumn({ table })`

This gives a single authored source of truth.

## 5. Remove `addReference(...)` completely

This is a hard breaking change.

- remove `addReference(...)` from the schema builder
- remove `add-reference` from `SchemaOperation`
- remove all internal handling for `add-reference`
- rewrite all first-party packages, tests, docs, templates, and examples forward
- no deprecation wrapper / shim

## 6. Remove join-only and old convenience relation metadata aggressively

Current stance:

- do not keep join-only relations for documentation
- do not keep old query-only relation metadata
- do not keep non-FK relation metadata unless a concrete runtime consumer exists

Based on current codegen/runtime research, there is no in-repo consumer that justifies preserving
the old `foreignKey: false` query-era references.

---

## Research result: do Drizzle/Prisma outputs need non-FK relations?

## Answer

No.

The current generators already ignore join-only / non-FK relations.

### Drizzle

`packages/fragno-db/src/schema-output/drizzle.ts`

- skips relations with `foreignKey === false`
- derives inverse relations only from real FK-like one-side edges

There is already a test asserting join-only relations do not produce Drizzle relation output.

### Prisma

`packages/fragno-db/src/schema-output/prisma.ts`

- skips join-only relations
- derives inverse sides from real FK-like one-side edges

There is already a test asserting join-only relations do not produce Prisma relation output.

## Conclusion

- non-FK relation metadata is not needed for current codegen
- removing it does not reduce current Drizzle/Prisma output fidelity

---

## What replaces public relations?

## 1. Hidden internal FK metadata on built tables

Public `table.relations` goes away, but internal runtime code still needs efficient FK metadata.

Chosen direction:

- store hidden internal derived FK metadata on the built table object
- treat it as an internal property only
- internal code should access it via helper functions, not direct property reads

## 2. Internal FK model is forward-only and real-FK-only

Chosen direction:

- internal metadata represents only real forward FK edges
- no authored `many`
- no join-only relations
- no public relation names
- inverse sides are derived where needed by scanning tables / FK metadata

## 3. Internal FK metadata shape

Chosen direction:

- use a **minimal FK-specific structure**, not the old broad `Relation` shape
- organize metadata as a **map keyed by source reference column name**
- do **not** redundantly store the source column name inside each entry
- keep migration internals array-shaped for now, but the public/authored model remains single-column
  only

## 4. Internal identifiers are opaque

Chosen direction:

- any internal FK/relation identifiers are opaque implementation details
- they are not used as public field names
- Prisma/Drizzle generated public relation field names are derived independently from columns/tables

---

## FK naming and codegen

## 1. No authored FK names in the new public API

Since `addReference("sessionOwner", ...)` goes away, there is no public FK/relation naming
declaration in the first pass.

Chosen direction:

- generated/user-facing names are auto-derived only
- no explicit naming metadata on `referenceColumn(...)` in the first pass

## 2. Derived FK operation names

Even though FK declarations live on columns, operation history still needs deterministic FK names.

Chosen direction:

- derive FK operation names deterministically from source table + source column
- do not depend on old relation names

## 3. Generated Prisma/Drizzle relation fields stay supported

Chosen direction:

- keep generated relation fields in Prisma/Drizzle output
- generate both forward and inverse relation fields
- derive public field names from columns/tables, not old relation names
- treat the new derived naming rules as a **stable contract** after this breaking release
- resolve collisions automatically with deterministic disambiguation rules

Generated names are allowed to change in this breaking release, but the new derivation rules should
then be considered stable.

---

## Schema history and `noOp()`

## Purpose

We need a safe way to remove old schema-level `addReference(...)` calls without shrinking schema
history length.

## API

```ts
.noOp()
.noOp("removed obsolete query-only relation metadata")
```

## Chosen semantics

- `noOp()` increments schema version
- `noOp()` records a real schema operation, e.g. `{ type: "no-op", reason?: string }`
- reason is optional
- `noOp()` should not necessarily be documented as a public feature
- use it as an internal/advanced schema-history tool

## Replacement rule

This is strict:

- every removed historical `addReference(...)` becomes exactly one `noOp()`
- this includes both:
  - removed query-only references
  - removed real FK `addReference(...)` calls whose semantics are now encoded on the column

## Important invariant

We are preserving:

- **history length**

We are **not** preserving:

- the exact old version when a real FK first became active

That is acceptable for this breaking rewrite.

---

## Operation recording and migration model

## 1. FK declarations are still recorded as explicit table sub-operations

Even though the authored declaration lives on the column, schema history should still record
explicit derived FK sub-operations.

Chosen direction:

- derive `add-foreign-key` table sub-operations from `referenceColumn({ table })`
- keep FK operations as table sub-operations, not schema-level operations

## 2. Table sub-operation ordering

Chosen direction:

- when recording table ops, a derived `add-foreign-key` sub-operation appears **immediately after
  its source `add-column`**

This is the chosen schema-history ordering.

## 3. Migration DDL execution order may differ from schema history order

Chosen direction:

- preserve schema history order exactly as recorded
- allow migration compilation / dialect preprocessing to reorder or preprocess **DDL execution
  only** when necessary for correctness
- this is especially important for forward references to tables declared later
- SQLite-style preprocessing remains acceptable

So schema-history ordering and SQL execution ordering are intentionally decoupled.

---

## Indexing policy

Chosen direction:

- `referenceColumn({ table: ... })` does **not** auto-create an index
- indexes remain explicit via `createIndex(...)`
- unindexed foreign keys are allowed

So FK semantics and indexing/performance stay separate.

---

## Auth schema example: what stays and what goes

Source: `packages/auth/src/schema.ts`

## Keep, but convert to target-aware `referenceColumn({ table })`

These are real FK edges:

- `sessionOwner`
- `sessionActiveOrganization`
- `organizationCreator`
- `organizationMemberOrganization`
- `organizationMemberUser`
- `organizationMemberRoleMember`
- `organizationInvitationOrganization`
- `organizationInvitationInviter`
- `oauthAccountUser`
- `oauthStateLinkUser`

In practice that means moving target info onto these columns:

- `session.userId -> user`
- `session.activeOrganizationId -> organization`
- `organization.createdBy -> user`
- `organizationMember.organizationId -> organization`
- `organizationMember.userId -> user`
- `organizationMemberRole.memberId -> organizationMember`
- `organizationInvitation.organizationId -> organization`
- `organizationInvitation.inviterId -> user`
- `oauthAccount.userId -> user`
- `oauthState.linkUserId -> user`

Each removed historical `addReference(...)` for these becomes a one-for-one `noOp()`.

## Remove entirely

These are old query-only / alias / inverse convenience relations and should be deleted:

- `organizationMembers`
- `sessionOrganizationMembers`
- `sessionMembers`
- `organizationMemberRoles`
- `roles`
- `organization` on `organizationMember`
- `userOrganizationInvitations`
- `invitations`
- `organization` on `organizationInvitation`
- `userOrganizationMembers`

Each removed historical call becomes a one-for-one `noOp()`.

---

## Repo-wide breaking rewrite scope

Chosen direction:

- rewrite the whole repo in one sweep
- do it as **one atomic repo-wide change**
- update:
  - first-party packages
  - tests
  - templates
  - docs
  - examples

This is not a partial migration.

---

## APIs removed in this breaking change

- `addReference(...)`
- relation-key-driven join builder APIs in:
  - `packages/fragno-db/src/query/mod.ts`
  - `packages/fragno-db/src/query/unit-of-work/unit-of-work.ts`
- legacy join support on the old `find` surface
- public `table.relations`
- bare `referenceColumn()`
- schema-level `add-reference` operations

---

## APIs added/changed in this breaking change

- `referenceColumn({ table: "..." })`
- `noOp(reason?)`

---

## Implementation phases

## Phase 1: finalize the public type cleanup

In `packages/fragno-db/src/schema/create.ts` and related typing:

- remove `TableWithRelations<...>`
- remove relation-map widening from schema builder typing
- remove public `relations` from `Table`
- simplify table typing to columns + indexes only

## Phase 2: move FK declaration onto columns

- change `referenceColumn()` to require `{ table: string }`
- disallow defaults on reference columns
- store unresolved target table name on the authored column
- resolve target metadata after full schema assembly
- validate target table existence and `idColumn()` presence at build time
- derive hidden internal FK metadata for built tables
- expose that metadata through internal helper APIs

## Phase 3: remove old relation APIs and legacy join APIs

- remove `addReference(...)`
- remove `add-reference` schema operations
- remove old relation-key-driven join DSLs
- remove legacy join support from the old `find` surface
- remove public `table.relations`

## Phase 4: update schema history mechanics

- add `noOp(reason?)`
- record `no-op` in `schema.operations`
- replace every removed historical `addReference(...)` with one `noOp()`
- derive `add-foreign-key` table sub-operations from FK-bearing columns
- record each derived FK sub-op immediately after its source `add-column`
- allow migration DDL compilation to reorder/preprocess SQL execution as needed without changing
  recorded schema history order

## Phase 5: update codegen

- derive forward/inverse relation fields from real FK columns
- remove generator dependence on old relation names
- implement deterministic naming and deterministic collision handling
- lock naming behavior down in tests as the new stable contract

## Phase 6: rewrite repo usage

- migrate first-party schemas to `referenceColumn({ table })`
- remove query-only old relations
- insert one-for-one `noOp()` replacements
- update tests, docs, templates, and examples

---

## Remaining open questions

1. What exact minimal internal FK metadata type should replace the current broad `Relation`
   interface?
2. What exact forward/inverse naming rules should Prisma/Drizzle generators use once they stop
   depending on old relation names?

---

## Implementation checklist

### Core schema API and typing

- [ ] Change `referenceColumn()` to require `{ table: string }`
- [ ] Disallow defaults on `referenceColumn({ table })`
- [ ] Remove bare `referenceColumn()` support
- [ ] Remove public `relations` from `Table`
- [ ] Remove `TableWithRelations<...>`
- [ ] Remove relation-map widening from schema builder return types
- [ ] Keep public table typing limited to columns + indexes

### Internal FK metadata

- [ ] Add hidden internal FK metadata to built tables
- [ ] Keep internal FK metadata forward-only and real-FK-only
- [ ] Use a minimal FK-specific internal structure keyed by source column name
- [ ] Expose internal FK metadata through helper APIs
- [ ] Resolve FK targets after full schema assembly
- [ ] Rebuild hidden FK metadata through the normal build/clone path

### Schema operations and history

- [ ] Add `noOp(reason?)` to `SchemaBuilder`
- [ ] Add `no-op` to `SchemaOperation`
- [ ] Remove `addReference(...)` from `SchemaBuilder`
- [ ] Remove `add-reference` from `SchemaOperation`
- [ ] Remove all internal `add-reference` handling
- [ ] Derive `add-foreign-key` table sub-operations from FK-bearing columns
- [ ] Record each derived FK sub-op immediately after its source `add-column`
- [ ] Preserve schema history length with one-for-one `noOp()` replacements for every removed
      historical `addReference(...)`

### Migration engine and SQL generation

- [ ] Update migration generation to read derived FK sub-operations from table operations
- [ ] Preserve recorded schema history order
- [ ] Allow DDL execution order to be reordered/preprocessed for correctness
- [ ] Keep migration FK internals array-shaped for now
- [ ] Preserve rename/drop behavior for FK-bearing columns

### Query API cleanup

- [ ] Remove relation-key-driven join DSLs from `packages/fragno-db/src/query/mod.ts`
- [ ] Remove relation-key-driven join DSLs from
      `packages/fragno-db/src/query/unit-of-work/unit-of-work.ts`
- [ ] Remove legacy join support from the old `find` surface
- [ ] Keep query-tree as the only public join API

### Codegen

- [ ] Update Drizzle generation to derive relation fields from FK-bearing columns
- [ ] Update Prisma generation to derive relation fields from FK-bearing columns
- [ ] Generate both forward and inverse relation fields
- [ ] Remove generator dependence on old relation names
- [ ] Define deterministic forward naming rules
- [ ] Define deterministic inverse naming rules
- [ ] Implement deterministic collision handling
- [ ] Lock the new naming behavior down in tests as a stable contract

### Repo-wide migration

- [ ] Rewrite `packages/auth/src/schema.ts`
- [ ] Replace kept real FK references with `referenceColumn({ table })`
- [ ] Remove old query-only / alias / inverse convenience relations
- [ ] Insert one-for-one `noOp()` replacements in auth schema history
- [ ] Rewrite all first-party package schemas
- [ ] Rewrite tests across the repo
- [ ] Rewrite docs, templates, and examples
- [ ] Remove all remaining `addReference(...)` call sites
- [ ] Remove all remaining bare `referenceColumn()` call sites

### Validation and verification

- [ ] Run `pnpm exec turbo types:check --filter=./packages/fragno-db --output-logs=errors-only`
- [ ] Run `pnpm exec turbo test --filter=./packages/fragno-db --output-logs=errors-only`
- [ ] Run broader repo checks for affected packages
- [ ] Verify generated Prisma/Drizzle output snapshots after renaming changes
- [ ] Verify auth schema history length remains unchanged after replacing removed references with
      `noOp()`

## Immediate next steps

1. Change `referenceColumn()` to require `{ table }`.
2. Add `noOp()` and `no-op` schema operations.
3. Remove public relation typing and old/legacy join APIs.
4. Rewrite `packages/auth/src/schema.ts` and then the rest of the repo forward.
5. Lock down the new generator naming behavior in tests.
