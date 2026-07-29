# Upload Fragment

Full-stack upload and logical file publication for Fragno. The fragment supports direct-to-storage
uploads, proxy uploads, multipart uploads, optimistic file-write preconditions, and atomic
publication of prepared upload batches.

## Upload Strategy vs. Publication Mode

Every upload session records two independent decisions:

- `strategy` describes how bytes reach storage:
  - `direct-single`: the client uploads to one signed storage URL;
  - `direct-multipart`: the client uploads parts to signed storage URLs;
  - `proxy`: the client streams bytes through the fragment.
- `publicationMode` describes when the physical object becomes a logical file:
  - `immediate` (default): completion publishes the file immediately;
  - `batch`: completion leaves the upload `prepared` until `/files/commit-prepared` atomically
    publishes it.

`publicationMode` is selected when the upload session is created and remains fixed for the session.
Completion routes do not accept a mode, which makes retries deterministic.

## Create an Upload Session

Routes are relative to the fragment mount, for example `/api/uploads`.

```http
POST /uploads
Content-Type: application/json

{
  "provider": "r2",
  "fileKey": "releases/app.tar.gz",
  "filename": "app.tar.gz",
  "sizeBytes": 1048576,
  "contentType": "application/gzip",
  "publicationMode": "batch"
}
```

The response contains the selected storage `strategy`, persisted `publicationMode`, expiration, and
canonical provider-sticky follow-up URLs. Clients should use the returned URLs rather than
rebuilding upload paths.

```json
{
  "uploadId": "upload_123",
  "provider": "r2",
  "fileKey": "releases/app.tar.gz",
  "status": "created",
  "strategy": "direct-single",
  "publicationMode": "batch",
  "expiresAt": "2027-01-01T00:00:00.000Z",
  "upload": {
    "mode": "single",
    "transport": "direct",
    "uploadUrl": "https://storage.example/...",
    "uploadHeaders": {},
    "statusEndpoint": "/uploads/upload_123?provider=r2",
    "progressEndpoint": "/uploads/upload_123/progress?provider=r2",
    "completeEndpoint": "/uploads/upload_123/complete?provider=r2",
    "abortEndpoint": "/uploads/upload_123/abort?provider=r2"
  }
}
```

## Completion Results

Direct uploads finish with `POST /uploads/:uploadId/complete`. Proxy uploads finish when
`PUT /uploads/:uploadId/content` stores the request body. Both routes return the same discriminated
result.

An immediate upload returns a published logical file (abridged below). Mutation responses omit
lifecycle timestamps because database-generated values are only authoritative after a subsequent
read:

```json
{
  "kind": "published",
  "file": {
    "provider": "r2",
    "fileKey": "releases/app.tar.gz",
    "status": "ready"
  }
}
```

A batch upload returns a prepared write:

```json
{
  "kind": "prepared",
  "write": {
    "uploadId": "upload_123",
    "provider": "r2",
    "fileKey": "releases/app.tar.gz",
    "objectKey": "uploads/r2/releases/app.tar.gz/version-123",
    "sizeBytes": 1048576,
    "contentType": "application/gzip",
    "checksum": null,
    "expiresAt": "2027-01-01T00:00:00.000Z"
  }
}
```

A prepared object physically exists in storage but is not visible through the logical file routes.

## Atomically Publish Prepared Files

Publish up to 5,000 prepared writes with one Upload database transaction:

```http
POST /files/commit-prepared
Content-Type: application/json

{
  "entries": [
    {
      "kind": "write",
      "uploadId": "upload_123",
      "precondition": { "kind": "absent" }
    },
    {
      "kind": "write",
      "uploadId": "upload_456",
      "precondition": { "kind": "revision", "revision": 4 }
    },
    {
      "kind": "assert",
      "provider": "r2",
      "fileKey": "releases/manifest.json",
      "precondition": { "kind": "revision", "revision": 9 }
    }
  ]
}
```

Entries are ordered and support:

- `write` with `{ kind: "absent" }` when no ready destination may exist;
- `write` with `{ kind: "revision", revision }` for compare-and-swap replacement;
- `assert` to validate a file without publishing an upload for that entry.

All uploads, destinations, and assertions are loaded and validated before mutations are scheduled.
If any entry fails, no file in the batch is published. Commit results include file metadata and
revisions but omit lifecycle timestamps; use a file read when those timestamps are needed. A
successful commit:

1. creates or replaces all logical file rows;
2. changes each upload from `prepared` to `completed`;
3. queues ready and text-index hooks;
4. queues durable cleanup for superseded physical objects.

An identical retry after a lost response succeeds when every upload is already published to the
expected physical object.

## Client Helper

`createUploadAndTransfer` supports every storage strategy and returns the same discriminated result.

```ts
const result = await helpers.createUploadAndTransfer(file, {
  provider: "r2",
  fileKey: "releases/app.tar.gz",
  publicationMode: "batch",
  onProgress(progress) {
    console.log(progress.bytesUploaded, progress.totalBytes);
  },
});

if (result.kind === "prepared") {
  await fetch("/api/uploads/files/commit-prepared", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      entries: [
        {
          kind: "write",
          uploadId: result.write.uploadId,
          precondition: { kind: "absent" },
        },
      ],
    }),
  });
} else {
  console.log(result.file.fileKey);
}
```

## Upload Inventory

### Direct single

1. `POST /uploads` creates the session and returns a signed `uploadUrl`.
2. The client `PUT`s the object to storage.
3. `POST /uploads/:uploadId/complete` verifies storage and either publishes or prepares the upload.
4. Optional `POST /uploads/:uploadId/progress` records progress.

### Direct multipart

1. `POST /uploads` creates the session.
2. `POST /uploads/:uploadId/parts` returns signed part URLs.
3. The client uploads each part.
4. `POST /uploads/:uploadId/parts/complete` records part metadata and progress.
5. `POST /uploads/:uploadId/complete` completes the storage multipart upload and either publishes or
   prepares the upload.

### Proxy stream

1. `POST /uploads` creates the session.
2. `PUT /uploads/:uploadId/content` streams content through the fragment and either publishes or
   prepares the upload.

### One-shot multipart form

`POST /files` remains an immediate, server-mediated file write. It accepts `multipart/form-data`,
uses the configured storage adapter, applies file preconditions, and returns file metadata.

If storage selects `direct-multipart`, the one-shot route responds with `409 UPLOAD_INVALID_STATE`;
use the multipart upload-session flow instead.

### Session helpers

- `GET /uploads/:uploadId`: status, strategy, publication mode, progress, and expiration;
- `POST /uploads/:uploadId/progress`: monotonic byte/part progress;
- `POST /uploads/:uploadId/abort`: abort the session and clean up prepared physical objects;
- `GET /uploads/:uploadId/parts`: recorded multipart parts.

## Storage and Atomicity

Atomic visibility comes from one Upload database transaction, not from a storage transaction.
Physical objects are finalized before publication. Every upload uses a fresh versioned object key,
so replacing a file never overwrites its currently published object in place.

This model works with the filesystem, database, S3-compatible, R2 S3 API, and R2 binding storage
adapters. Keep object storage private: prepared objects are hidden by Fragno's logical file API, not
by an additional provider-level access-control operation.

Prepared uploads that are aborted or expire queue durable `cleanupStorageObject` work. Superseded
ready objects are cleaned up only after the replacement transaction commits.

## Durable Hooks

Durable hooks are persisted with the database transaction and run out of band:

- `onUploadTimeout`: expires active/prepared uploads and queues prepared-object cleanup;
- `onFileReady`: notification after immediate or batch publication;
- `onFileTextIndexRequested`: requests indexing after publication;
- `cleanupStorageObject`: deletes aborted, expired, or superseded physical objects;
- `onUploadFailed`: notification after failure or abort;
- `onFileDeleted`: deletes a file's physical object and invokes configured deletion callbacks.

## Build

```bash
npm run types:check
npm run build
```

## CLI

```bash
# From the workspace
pnpm -C packages/fragment-upload build
node packages/fragment-upload/bin/run.js --help
```

```bash
fragno-upload --help
fragno-upload uploads create -b https://host.example.com/api/uploads --provider r2-binding --file-key users/42/avatar --filename demo.txt --size-bytes 10 --content-type text/plain
fragno-upload uploads transfer -b https://host.example.com/api/uploads -f ./demo.txt --provider r2-binding --file-key users/42/avatar
fragno-upload uploads transfer -b https://host.example.com/api/uploads -f ./release.tar.gz --provider r2 --file-key releases/app.tar.gz --publication-mode batch
fragno-upload files list -b https://host.example.com/api/uploads --provider r2-binding --prefix users/42/
fragno-upload files download -b https://host.example.com/api/uploads --provider r2-binding --file-key users/42/avatar -o ./download.txt
```

Environment defaults:

- `FRAGNO_UPLOAD_BASE_URL`
- `FRAGNO_UPLOAD_HEADERS`
- `FRAGNO_UPLOAD_TIMEOUT_MS`
- `FRAGNO_UPLOAD_RETRIES`
- `FRAGNO_UPLOAD_RETRY_DELAY_MS`
