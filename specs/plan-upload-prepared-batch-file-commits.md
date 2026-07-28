# Plan: Prepared Uploads and Atomic Batch File Commits

## Goal

Add the smallest Upload fragment primitive that lets a caller prepare several physical objects and
then publish their logical `file` rows in one atomic database transaction.

The immediate consumer is Marketplace artifact publication and ingestion. Ingestion must be able to
validate all known destination preconditions and either switch every affected logical file pointer,
or switch none of them.

The implementation should reuse the existing Upload fragment infrastructure:

- the `upload` table as the durable record for a physical upload;
- the `file` table as the authoritative logical file projection;
- fresh versioned `objectKey` values for every physical write;
- existing `StorageAdapter` upload, finalize, download, and delete operations;
- existing upload-session routes for proxy, direct-single, and direct-multipart strategies;
- existing file write preconditions and file row revisions;
- existing durable hooks for storage cleanup, file-ready notifications, and text indexing;
- existing upload expiration and abort behavior.

No storage adapter should need multi-object transactions or multi-key compare-and-swap support. S3,
R2, filesystem, and database storage continue to store each physical object independently. Atomic
visibility comes from changing multiple `file.objectKey` pointers in one Upload database
transaction.

## Non-goals

This first implementation does not:

- add transactions to `StorageAdapter`;
- add a second physical-object inventory table;
- replace the existing immediate single-file upload APIs;
- make physical object creation atomic;
- atomically commit state across Upload and Automations databases;
- add Marketplace-specific concepts to the Upload fragment;
- add conditional file deletion to the first batch API;
- add rollback by rewriting already-published file pointers;
- make directory-marker creation atomic with the file batch;
- solve every possible pair of concurrent Marketplace installations.

Prepared objects may exist without being visible through `file`. Existing expiration and cleanup
infrastructure must eventually remove abandoned prepared objects.

## Current model

### `file` is the logical file

A `file` row is uniquely addressed by `(provider, key)` and contains the current metadata and
physical pointer:

```text
file(provider, key).objectKey -> physical storage object
```

Readers first resolve the `file` row and then pass `file.objectKey` to the configured storage
adapter. The file row revision is `file.id.version` and is already exposed by `GET /files/by-key`.

### `upload` is the physical upload lifecycle

An `upload` row already records everything required to publish a prepared object:

- provider and logical file key;
- physical `objectKey`;
- uploader and file metadata;
- expected and completed size;
- checksum;
- storage strategy and multipart state;
- expiration;
- lifecycle status.

The existing upload-session routes create this row before or during physical storage I/O. They are
therefore the right infrastructure for durable prepared writes.

### `storage_object` is only the database storage implementation

The database storage adapter stores physical bytes in `storage_object` and resolves them through:

```text
file.objectKey == storage_object.storageKey
```

S3, R2, and filesystem adapters store the same `objectKey` outside the Upload database. The batch
commit design must therefore operate on `upload` and `file`, not directly on `storage_object`.

### Immediate completion currently combines two meanings

`markUploadCompleteFromSnapshot` currently:

1. marks an `upload` as completed;
2. creates or replaces the logical `file` row;
3. triggers old-object cleanup;
4. triggers file-ready and text-index hooks.

Prepared uploads require these two state transitions to become separately expressible while keeping
the existing immediate path intact.

## Core design

Introduce one additional upload lifecycle state and one atomic batch commit operation.

```text
created/in_progress
        |
        | physical upload finalized
        v
     prepared
        |
        | atomic batch file commit
        v
     completed
```

A prepared upload has complete physical bytes but is not yet authoritative for its logical file key.
A completed upload has been published through a `file` row.

The database schema already stores upload status as a string, so adding `"prepared"` does not
require a new column or table migration. Runtime schemas and TypeScript unions still need to be
updated.

## Public contracts

### Prepared upload result

Add a canonical result shape:

```ts
type PreparedFileWrite = {
  uploadId: string;
  provider: string;
  fileKey: string;
  objectKey: string;
  sizeBytes: number;
  contentType: string;
  checksum: UploadChecksum | null;
  expiresAt: string;
};
```

`uploadId` is the public identity used by batch commit. `objectKey` may be returned for diagnostics,
but callers must not be allowed to substitute a different object key during commit.

### Batch entries

The first batch API needs writes and read-only assertions:

```ts
type PreparedFileBatchEntry =
  | {
      kind: "write";
      uploadId: string;
      precondition: UploadFileWritePrecondition;
    }
  | {
      kind: "assert";
      provider: string;
      fileKey: string;
      precondition: UploadFileWritePrecondition;
    };
```

A write publishes a prepared upload. An assertion validates a file row in the same transaction but
does not mutate it.

Assertions are necessary for files that required no write during planning. Without them, another
file can change after planning, the batch can commit its changed files, and post-commit verification
can still discover a mixed workspace.

The first implementation should reuse the existing precondition variants:

```ts
type UploadFileWritePrecondition = { kind: "absent" } | { kind: "revision"; revision: number };
```

Conditional deletion can later become another entry variant without changing the prepared-write
model.

### Batch commit result

Return the committed logical snapshots in input order for write entries:

```ts
type PreparedFileBatchCommitResult = {
  files: Array<FileMetadata & { revision: number }>;
};
```

The route should use the same serializer and revision meaning as `GET /files/by-key`.

## Route changes

### Reuse the upload-session routes

Do not create a parallel storage-upload protocol. Extend the existing completion routes so callers
can request prepared completion.

Affected routes:

- `POST /uploads/:uploadId/complete`
- `PUT /uploads/:uploadId/content`

Add an explicit completion mode with immediate completion as the default:

```ts
type UploadCompletionMode = "immediate" | "prepared";
```

Suggested request shapes:

- `POST /uploads/:uploadId/complete`: optional `completionMode` in the existing JSON body;
- `PUT /uploads/:uploadId/content`: optional `completionMode` query parameter.

Omitting the value preserves current behavior and response handling. Prepared completion returns a
`PreparedFileWrite` instead of file metadata. The route output schema may be a union while retaining
the existing immediate response unchanged.

The existing `POST /files` route remains an immediate one-request convenience API. It does not need
to support batching in the first implementation.

### Add one batch commit route

Add:

```text
POST /files/commit-prepared
```

Input:

```ts
{
  entries: PreparedFileBatchEntry[];
}
```

Requirements:

- reject an empty batch;
- impose an explicit upper bound;
- support at least the maximum Marketplace artifact size, or reduce that maximum deliberately;
- reject duplicate upload IDs;
- reject duplicate logical `(provider, fileKey)` write destinations;
- validate all input with Zod before entering services;
- map precondition failures through the existing `FILE_PRECONDITION_FAILED` code and HTTP 412;
- preserve storage and upload state errors as stable error codes.

No route should accept an arbitrary `objectKey` for publication. The service resolves the object key
from the persisted upload row.

## Service changes

### Extract the existing file publication rules

`createCompletedUpload` and `markUploadCompleteFromSnapshot` currently duplicate substantial file
construction and replacement behavior. Extract reusable semantic operations for:

- constructing the completed `file` record from an upload snapshot;
- validating a file write precondition;
- creating or updating a file row;
- deciding whether an old physical object needs cleanup;
- building file-ready and cleanup hook payloads.

The extraction must serve the existing immediate paths and the new batch path. Do not introduce a
generic repository wrapper or abstraction that is only used by the new route.

### Mark an upload prepared

Add a service operation equivalent to:

```ts
markUploadPreparedFromSnapshot(upload, options?): TxResult<PreparedFileWrite, PreparedFileWrite>
```

It should:

1. require the upload to still be active and unexpired;
2. use the finalized size when provided;
3. update the upload status to `prepared`;
4. set `bytesUploaded`, `updatedAt`, and `completedAt`;
5. not read or mutate `file`;
6. not trigger `onFileReady`, text indexing, or superseded-object cleanup;
7. return the persisted prepared upload identity.

`completedAt` continues to mean physical upload completion time. The status distinguishes whether
the object has been published as a logical file.

### Atomically commit prepared uploads

Add a service operation equivalent to:

```ts
commitPreparedFileWrites(input): TxResult<PreparedFileBatchCommitResult, ...>
```

The operation must use one `serviceTx(uploadSchema)` and read every required row before mutating.

Retrieval phase:

1. Load every referenced upload by primary ID.
2. Load every current file row addressed by a write or assertion.
3. Keep all reads inside the same Upload transaction snapshot.
4. Use the existing primary and `(provider, key)` indexes; add no new table or index unless the
   current Unit of Work cannot express the bounded reads in one round-trip.

Validation phase:

1. Every write upload exists.
2. Every write upload is `prepared`, or is already `completed` and idempotently published.
3. Every prepared upload is unexpired.
4. The persisted upload owns the provider and file key being committed.
5. No two writes target the same logical file.
6. Every write and assertion precondition matches its current file row.
7. A replacement uses a distinct physical object key.
8. A completed upload is accepted idempotently only when the current file row already points to its
   persisted object key.
9. A mixture of unexpectedly completed and prepared entries is rejected unless every completed entry
   is already published exactly as requested.

Mutation phase, only after every validation succeeds:

1. Create or update every write entry's `file` row.
2. Update every corresponding upload from `prepared` to `completed`.
3. Trigger `cleanupStorageObject` for each superseded ready file.
4. Trigger `onFileReady` and `onFileTextIndexRequested` for each committed file.
5. Return the new file snapshots and revisions.

The transaction must not mutate one entry and then discover a validation failure in another entry.
All validation decisions are derived before scheduling mutations.

### Unique-create retries

For absent writes, retain the existing unique-conflict retry behavior on `(provider, key)`. A retry
must reload the complete batch and re-evaluate every original precondition. It must not downgrade a
conflict into a partial success.

### Idempotent replay

A repeated batch commit after a lost response should return success when every write upload is
completed and every corresponding file points to that upload's object key.

It must not:

- create another physical object;
- increment file revisions again;
- enqueue duplicate cleanup or file-ready effects;
- require the caller to reconstruct the old file snapshots.

The existing upload IDs are the idempotency identities.

## Expiration, abort, and cleanup

### Reuse the existing timeout hook

The upload creation path already schedules `onUploadTimeout` at `expiresAt`. Extend timeout handling
for `prepared` uploads:

1. atomically change an expired prepared upload to `expired`;
2. trigger the existing `cleanupStorageObject` hook with its persisted object key;
3. let that cleanup hook retry storage deletion independently;
4. optionally call the existing `onUploadFailed` callback with `UPLOAD_EXPIRED`.

Do not delete the object before claiming the prepared upload as expired. Otherwise a concurrent
batch commit could publish an object that the timeout handler has already deleted.

### Reuse the existing abort route

Extend `POST /uploads/:uploadId/abort` to accept `prepared` uploads:

1. atomically mark the upload aborted;
2. trigger `cleanupStorageObject` for the prepared physical object;
3. preserve existing multipart-abort behavior for uploads that have not completed physical upload.

Storage deletion remains idempotent and retryable through the existing durable hook.

### Batch commit failure

A precondition failure leaves prepared uploads intact until:

- the caller retries the same batch;
- the caller aborts them;
- their existing expiration expires them and queues cleanup.

This is deliberate. Deleting them immediately would make a replay-safe workflow rebuild every
physical object after a transient or lost-response failure.

## Backoffice Upload filesystem integration

The Marketplace workflows should not know about upload-session route details. Extend the
Upload-backed filesystem with a narrow prepared-write API while retaining `writeFile` and
`writeFileConditional` unchanged.

Suggested contract:

```ts
interface UploadFileSystem extends IFileSystem {
  writeFileConditional(...): Promise<void>;
  prepareFileWriteConditional(
    path: string,
    content: FileContent,
    options: WriteFileOptions & {
      precondition: UploadFileWritePrecondition;
    },
  ): Promise<PreparedFileWrite>;
  commitPreparedFileWrites(input: {
    writes: Array<{
      prepared: PreparedFileWrite;
      precondition: UploadFileWritePrecondition;
    }>;
    assertions?: Array<{
      path: string;
      precondition: UploadFileWritePrecondition;
    }>;
  }): Promise<Array<UploadFileSnapshot>>;
  abortPreparedFileWrite(prepared: PreparedFileWrite): Promise<void>;
}
```

The concrete names may be shortened during implementation, but the responsibilities should remain
separate and explicit.

### Reuse existing filesystem behavior

`prepareFileWriteConditional` should reuse the existing Upload filesystem logic for:

- mount-point and file-key resolution;
- permission checks;
- parent-directory checks;
- directory-marker creation;
- byte conversion;
- checksum generation;
- content type resolution;
- filesystem metadata preservation;
- provider binding;
- Upload object routing.

The only behavioral difference is that it uses the existing upload-session protocol and requests
prepared completion instead of immediately changing the logical file row.

### Metadata and mode

Prepared upload metadata must already contain the metadata intended for the committed file. The
batch commit cannot be followed by a required `chmod`, because that would reintroduce a failure
after the atomic file switch.

For Marketplace ingestion:

- newly created files receive the source mode in `__docsFs` metadata when one exists;
- replacement files preserve the current destination filesystem metadata;
- source content type is set before preparation;
- no mandatory metadata mutation occurs after batch commit.

Directory markers may still be created before the batch commits. They are not executable artifact
files and are an accepted non-atomic side effect for the minimal implementation.

## Preconditions and assertions

The Upload fragment remains responsible only for logical Upload rows. Backoffice filesystem
permissions remain in the Backoffice filesystem adapter.

Before preparing bytes, the filesystem adapter should perform the same permission and parent checks
used by immediate writes. The batch transaction provides the final file-row concurrency boundary.

The caller should include assertions for every target file whose state influenced planning, even if
that file does not require a write. For Marketplace ingestion this includes:

- files already matching the requested source;
- files used to prove that an update is still based on the installed version;
- relevant directory-marker rows when their revision is part of the permission decision and the
  adapter can represent them cleanly.

A batch assertion does not reserve or lock a file. It guarantees only that all asserted state and
all writes are evaluated against one commit-time database snapshot.

## Error model

Reuse existing stable errors wherever possible:

- `FILE_PRECONDITION_FAILED` for write or assertion mismatches;
- `FILE_NOT_FOUND` only where an operation requires an existing file independently of a
  precondition;
- `UPLOAD_NOT_FOUND` for unknown upload IDs;
- `UPLOAD_INVALID_STATE` for active, failed, aborted, expired, or otherwise uncommittable uploads;
- `UPLOAD_EXPIRED` for expired prepared uploads;
- `STORAGE_ERROR` for physical storage failures.

Do not branch on error messages. If the batch route needs to identify the failing entry, extend
`UploadServiceError` with structured details such as `uploadId`, `provider`, and `fileKey` while
keeping the code stable.

The route should return one failure for the batch and never a mixed success result.

## Security and authorization

Prepared upload IDs are capabilities only within the existing authenticated Upload boundary. Batch
commit must still validate persisted provider and file key data rather than trusting values supplied
by the caller.

The Backoffice filesystem adapter remains responsible for actor and filesystem permission checks.
Marketplace workflows continue to use their already-authorized Upload object and destination scope.

Prepared completion must not expose a generic way to publish an upload into a different provider or
file key than the upload row owns.

## Testing plan

### Upload service tests

Add focused service tests for:

- preparing an upload without creating or changing a file row;
- committing several prepared uploads in one transaction;
- asserting unchanged files alongside writes;
- one failed precondition leaving every file row unchanged;
- a unique create race retrying and then failing the original absence precondition;
- replacing several files and queuing cleanup for every superseded object;
- idempotent replay after a successful commit;
- rejecting duplicate upload IDs and duplicate destinations;
- rejecting expired, failed, aborted, and active uploads;
- rejecting a prepared upload whose persisted destination does not match the requested operation;
- ensuring file-ready and text-index hooks are emitted only after batch commit.

### Route tests

Cover proxy and at least one direct upload strategy:

- prepare through `PUT /uploads/:uploadId/content`;
- prepare through `POST /uploads/:uploadId/complete`;
- immediate completion remains backwards compatible;
- batch commit returns file revisions;
- batch precondition failure returns HTTP 412 and `FILE_PRECONDITION_FAILED`;
- prepared upload abort queues physical cleanup;
- prepared upload expiration queues physical cleanup.

### Storage adapter contract tests

No new storage adapter method is expected. Existing adapter contract tests should prove that each
upload receives a distinct physical object key and that deleting an abandoned prepared object does
not affect the currently published file object.

### Backoffice filesystem tests

Add tests proving:

- preparation performs the same path and permission checks as immediate writes;
- preparation does not make the new content visible;
- committing several prepared writes makes all new content visible together;
- a failed assertion leaves all old content visible;
- source mode is present immediately after commit without a follow-up `chmod`;
- aborting a prepared write leaves the current file unchanged.

### Concurrency tests

Use two prepared batches based on the same file revisions:

1. commit one batch;
2. attempt the second batch;
3. assert the second batch fails completely;
4. assert no file points to an object from the rejected batch.

Also test a lost batch-commit response followed by an identical retry.

## Implementation sequence

1. Add `prepared` to Upload status types and route schemas.
2. Extract shared file-record construction and publication logic from the two existing completion
   services without changing behavior.
3. Add prepared completion to existing upload-session completion routes.
4. Add prepared upload timeout and abort cleanup by reusing `cleanupStorageObject`.
5. Add write/assert batch input schemas and the atomic batch commit service.
6. Add `POST /files/commit-prepared`.
7. Add Upload service, route, expiration, abort, and replay tests.
8. Add prepared-write methods to the Backoffice Upload filesystem by reusing its existing path,
   permission, metadata, checksum, and route-calling logic.
9. Add Backoffice filesystem tests.
10. Rewrite the two Marketplace workflows to use prepared uploads and atomic batch commit.

## Rewrite the Marketplace workflows

This is the final step of the plan. Do not rewrite the workflows until the Upload primitive and its
filesystem adapter are independently tested.

### Rewrite `marketplace-publish`

Update `apps/backoffice/app/fragno/automation/marketplace-publish-workflow.ts`:

1. Keep the durable static-entry snapshot.
2. Keep draft listing/version reservation.
3. Prepare each artifact file under its existing version directory using stable, deterministic
   per-file workflow step names.
4. Persist each `PreparedFileWrite` as the corresponding step result.
5. Use expected-absence preconditions for the new version directory.
6. Commit all prepared artifact files in one batch step.
7. Treat an already-committed identical batch as success on replay.
8. Publish the Marketplace version only after the Upload batch commit succeeds.
9. Keep the Marketplace publication call idempotent as it is today.
10. Remove the old loop that makes every artifact file visible independently through immediate
    `writeFile` calls.

A failure before batch commit leaves the published Marketplace version unchanged and leaves only
invisible prepared objects, which expiration can clean. A failure after batch commit but before
Marketplace publication leaves an internal artifact directory ready for the idempotent publication
retry.

### Rewrite `marketplace-ingest`

Update `apps/backoffice/app/fragno/automation/marketplace-ingest-workflow.ts`:

1. Keep installed-version and published-artifact resolution.
2. Keep bounded source listing and stable path ordering.
3. Keep source checksum and size verification.
4. Expand planning to retain the target revision for every file whose state influences the decision,
   including no-op files.
5. Build batch assertions for no-op and otherwise observed target files.
6. Prepare every required destination write without changing any destination `file` pointer.
7. Put source content type and final filesystem metadata, including source mode for new files, into
   the prepared upload before commit.
8. Persist every prepared upload ID in durable step results.
9. Atomically commit all prepared writes and assertions in one Upload batch step.
10. If any precondition fails, report the workspace conflict with no destination file pointer
    changed by that batch.
11. Remove the per-file immediate conditional-write loop.
12. Remove required post-write `chmod`; metadata must be final at commit time.
13. Keep post-commit verification as a defensive integrity check rather than as the operation that
    discovers predictable precondition failures.
14. Record `marketplace_ingestion` only after the Upload batch commit and verification succeed.
15. Preserve the existing Automations ingestion-state compare-and-swap so a stale workflow cannot
    replace a newer recorded version.

The Upload transaction provides atomic visibility for the files and assertions included in one
batch. The Automations ingestion record remains a later transaction in a different Durable Object;
that cross-object boundary is explicitly outside this minimal Upload change.
