# Upload Fragment

Full-stack upload and logical file publication for Fragno. The fragment supports direct-to-storage
uploads, proxy uploads, multipart uploads, optimistic file-write preconditions, atomic publication
of prepared upload batches, and signed file links for clients without credentials.

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

## File Links

A file link is a signed, expiring token that reads or writes files without the integrator's
authentication, for example from a sandbox with `curl`. The token is the only authority, so mount
the `/file-links/:token...` routes where unauthenticated requests can reach them, and keep
`POST /file-links` behind your normal authentication.

Enable links in the fragment config:

```ts
createUploadFragment(
  {
    storage,
    fileLinks: {
      secret: env.FILE_LINK_SECRET,
      // Names the file namespace. Instances that share a secret need distinct audiences.
      audience: "workspace:org-1",
      // Link writes carry no trustworthy content type.
      contentTypeForKey: (fileKey) => inferContentType(fileKey),
      // Bound one uploaded archive. File counts above 5,000, the prepared-batch limit, act as 5,000.
      maxArchiveWriteFiles: 200,
      maxArchiveWriteBytes: 25 * 1024 * 1024,
    },
  },
  options,
);
```

A link verifies only on an instance with the same `secret` and `audience` and the provider it was
created for. Rotating the secret invalidates every outstanding link. Links cannot be revoked; they
expire after at most one hour.

### Create a link

```http
POST /file-links
Content-Type: application/json

{
  "provider": "database",
  "access": "read",
  "target": { "kind": "glob", "glob": "reports/**" },
  "expiresInSeconds": 900
}
```

```json
{ "token": "eyJ2ZXJzaW9uIjox...", "expiresAt": "2027-01-01T00:15:00.000Z" }
```

`access` is `read` or `write`. `target` is either one file, `{ "kind": "file", "fileKey" }`, or a
relative glob with a `*` or `?` wildcard, `{ "kind": "glob", "glob" }`, using the same matching as
`GET /files?glob=`. A link does not check that its files exist.

### Use a link

| Route                                | Link        | Behavior                                     |
| ------------------------------------ | ----------- | -------------------------------------------- |
| `GET /file-links/:token`             | file, read  | Streams the file                             |
| `PUT /file-links/:token`             | file, write | Replaces the file; requires `Content-Length` |
| `GET /file-links/:token/archive.tar` | glob, read  | Streams a tar of up to 500 matching files    |
| `PUT /file-links/:token/archive.tar` | glob, write | Publishes every tar entry as one batch       |

`PUT` routes expect `Content-Type: application/octet-stream`.

Archive entry names are relative to the glob's static directory prefix: `reports/**` reads
`reports/q1/summary.csv` as `q1/summary.csv`, and writes the entry `q1/summary.csv` back to the same
key.

- **Reading:** each archive is one listing page. When more files match, the response carries an
  `X-Next-Cursor` header; request the archive again with `?cursor=<value>` for the next page.
- **Writing:** writes replace existing files without preconditions. Entries may be files or
  directories; directories are skipped. The archive must be uncompressed tar. The fragment rejects
  the whole archive, publishing nothing and deleting its staged objects, when an entry is outside
  the glob, a symlink or other special entry, a duplicate, or beyond `maxArchiveWriteFiles` or
  `maxArchiveWriteBytes`. A file over `maxSingleUploadBytes`, alone or in an archive, is rejected
  with 413. Successful writes return a summary, `{ "fileCount": 2, "sizeBytes": 23 }`, rather than a
  file list.

```sh
curl -sS --fail-with-body "$BASE/file-links/$READ_TOKEN/archive.tar" | tar -x -C reports
tar -ch -C out . | curl -sS --fail-with-body -T - -H 'Expect:' \
  -H 'Content-Type: application/octet-stream' "$BASE/file-links/$WRITE_TOKEN/archive.tar"
```

Links need storage that streams through the fragment: the filesystem, database, and R2 binding
adapters. On S3-compatible storage, link requests fail with `STORAGE_ERROR`.

Errors use `FILE_LINKS_DISABLED` (400) when `fileLinks` is not configured, `FILE_LINK_INVALID` (403)
for a token this instance did not sign, `FILE_LINK_EXPIRED` (410), and `FILE_LINK_FORBIDDEN` (403)
for the wrong access or an archive entry outside the glob. A body that is not a readable tar archive
is `INVALID_REQUEST` (400).

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
