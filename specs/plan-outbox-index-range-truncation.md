# Outbox indexed-range truncation plan

## Goal

Allow a fragment to compact historical outbox mutations for an existing indexed source range,
without changing the fragment schema or passing a list of row IDs. Emit an ordered control item so
partially caught-up clients can discard incomplete state safely.

Initial use case: `onWorkflowStepEmissionsCleanup` truncates `workflow_step_emission` rows selected
by `(instanceRef, stepKey, epoch)`.

## Constraints

- Outbox support remains additive; source schemas require no outbox-specific columns or metadata.
- Selection must reuse an existing index and be limited to an equality prefix for predictable cost.
- The call site is constant-sized. Physical reclamation remains proportional to the removed data but
  runs as indexed database work rather than an application-built target list.
- Source deletion, historical outbox compaction, and the control item commit atomically.
- Mixed outbox entries retain unrelated mutations.

## Protocol

Add an ordered outbox control alongside mutations:

```ts
type OutboxTruncateControl = {
  type: "truncate";
  target: {
    schema: string;
    table: string;
    match: Record<string, unknown>;
  };
  throughVersionstamp: string;
};
```

The executor materializes `throughVersionstamp`. Its meaning is: discard matching outbox-derived
state at or before this versionstamp; later matching mutations remain valid.

## Server flow

1. Define an indexed range using the existing
   `idx_workflow_step_emission_instance_step_epoch_createdAt_sequence_id` index and its first three
   columns.
2. Resolve matching historical outbox mutations using the source range plus the existing
   `(schema, table, externalId, entryVersionstamp)` outbox mutation index.
3. Remove those mutations from outbox storage, rewriting mixed entries or deleting empty entries.
4. Suppress ordinary outbox delete mutations covered by the truncation.
5. Append the truncate control after the removed history and delete the source rows in the same
   transaction.

Internal outbox storage may be normalized further to make range compaction cheaper, but this must
not affect fragment schemas or the public selection API.

## API shape options

### Option A: explicit indexed range

```ts
outbox.truncateByIndex({
  schema: workflowsSchema,
  table: "workflow_step_emission",
  index: "idx_workflow_step_emission_instance_step_epoch_createdAt_sequence_id",
  prefix: {
    instanceRef: payload.instanceRef,
    stepKey: payload.stepKey,
    epoch: payload.epoch,
  },
});
```

Most explicit and easiest to validate independently.

### Option B: reusable range handle — preferred

```ts
const emissions = workflows.indexRange(
  "workflow_step_emission",
  "idx_workflow_step_emission_instance_step_epoch_createdAt_sequence_id",
  {
    instanceRef: payload.instanceRef,
    stepKey: payload.stepKey,
    epoch: payload.epoch,
  },
);

workflows.deleteRange(emissions);
outbox.truncate(emissions);
```

Source deletion and outbox truncation cannot accidentally use different predicates.

### Option C: restricted query builder

```ts
outbox.truncate(
  workflows.find("workflow_step_emission", (builder) =>
    builder.whereIndex(
      "idx_workflow_step_emission_instance_step_epoch_createdAt_sequence_id",
      (eb) =>
        eb.and(
          eb("instanceRef", "=", payload.instanceRef),
          eb("stepKey", "=", payload.stepKey),
          eb("epoch", "=", payload.epoch),
        ),
    ),
  ),
);
```

Familiar API, but must reject pagination, ordering, joins, and non-prefix/non-equality conditions.

## Workflow integration

Update `onWorkflowStepEmissionsCleanup` in `packages/fragment-workflows/src/definition.ts` to delete
and truncate the same indexed range. The hook payload already contains every required prefix value.

## Lofi support

- Decode truncate controls in outbox order.
- Remove matching mutations through the barrier from active ephemeral replay buffers.
- Close matching active streams and recalculate the safe persisted checkpoint.
- Reset ephemeral accumulators and rebuild them from the remaining replay buffers; reducers are not
  assumed to be reversible.
- Refresh durable queries so persisted workflow steps replace discarded transient state.
- Advance the cursor through the control atomically with its client-side handling.

## TanStack DB adapter support

- Decode controls separately from row mutations.
- For a collection targeting the control's schema/table, remove currently materialized rows whose
  values match the control predicate.
- Apply matching deletes and update the Fragno checkpoint in one `begin`/`commit` transaction.
- Use `controls.truncate()` only when the control covers the entire collection; partial indexed
  ranges must not clear unrelated active streams.
- If direct collection iteration is insufficient, maintain adapter-owned row metadata/indexing for
  the fields used by received truncate controls. This remains client-adapter state, not source
  schema metadata.

## Verification

- Efficient indexed truncation with zero, one, and many matching emissions.
- Mixed outbox entries preserve unrelated mutations and references.
- A client consuming 20 of 100 emissions receives the barrier, clears partial state, and advances.
- A fresh client after cleanup receives no removed payloads and safely processes the barrier.
- Mutations after `throughVersionstamp` are retained.
- Concurrent outbox reads observe either pre-truncation history or post-truncation history plus the
  barrier.
- Equivalent behavior for SQL and in-memory database adapters, Lofi polling/streaming, and the
  TanStack DB adapter.
