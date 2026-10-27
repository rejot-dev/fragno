# Upload Fragment

Full-stack file storage for Fragno. Files and their content live in the app's database: a write
stores the content and publishes the file in one transaction. The fragment supports upload sessions
with progress, atomic publication of prepared batches, optimistic file-write preconditions, text
search, server-side edits, and signed file links for clients without credentials.

Content lives in database rows, so `maxFileBytes` must stay within the database's row limits. Keep
larger files in S3-compatible object storage with `@fragno-dev/blobs`.

```ts
import { createUploadFragment } from "@fragno-dev/upload";

const fragment = createUploadFragment(
  { maxFileBytes: 10 * 1024 * 1024, textIndex: { enabled: true } },
  { databaseAdapter, mountRoute: "/api/uploads" },
);
```

## Providers

Every file belongs to a `provider`, a namespace the caller names on every request. Files of
different providers never collide, even with the same key.

## Upload a File

Routes are relative to the fragment mount, for example `/api/uploads`.

```http
POST /uploads
Content-Type: application/json

{
  "provider": "workspace",
  "fileKey": "reports/q3.csv",
  "filename": "q3.csv",
  "sizeBytes": 1048576,
  "contentType": "text/csv",
  "publicationMode": "batch"
}
```

```json
{
  "uploadId": "upload_123",
  "provider": "workspace",
  "fileKey": "reports/q3.csv",
  "status": "created",
  "publicationMode": "batch",
  "expiresAt": "2027-01-01T00:00:00.000Z"
}
```

Then send the content with `PUT /uploads/:uploadId/content` and
`Content-Type: application/octet-stream`. The fragment reads the body, rejecting it with
`FILE_TOO_LARGE` once it outgrows `maxFileBytes`, and stores it in one transaction.

`publicationMode` decides what storing the content does:

- `immediate` (default): it publishes the file, replacing and deleting any content the file had.
- `batch`: it prepares the upload. The content is stored but invisible through the file routes until
  `/files/commit-prepared` publishes it. Sending the content again returns the same prepared write.

An immediate upload returns the published file (abridged). Mutation responses omit lifecycle
timestamps; read the file when you need them.

```json
{
  "kind": "published",
  "file": { "provider": "workspace", "fileKey": "reports/q3.csv", "status": "ready" }
}
```

A batch upload returns a prepared write:

```json
{
  "kind": "prepared",
  "write": {
    "uploadId": "upload_123",
    "provider": "workspace",
    "fileKey": "reports/q3.csv",
    "sizeBytes": 1048576,
    "contentType": "text/csv",
    "checksum": null,
    "expiresAt": "2027-01-01T00:00:00.000Z"
  }
}
```

`POST /uploads` resumes an unfinished upload of the same key when it carries the same checksum and
metadata; without a checksum it fails with `UPLOAD_ALREADY_ACTIVE`, unless it sets
`replaceActiveUpload`, which aborts the unfinished upload.

`POST /files` uploads and publishes a file in one `multipart/form-data` request, optionally with a
`precondition`.

## Atomically Publish Prepared Files

Publish up to 5,000 prepared writes with one transaction:

```http
POST /files/commit-prepared
Content-Type: application/json

{
  "entries": [
    { "kind": "write", "uploadId": "upload_123", "precondition": { "kind": "absent" } },
    { "kind": "write", "uploadId": "upload_456", "precondition": { "kind": "revision", "revision": 4 } },
    {
      "kind": "delete",
      "provider": "workspace",
      "fileKey": "reports/old.csv",
      "precondition": { "kind": "revision", "revision": 2 }
    },
    {
      "kind": "assert",
      "provider": "workspace",
      "fileKey": "reports/manifest.json",
      "precondition": { "kind": "revision", "revision": 9 }
    }
  ]
}
```

Entries support:

- `write` with `{ kind: "absent" }` when no ready file may exist, or
  `{ kind: "revision", revision }` for compare-and-swap replacement;
- `delete` of a file at a revision;
- `assert` to require a file's state without changing it.

If any entry fails, nothing in the batch changes. A successful commit publishes every write, deletes
the content it replaces, and queues ready and text-index hooks. An identical retry after a lost
response succeeds when every upload is already published.

Prepared uploads that are aborted, or whose session expires before a commit, lose their content.

## Client Helper

```ts
const result = await helpers.createUploadAndTransfer(file, {
  provider: "workspace",
  fileKey: "reports/q3.csv",
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
        { kind: "write", uploadId: result.write.uploadId, precondition: { kind: "absent" } },
      ],
    }),
  });
}
```

`downloadFile(fileKey, { provider })` reads `GET /files/by-key/content`.

## File Links

A file link is a signed, expiring token that reads or writes files without the integrator's
authentication, for example from a sandbox with `curl`. The token is the only authority, so mount
the `/file-links/:token...` routes where unauthenticated requests can reach them, and keep
`POST /file-links` behind your normal authentication.

Enable links in the fragment config:

```ts
createUploadFragment(
  {
    maxFileBytes,
    fileLinks: {
      secret: env.FILE_LINK_SECRET,
      // Names the file namespace. Instances that share a secret need distinct audiences.
      audience: "workspace:org-1",
      // Link writes carry no trustworthy content type.
      contentTypeForKey: (fileKey) => inferContentType(fileKey),
      // Bound one uploaded archive. File counts above 5,000, the batch limit, act as 5,000.
      maxArchiveWriteFiles: 200,
      maxArchiveWriteBytes: 25 * 1024 * 1024,
    },
  },
  options,
);
```

A link verifies only on an instance with the same `secret` and `audience`. Rotating the secret
invalidates every outstanding link. Links cannot be revoked; they expire after at most one hour.

### Create a link

```http
POST /file-links
Content-Type: application/json

{
  "provider": "workspace",
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
| `GET /file-links/:token`             | file, read  | Downloads the file                           |
| `PUT /file-links/:token`             | file, write | Replaces the file; requires `Content-Length` |
| `GET /file-links/:token/archive.tar` | glob, read  | Streams a tar of up to 500 matching files    |
| `PUT /file-links/:token/archive.tar` | glob, write | Publishes every tar entry as one batch       |

`PUT` routes expect `Content-Type: application/octet-stream`.

Archive entry names are relative to the glob's static directory prefix: `reports/**` reads
`reports/q1/summary.csv` as `q1/summary.csv`, and writes the entry `q1/summary.csv` back to the same
key.

- **Reading:** each archive is one listing page, read one file at a time. When more files match, the
  response carries an `X-Next-Cursor` header; request the archive again with `?cursor=<value>` for
  the next page.
- **Writing:** writes replace existing files without preconditions. Entries may be files or
  directories; directories are skipped. The archive must be uncompressed tar. The fragment rejects
  the whole archive, publishing nothing, when an entry is outside the glob, a symlink or other
  special entry, a duplicate, or beyond `maxArchiveWriteFiles` or `maxArchiveWriteBytes`. A file
  over `maxFileBytes`, alone or in an archive, is rejected with 413. Successful writes return a
  summary, `{ "fileCount": 2, "sizeBytes": 23 }`, rather than a file list.

```sh
curl -sS --fail-with-body "$BASE/file-links/$READ_TOKEN/archive.tar" | tar -x -C reports
tar -ch -C out . | curl -sS --fail-with-body -T - -H 'Expect:' \
  -H 'Content-Type: application/octet-stream' "$BASE/file-links/$WRITE_TOKEN/archive.tar"
```

Errors use `FILE_LINKS_DISABLED` (400) when `fileLinks` is not configured, `FILE_LINK_INVALID` (403)
for a token this instance did not sign, `FILE_LINK_EXPIRED` (410), and `FILE_LINK_FORBIDDEN` (403)
for the wrong access or an archive entry outside the glob. A body that is not a readable tar archive
is `INVALID_REQUEST` (400).

## Storage and Atomicity

The fragment keeps file content in its `storage_object` table. Every write stores new content under
a fresh object key, points the file at it, and deletes the content it replaces in the same
transaction, so readers never see a file without its content and replaced content never lingers.
Concurrent writes to the same file retry against the winner's state; edits re-apply to the new text.

## Durable Hooks

Durable hooks are persisted with the database transaction and run out of band:

- `onUploadTimeout`: expires unfinished and prepared uploads, deleting prepared content;
- `onFileReady`: notification after immediate or batch publication;
- `onFileTextIndexRequested`: indexes the published content;
- `onUploadFailed`: notification after expiry, replacement, or abort;
- `onFileDeleted`: clears the file's text index and invokes the configured deletion callback.

## CLI

```bash
# From the workspace
pnpm -C packages/fragment-upload build
node packages/fragment-upload/bin/run.js --help
```

```bash
fragno-upload --help
fragno-upload uploads create -b https://host.example.com/api/uploads --provider workspace --file-key users/42/avatar --filename demo.txt --size-bytes 10 --content-type text/plain
fragno-upload uploads transfer -b https://host.example.com/api/uploads -f ./demo.txt --provider workspace --file-key users/42/avatar
fragno-upload uploads transfer -b https://host.example.com/api/uploads -f ./report.csv --provider workspace --file-key reports/q3.csv --publication-mode batch
fragno-upload files list -b https://host.example.com/api/uploads --provider workspace --prefix users/42/
fragno-upload files download -b https://host.example.com/api/uploads --provider workspace --file-key users/42/avatar -o ./download.txt
```

Environment defaults:

- `FRAGNO_UPLOAD_BASE_URL`
- `FRAGNO_UPLOAD_HEADERS`
- `FRAGNO_UPLOAD_TIMEOUT_MS`
- `FRAGNO_UPLOAD_RETRIES`
- `FRAGNO_UPLOAD_RETRY_DELAY_MS`
