# Upload Fragment (@fragno-dev/upload)

## Summary

Full-stack file storage in the app's database: a normalized file model, uploads with progress,
atomic batch publication, text search, server-side edits, and signed file links.

## Use when

- Files fit in database rows (`maxFileBytes`). Keep large files in S3/R2 with `@fragno-dev/blobs`.
- You want writes of several files to publish atomically, with revision preconditions.

## Config

- `maxFileBytes` (required): the largest file stored; keep it within the database's row limits.
- Optional: `uploadExpiresInSeconds`, `textIndex`, `fileLinks`, and the hooks `onFileReady`,
  `onUploadFailed`, `onFileDeleted`.

Options: `databaseAdapter` (required), `mountRoute` (defaults to `/api/uploads`).

## Docs (curl)

- `curl -L "https://fragno.dev/docs/upload/quickstart" -H "accept: text/markdown"`
- `curl -L "https://fragno.dev/docs/upload/routes" -H "accept: text/markdown"`
- `curl -L "https://fragno.dev/docs/upload/client" -H "accept: text/markdown"`
- `curl -L "https://fragno.dev/docs/upload/storage" -H "accept: text/markdown"`

## Server setup

```ts
import { createUploadFragment } from "@fragno-dev/upload";
import { migrate } from "@fragno-dev/db";

export const uploadFragment = createUploadFragment(
  { maxFileBytes: 10 * 1024 * 1024 },
  { databaseAdapter, mountRoute: "/api/uploads" },
);

await migrate(uploadFragment);
```

## Client setup

```ts
import { createUploadFragmentClient } from "@fragno-dev/upload/react";

export const uploadClient = createUploadFragmentClient({ mountRoute: "/api/uploads" });
```

`useUploadHelpers()` returns `createUploadAndTransfer`, `downloadFile`, `deleteFile`, `applyEdits`,
`searchFileCandidates`, and `hydrateSearchMatches`.

## Key routes

- `POST /uploads`, then `PUT /uploads/:uploadId/content`: publishes the file, or prepares it when
  `publicationMode` is `batch`.
- `POST /files`: upload and publish in one multipart request.
- `POST /files/commit-prepared`: publish prepared uploads, delete, and assert files atomically.
- `GET /files`, `GET|PATCH|DELETE /files/by-key`, `GET /files/by-key/content`.

## Common pitfalls

- Missing checksum on `POST /uploads` prevents idempotent resume behavior.
- Mismatch between server `mountRoute` and client configuration.
