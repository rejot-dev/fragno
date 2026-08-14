# Plan: Server-side Upload batch edits

## Goal

Replace the current client-side edit planning flow with one Upload fragment operation that receives
edit operations, reads the affected files efficiently, computes their final contents on the server,
stages fresh storage objects, and atomically attempts to publish every changed file.

The caller should ask Upload to **do the edits**. There is no public edit-plan object, no
`planEdits`, and no `applyEditPlan` protocol.

```ts
await upload.applyEdits({
  provider,
  edits: [
    {
      kind: "replace",
      fileKey: "src/config.ts",
      search: "enabled = false",
      replacement: "enabled = true",
    },
    {
      kind: "writeJson",
      fileKey: "generated/config.json",
      value: { enabled: true },
      options: { spaces: 2 },
    },
  ],
});
```

The endpoint owns the complete retrieve → storage I/O → prepared-upload persistence → atomic commit
flow. A concurrent file change must make the whole mutation fail without publishing any edited file.
The final publication step reuses the existing `commitPreparedFileWrites` service.

## Non-goals

This implementation does not:

- persist or expose edit plans;
- accept a client-computed revision or storage object key;
- expose `dryRun` or `rollbackOnError` options;
- add transactional semantics to `StorageAdapter`;
- support deletes, renames, directory operations, or binary transformations;
- permit edits across multiple providers in one request;
- make storage-object creation atomic with the database transaction;
- introduce a generic filesystem API into Upload.

Atomicity applies to logical Upload `file` rows. Physical objects are staged and represented by
existing prepared `upload` rows before the final database transaction. Failed commits reuse the
existing abort, expiration, and durable cleanup lifecycle.

## Public contract

### Edit operations

Define the contract once in a browser-safe module owned by Upload, for example
`packages/fragment-upload/src/file-edits.ts`:

```ts
type FileEditSearchOptions = {
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  maxMatches?: number;
};

type FileEditOperation =
  | {
      kind: "write";
      fileKey: string;
      content: string;
    }
  | {
      kind: "replace";
      fileKey: string;
      search: string;
      replacement: string;
      options?: FileEditSearchOptions;
    }
  | {
      kind: "writeJson";
      fileKey: string;
      value: unknown;
      options?: { spaces?: number };
    };
```

Do not call these `StateEditInstruction` or `UploadEditPlan` entries. They are immediate Upload file
edit operations.

`contextBefore` and `contextAfter` do not affect replacement and therefore do not belong in this
contract. Add them only if a future result exposes search context.

### Route

Add:

```text
POST /files/apply-edits
```

Input:

```ts
type ApplyFileEditsInput = {
  provider: string;
  edits: FileEditOperation[];
};
```

Requirements:

- reject an empty edit list;
- impose explicit limits on operation count, unique file count, input text bytes, output text bytes,
  and diff lines;
- validate every file key with the existing file-key boundary;
- reject duplicate provider fields by having one provider at the request root;
- preserve input order for operation results;
- allow several operations for the same file and apply them sequentially;
- collapse each affected file to one final logical mutation;
- require the configured storage adapter to support server-side reads when an operation needs
  existing content and server-side `writeStream` for changed output;
- return `STORAGE_ERROR` when those capabilities are unavailable.

### Result

Return operation-oriented results without returning the submitted operation itself:

```ts
type AppliedFileEdit = {
  fileKey: string;
  changed: boolean;
  content: string;
  diff: string;
};

type ApplyFileEditsResult = {
  edits: AppliedFileEdit[];
  totalChanged: number;
};
```

Each result describes the state immediately after that operation. If several operations target the
same file, each result uses the previous operation's output as its input. `totalChanged` counts
unique files whose final content differs from the initially retrieved content, matching the number
of logical file mutations.

The route returns success only after the final database transaction commits. On failure it returns
one batch error and no mixed result.

## Edit semantics

Port the relevant MIT-licensed semantic helpers from Cloudflare Agents'
`packages/shell/src/helpers.ts` into the Upload package rather than importing across repositories.
Preserve the upstream MIT attribution in the adapted source:

- `replaceTextContent`;
- `createTextMatcher` and `escapeRegExp`;
- `stringifyJsonFileContent`;
- `diffContent`;
- `unifiedDiff`, Myers diff, and unified-diff formatting.

Preserve the shell behavior deliberately:

- search strings must not be empty;
- replacement is global unless bounded by `maxMatches`;
- replacement text is literal, including for regex searches;
- matching is case-sensitive by default and becomes insensitive only when `caseSensitive === false`;
- `wholeWord` wraps the search expression;
- invalid regular expressions produce a stable invalid-request error;
- JSON defaults to two spaces and ends with a newline;
- JSON values that serialize to `undefined` are rejected;
- diffs are bounded to 10,000 lines per side;
- unchanged operations return an empty diff.

Move these helpers into a semantic module such as `packages/fragment-upload/src/file-edits.ts` and
test them directly. Do not retain the current client-only replacement and whole-file pseudo-diff
implementation.

## Efficient read graph

Before touching storage, normalize the request into an ordered edit program grouped by unique file
key.

For each file, derive whether its initial content is required:

- a leading `replace` requires the current content;
- a leading `write` or `writeJson` establishes content without downloading the old object;
- later operations consume the prior operation's in-memory output;
- metadata and the current revision are still required for every existing destination.

### First database transaction: retrieve snapshots

Use one `handlerTx()` to retrieve all current `file` rows for `(provider, fileKey)` in bounded
chunks. Multiple scheduled chunk queries remain one database round-trip through the Fragno
transaction builder.

The snapshot needed outside the transaction is:

```ts
type EditableFileSnapshot = {
  id: FragnoId;
  provider: string;
  fileKey: string;
  objectKey: string;
  status: FileStatus;
  filename: string;
  contentType: string;
  uploaderId: string | null;
  visibility: FileVisibility;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
};
```

The `FragnoId` carries the revision used by the final OCC check. Missing and deleted files are
represented as absent destinations.

Do not retrieve upload rows, text-index rows, or public lifecycle fields that the operation does not
use.

### Storage reads

Download only files whose edit program requires initial content. Use `file.objectKey` from the
retrieved snapshot and `storage.getDownloadStream` directly.

Run downloads with a fixed concurrency bound rather than sequentially or through unbounded
`Promise.all`. Enforce the aggregate input-byte limit while consuming responses. Reject:

- a required source file that is absent or deleted with `FILE_NOT_FOUND`;
- a non-successful storage response with `STORAGE_ERROR`;
- content exceeding request limits with `INVALID_REQUEST`;
- invalid UTF-8 according to one documented decoding policy.

A `write` or `writeJson` against a missing file is valid and requires no storage read.

## Compute final contents

Apply operations in request order against a per-file in-memory overlay:

```text
retrieved content or absent
  -> operation 1
  -> operation 2
  -> final file content
```

Produce each `AppliedFileEdit` while evaluating the program. Separately retain one final mutation
per changed file.

A file whose final content equals its initial content is a no-op even if intermediate operations
changed it. It must not receive a new storage object or file revision. Its original row must still
be asserted in the final transaction because its content influenced the returned operation results.

For missing files, an operation sequence that ends without producing content is impossible under the
initial operation set and needs no separate state.

## Stage changed objects as prepared uploads

After computation, stage one fresh physical object for each unique changed file and persist it
through the existing prepared-upload lifecycle.

For each changed file:

1. derive final metadata:
   - replacements preserve existing filename, content type, uploader, visibility, tags, and
     metadata;
   - writes to existing files preserve the same metadata in the minimal implementation;
   - new `writeJson` files use `application/json`;
   - other new writes use `text/plain` and the basename as filename;
2. call `storage.initUpload` with a fresh `buildStorageObjectVersionSegment()`;
3. require `storage.writeStream` and write the server-generated UTF-8 bytes to the returned storage
   key;
4. call `storage.finalizeUpload` when available;
5. retain the staged object key, final byte length, metadata, and expiration required to create the
   prepared upload row.

Use a fixed concurrency bound for staging. Do not call the public upload-session routes from inside
the route.

### Persist prepared uploads in one transaction

Add the smallest missing service primitive, for example:

```ts
services.createPreparedFileUploads({ files: stagedFiles });
```

It persists all successfully staged objects as `upload` rows in one transaction. Each row uses the
existing upload model and records:

```ts
{
  status: "prepared",
  publicationMode: "batch",
  strategy: "proxy",
  objectKey,
  bytesUploaded,
  completedAt,
  // provider, key, checksum, expiration, and final publication metadata
}
```

The service returns the canonical `PreparedFileWrite` values, especially their generated upload IDs.
It does not read or mutate `file` rows and does not trigger ready, indexing, or superseded-object
cleanup hooks.

This is a server-side batch equivalent of completing batch-mode proxy uploads. It is not a second
publication protocol.

### Failed staging cleanup

If storage staging fails before prepared upload rows are persisted, best-effort delete every object
staged by the request and return `STORAGE_ERROR`. Cleanup attempts must be bounded and use
`Promise.allSettled`.

Once prepared upload rows are persisted, reuse their existing lifecycle instead of eagerly deleting
objects:

- a failed commit leaves the uploads prepared;
- the route may explicitly abort them when the commit is known not to have succeeded;
- expiration and the existing cleanup hook remain the durable fallback;
- an ambiguous commit response can be resolved through the existing idempotent commit behavior.

There remains a crash window between physical object creation and prepared-row persistence. This is
the same class of pre-record storage orphan already present around upload initialization. Do not add
a separate edit-plan or staging table solely to close it in the minimal implementation.

## Reuse the existing atomic commit

Do not add `commitEditedFiles` or duplicate file-publication logic. Convert the server-derived
snapshots and prepared upload IDs into the existing `PreparedFileBatchEntry[]`, then call
`commitPreparedFileWrites`.

Changed files become writes:

```ts
{
  kind: "write",
  uploadId: preparedUpload.uploadId,
  precondition: originalFile
    ? { kind: "revision", revision: originalFile.id.version }
    : { kind: "absent" },
}
```

Unchanged files whose initial state or content influenced edit evaluation become assertions:

```ts
{
  kind: "assert",
  provider,
  fileKey,
  precondition: originalFile
    ? { kind: "revision", revision: originalFile.id.version }
    : { kind: "absent" },
}
```

This reuses the existing implementation for:

- bounded batch retrieval;
- revision and absence validation;
- `uow.check` and `uow.checkAbsent` OCC enforcement;
- duplicate destination rejection;
- atomic create/update of every logical `file` row;
- transition from `prepared` to `completed`;
- unique-create retries that re-evaluate the whole batch;
- idempotent replay after a lost response;
- `onFileReady` and `onFileTextIndexRequested` hooks;
- superseded-object cleanup hooks;
- stable Upload error codes and structured failure details.

The route must never accept client-supplied upload IDs, revisions, preconditions, or object keys.
They are derived entirely from the server's retrieval and staging work.

### Transaction boundaries

The endpoint deliberately uses three database boundaries:

1. retrieve all initial file snapshots;
2. persist all staged objects as prepared upload rows;
3. atomically publish those prepared uploads with `commitPreparedFileWrites`.

Storage reads and writes happen between the first and second boundaries. The third transaction is
the authoritative concurrency boundary: if any write or assertion precondition fails, no logical
file is published.

This is preferable to combining prepared-row creation and publication into a new transaction because
it keeps abandoned physical objects durably represented and reuses the existing abort, expiration,
cleanup, and replay semantics.

## Route orchestration

The route should read as the following explicit sequence:

```ts
const editProgram = parseAndGroupFileEdits(payload);
const snapshots = await retrieveEditableFileSnapshots(editProgram);
const initialContents = await downloadRequiredEditSources(editProgram, snapshots);
const evaluated = evaluateFileEdits(editProgram, snapshots, initialContents);
const stagedObjects = await stageChangedEditedFiles(evaluated.changedFiles);
const preparedUploads = await createPreparedFileUploadsOrCleanUp(stagedObjects);
const entries = buildPreparedEditBatchEntries(evaluated, preparedUploads);
await commitPreparedFileWritesOrAbort(entries, preparedUploads);
return json(serializeAppliedFileEdits(evaluated));
```

This is a deliberate Rules of Fragno exception:

```text
retrieve database snapshot
  -> storage reads and writes
  -> persist prepared uploads
  -> atomic prepared-upload commit
```

External storage work must not occur inside a database transaction.

## Client API

Expose one helper and framework store method corresponding to the route:

```ts
applyEdits(input: ApplyFileEditsInput): Promise<ApplyFileEditsResult>
```

The helper performs one JSON request to `POST /files/apply-edits`. It does not download files,
compute diffs, upload prepared objects, or call `/files/commit-prepared`.

Add a mutator such as `useApplyFileEdits` to `createUploadFragmentClients`, invalidating:

- `GET /files`;
- affected `GET /files/by-key` entries where practical.

Remove the current public client APIs and types:

- `planEdits`;
- `applyEditPlan`;
- the client-orchestrated `applyEdits` implementation;
- `UploadEditPlan`, `UploadPlannedEdit`, and `UploadPlannedFile`;
- client-side snapshot downloading and prepared-upload orchestration.

Keep `/files/commit-prepared` because it remains a useful lower-level primitive for workflows that
prepare objects durably across steps. The new endpoint is the efficient synchronous server-side
primitive for bounded text edits.

## Validation and limits

Define named constants beside the route/service contract. Initial values should be selected from
current backoffice workloads and storage limits, then covered by tests. At minimum bound:

- operations per request;
- unique files per request;
- search pattern length;
- replacement length;
- direct write content length;
- aggregate downloaded bytes;
- aggregate generated bytes;
- lines per diff;
- storage read concurrency;
- storage write concurrency.

Validate request-controlled JSON before any database or storage work. Validate generated byte totals
before staging objects.

## Error model

Reuse existing Upload error codes:

- `INVALID_REQUEST` for malformed operations, empty searches, invalid regexes, serialization
  failures, and exceeded edit limits;
- `FILE_NOT_FOUND` when replacement requires a missing file;
- `FILE_PRECONDITION_FAILED` when any retrieved file changes before commit;
- `PROVIDER_MISMATCH` for a provider inconsistent with the active storage adapter;
- `STORAGE_ERROR` for unsupported storage capabilities and failed storage I/O.

Extend structured error details with `provider`, `fileKey`, and operation index where useful. Do not
make callers inspect error messages.

## Tests

### Semantic helper tests

Add co-located tests for the ported MIT helpers:

- literal replacement;
- regex replacement with literal replacement text;
- default case-sensitive behavior and explicit insensitive behavior;
- whole-word matching;
- `maxMatches`;
- empty and invalid search patterns;
- zero-length regex progress;
- JSON spacing and trailing newline;
- unserializable JSON;
- focused unified diffs;
- diff line limit.

### Route E2E tests

Use `buildDatabaseFragmentsTest`, `createFragmentTestFetcher`, and a real filesystem storage
adapter. Cover:

- creating several files in one request;
- replacing several existing files in one request;
- sequential operations against one file with one final revision increment;
- mixed `write`, `replace`, and `writeJson` operations;
- no-op files receiving no new object or revision;
- a leading write avoiding an unnecessary storage download;
- preservation of existing metadata;
- one stale file causing the entire batch to fail;
- no file pointing to staged objects after a failed OCC commit;
- best-effort cleanup when staging fails before prepared rows are persisted;
- failed commits leaving durable prepared uploads eligible for abort or expiration cleanup;
- idempotent reuse of the existing prepared batch commit behavior;
- unavailable `getDownloadStream` and `writeStream` capabilities;
- request and byte limits;
- durable ready, text-index, and superseded-object cleanup hooks only after commit.

Add a concurrency test with an instrumented storage adapter:

1. retrieve two source files;
2. pause the edit request before final commit;
3. replace one source through the normal file API;
4. resume the edit request;
5. assert HTTP 412;
6. assert the concurrently changed file retains its new content;
7. assert the other file retains its old content.

### Client E2E test

Keep one thin client-to-fragment E2E test proving that the public helper sends one request and the
real endpoint mutates several files. Detailed transformation and transaction behavior belongs to the
semantic and route tests.

## Implementation sequence

1. Port and test the MIT edit and unified-diff helpers in a canonical Upload module.
2. Define Zod route schemas and public operation/result types without plan types.
3. Implement edit-program grouping and initial-content dependency analysis.
4. Implement the batched metadata retrieval transaction.
5. Implement bounded storage downloads and server-side edit evaluation.
6. Implement bounded staging of fresh storage objects and best-effort pre-persistence cleanup.
7. Add `createPreparedFileUploads` to persist all staged objects as prepared upload rows in one
   transaction.
8. Build server-derived write and assertion entries and reuse `commitPreparedFileWrites` unchanged
   where possible.
9. Add `POST /files/apply-edits` and stable error mapping.
10. Replace the client planning APIs with one thin `applyEdits` call and framework mutator.
11. Replace the current client-planning E2E tests with semantic, route, concurrency, and thin client
    E2E coverage.
12. Run Upload build, type checking, lint, tests, and the affected Backoffice test filters.

## Expected data flow

```text
caller operations
  -> POST /files/apply-edits
  -> validate and group by file key
  -> one DB retrieval round-trip for file snapshots
  -> bounded storage reads only where initial content is needed
  -> server-side edit evaluation and diffs
  -> bounded staging of one fresh object per changed file
  -> one DB transaction that persists prepared upload rows
  -> existing commitPreparedFileWrites transaction with server-derived writes and assertions
  -> durable ready/index/cleanup hooks
  -> operation results
```

The server is authoritative for the read snapshot, transformations, staged object identities,
preconditions, and atomic publication. The client submits intent once and receives the committed
result.
