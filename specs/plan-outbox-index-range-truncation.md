# Outbox truncation through retrieved mutation rows

## Goal

Allow workflow emission cleanup to remove both source rows and their normalized historical outbox
payloads while keeping partially synchronized clients consistent.

Initial use case: `onWorkflowStepEmissionsCleanup` removes `workflow_step_emission` rows selected by
the existing `(instanceRef, stepKey, epoch, createdAt, sequence, id)` index.

## Decisions

- Preserve the traditional Fragno `retrieve -> mutate` flow.
- Add no new UOW retrieval or mutation operation types.
- Add no hand-written or outbox-specific SQL.
- Keep source schemas unchanged.
- Keep `fragno_db_outbox` parent rows unchanged.
- Keep separate outbox-item and source-row identities:
  - `fragno_db_outbox_mutations.id` identifies one normalized outbox item.
  - `fragno_db_outbox_mutations.externalId` identifies the affected source row.
- Retrieve normalized outbox mutation IDs through a fixed, system-owned cross-schema join.
- Delete source rows and retrieved normalized mutation rows using the existing UOW `delete()`
  operation.
- Emit one ordered truncate notification after cleanup. The notification does not perform physical
  deletion.

## Existing normalized storage

Commit `e4bc6b4939f00ea6047a59e5494c6197f11e92f3` made `fragno_db_outbox_mutations.payload`
authoritative. `fragno_db_outbox` stores the UOW header, cursor, and ref map with an empty mutation
payload. Public outbox entries are reconstructed from normalized rows ordered by
`(entryVersionstamp, mutationVersionstamp)`.

Deleting a normalized mutation row therefore removes its payload from future outbox responses
without rewriting or deleting its parent entry. Mixed UOW entries retain unrelated normalized rows.
A parent with no remaining rows reconstructs as an empty batch and still advances the consumer
cursor.

## Fragment API

### Retrieval

Add a fixed helper to `QueryTreeFindBuilder`:

```ts
withOutboxMutations(): QueryTreeFindBuilder<
  TSchema,
  TTable,
  TSelect,
  TJoinOut & {
    $outboxMutations: Array<{
      id: FragnoId;
    }>;
  }
>;
```

It returns only the identity needed to delete each normalized mutation row. It does not expose the
payload or other internal columns.

`$outboxMutations` is reserved system output so it cannot be confused with a source column or a
fragment-defined relation.

### Source deletion

Extend the existing `DeleteBuilder` with metadata methods; these do not introduce a new
`MutationOperation` type:

```ts
class DeleteBuilder {
  check(): this;
  omitOutbox(): this;
}
```

- `check()` performs the existing source-version OCC check.
- `omitOutbox()` prevents the source deletion from producing an ordinary public outbox delete.

### Truncate notification

Keep internal storage private by exposing the existing internal `delete()` operation through a typed
outbox helper:

```ts
workflows.outbox.deleteMutation(mutation.id);
```

This helper only schedules an ordinary `delete()` against the normalized internal row.

Add outbox-plan metadata on the typed UOW:

```ts
workflows.outbox.notifyTruncate("workflow_step_emission", {
  match: {
    instanceRef: payload.instanceRef,
    stepKey: payload.stepKey,
    epoch: payload.epoch,
  },
});
```

`notifyTruncate()` does not delete source or outbox rows. It records one ordered control for the
outbox planner. It is not a UOW mutation operation and does not compile into its own SQL statement.

`match` is the public client-side predicate. It is not used to select server rows; physical deletion
is determined by the rows retrieved through `withOutboxMutations()`.

## Workflow integration

```ts
onWorkflowStepEmissionsCleanup: defineHook(async function (payload) {
  await this.handlerTx()
    .retrieve(({ forSchema }) =>
      forSchema(workflowsSchema).find("workflow_step_emission", (b) =>
        b
          .whereIndex(
            "idx_workflow_step_emission_instance_step_epoch_createdAt_sequence_id",
            (eb) =>
              eb.and(
                eb("instanceRef", "=", payload.instanceRef),
                eb("stepKey", "=", payload.stepKey),
                eb("epoch", "=", payload.epoch),
              ),
          )
          .withOutboxMutations(),
      ),
    )
    .mutate(({ forSchema, retrieveResult: [rows] }) => {
      const workflows = forSchema(workflowsSchema);
      for (const row of rows) {
        workflows.delete("workflow_step_emission", row.id, (b) => b.check().omitOutbox());

        for (const mutation of row.$outboxMutations) {
          workflows.outbox.deleteMutation(mutation.id);
        }
      }

      if (rows.length > 0) {
        workflows.outbox.notifyTruncate("workflow_step_emission", {
          match: {
            instanceRef: payload.instanceRef,
            stepKey: payload.stepKey,
            epoch: payload.epoch,
          },
        });
      }
    })
    .execute();
});
```

All physical writes occur in the normal mutation transaction:

- checked source-row deletes;
- deletes of retrieved `fragno_db_outbox_mutations` rows;
- insertion of the normalized truncate control and its parent entry.

## `withOutboxMutations()` implementation

`withOutboxMutations()` remains part of the existing `find` retrieval operation. It adds a special
query-tree child equivalent to:

```sql
LEFT JOIN fragno_db_outbox_mutations AS outbox_mutation
  ON outbox_mutation.schema = :effectiveSourceNamespace
 AND outbox_mutation.table = :sourceTable
 AND outbox_mutation.externalId = source.:externalIdColumn
```

The join uses the existing `idx_outbox_mutations_key(schema, table, externalId, entryVersionstamp)`
index. The source external ID column is resolved through `table.getIdColumn()` rather than assumed
to be named `id`.

This must not expose general cross-schema joins. Only `withOutboxMutations()` can create this child,
and its schema, table, predicate, index, alias, and selected columns are fixed by Fragno.

The compiled query-tree child carries its own schema and namespace so the generic SQL and in-memory
query engines can resolve `internalSchema` independently from the root source schema. The existing
query compilers generate the join; no adapter contains hand-written truncation SQL.

## Outbox protocol

Use one ordered public operation stream:

```ts
type OutboxOperation = OutboxMutation | OutboxTruncateNotification;

type OutboxTruncateNotification = {
  op: "truncate";
  schema: string;
  table: string;
  match: Record<string, unknown>;
  versionstamp: string;
};

type OutboxPayload = {
  version: 2;
  operations: OutboxOperation[];
};
```

The notification's own `versionstamp` is the barrier: clients discard matching outbox-derived state
at or before that versionstamp. Later matching mutations remain valid.

`notifyTruncate()` appends the notification after ordinary operations in the same UOW. Identical
notifications registered in one UOW are deduplicated.

The normalized internal table continues to store the ordered operation payload. For non-row
controls, `externalId` becomes nullable and is stored as `null`; ordinary row mutations continue
storing their source external ID. The existing lookup index remains usable for row mutations.

## Outbox planning and execution

1. Build normal outbox mutations from UOW mutation operations.
2. Skip operations marked `omitOutbox()` and all mutations against `internalSchema`.
3. Append registered truncate notifications to the outbox plan.
4. Reserve the outbox entry version before executing the mutation batch.
5. Execute all ordinary source and internal `delete()` operations.
6. Materialize operation versionstamps and insert normalized outbox operation rows.
7. Insert the unchanged `fragno_db_outbox` parent header.
8. Commit everything atomically.

The cleanup never deletes or rewrites a `fragno_db_outbox` parent row.

## Concurrency

Each source deletion uses `check()`. If another transaction mutates a source row and creates a new
outbox mutation after retrieval, the source version changes and the cleanup mutation conflicts. The
handler transaction retries, reruns the source query and `withOutboxMutations()` join, and retrieves
the new normalized mutation row before deleting.

Internal outbox-row deletes do not require version checking. They are implementation data selected
for physical removal; a missing row can be treated as already removed.

A concurrent outbox reader observes either the historical mutation rows or their removal plus the
ordered truncate notification, because deletion and notification insertion share one mutation
transaction.

## Cost model

The retrieval is one indexed source query with an indexed system join.

The mutation phase uses existing ID-based UOW deletes, so physical execution scales with the number
of source rows plus the number of historical normalized mutation rows. This deliberately gives up
the earlier constant-number-of-database-operations goal in exchange for using only existing UOW
operations and generated adapter queries.

## Lofi support

When Lofi receives a truncate notification in outbox order, it must:

- find matching active ephemeral streams using the existing stream key derived from `match`;
- remove matching buffered operations at or before the notification versionstamp;
- close matching active streams;
- reset ephemeral accumulators and replay remaining active buffers, since reducers are not assumed
  to be reversible;
- refresh durable queries so persisted workflow state replaces discarded transient state;
- advance the safe persisted cursor atomically with notification handling.

## TanStack DB adapter support

When a collection targets the notification's schema and table, the adapter must:

- identify currently materialized rows matching `match`;
- emit local deletes for those rows;
- update the Fragno checkpoint to the notification versionstamp;
- perform the deletes and checkpoint update in one `begin`/`commit` transaction.

Collection-wide `controls.truncate()` is only valid when the notification covers the entire
collection. Partial workflow scopes must not clear unrelated rows. If direct collection inspection
is unavailable, the adapter may maintain adapter-owned row metadata; source schemas remain
unchanged.

## Verification

- `withOutboxMutations()` returns zero, one, and multiple mutation IDs per source row.
- The join uses the effective namespace, logical table name, source external-ID column, and existing
  outbox key index.
- Only IDs are returned; normalized payloads are not loaded into the hook.
- Source rows and every returned normalized mutation row are deleted through ordinary UOW `delete()`
  operations.
- Source deletes are version-checked and omitted from ordinary outbox mutation generation.
- Exactly one truncate notification is emitted for the cleanup scope.
- `fragno_db_outbox` parent rows are never deleted or rewritten.
- Mixed parent entries retain unrelated normalized operations and references.
- Empty parent entries reconstruct as empty operation batches and still advance cursors.
- A client that consumed 20 of 100 emissions receives the notification, clears partial state, and
  advances.
- A fresh client receives none of the removed payloads and safely processes the notification.
- Mutations after the notification versionstamp remain valid.
- A concurrent source mutation forces a retry and is included in the retried join.
- SQL and in-memory adapters behave equivalently.
- Lofi polling/streaming and the TanStack DB adapter apply deletion and checkpoint changes
  atomically.
