# Upload Fragment (@fragno-dev/upload)

## Summary

A full-stack upload system with a normalized file model, storage adapters, and client helpers for
S3/R2 direct uploads or server-streamed uploads.

## Use when

- You need robust file uploads with progress tracking.
- You want S3-compatible or R2 direct uploads.
- You want a unified API for upload sessions and file metadata.

## Config

The fragment config controls storage and upload behavior.

What you provide:

- `storage`: a storage adapter (S3-compatible, R2, or filesystem).
- Optional limits and behavior:
  - `storageKeyPrefix`
  - `directUploadThresholdBytes`
  - `multipartThresholdBytes`
  - `multipartPartSizeBytes`
  - `uploadExpiresInSeconds`
  - `signedUrlExpiresInSeconds`
  - `maxSingleUploadBytes`
  - `maxMultipartUploadBytes`
- Optional lifecycle hooks:
  - `onFileReady`
  - `onUploadFailed`
  - `onFileDeleted`

What the fragment needs via options:

- `databaseAdapter`: required for upload and file records.
- `mountRoute` (optional): defaults to `/api/uploads`.

## What you get

- File and upload records with lifecycle states.
- Direct single and multipart uploads to S3-backed storage.
- Server-streamed uploads for filesystem storage.
- Client helpers that choose the best upload strategy.

## Docs (curl)

Main docs pages:

- `curl -L "https://fragno.dev/docs/upload/quickstart" -H "accept: text/markdown"`
- `curl -L "https://fragno.dev/docs/upload/overview" -H "accept: text/markdown"`
- `curl -L "https://fragno.dev/docs/upload/client" -H "accept: text/markdown"`
- `curl -L "https://fragno.dev/docs/upload/routes" -H "accept: text/markdown"`
- `curl -L "https://fragno.dev/docs/upload/adapters" -H "accept: text/markdown"`

Search:

- `curl -s "https://fragno.dev/api/search?query=upload"`

## Prerequisites

- A storage adapter: S3-compatible, R2, or filesystem.
- A database and `@fragno-dev/db` adapter.

## Install

`pnpm add @fragno-dev/upload`

## Server setup

1. Create a storage adapter.
2. Create the fragment:
   - `createUploadFragment({ storage }, { databaseAdapter, mountRoute })`
3. Mount routes, typically `/api/uploads`.
4. Run migrations with `migrate(fragment)` or `fragno-cli`.

Example server module:

```ts
import { createUploadFragment, createFilesystemStorageAdapter } from "@fragno-dev/upload";
import { migrate } from "@fragno-dev/db";

const storage = createFilesystemStorageAdapter({ rootDir: "./uploads" });

export const uploadFragment = createUploadFragment(
  { storage },
  { databaseAdapter, mountRoute: "/api/uploads" },
);

await migrate(uploadFragment);
```

## Client setup

```ts
import { createUploadFragmentClient } from "@fragno-dev/upload/react";

export const uploadClient = createUploadFragmentClient({
  mountRoute: "/api/uploads",
});
```

## Helpers and hooks

Helpers:

- `useUploadHelpers` with `createUploadAndTransfer` and `downloadFile`.

Hooks:

- `useFiles`
- `useFile`
- `useCreateUpload`
- `useUploadStatus`
- `useCompleteUpload`
- `useAbortUpload`
- `useUpdateFile`
- `useDeleteFile`

## Key routes

Uploads:

- `POST /uploads`
- `GET /uploads/:uploadId`
- `POST /uploads/:uploadId/parts`
- `POST /uploads/:uploadId/complete`
- `PUT /uploads/:uploadId/content`

Files:

- `GET /files`
- `GET /files/:fileKey`
- `PATCH /files/:fileKey`
- `DELETE /files/:fileKey`
- `GET /files/:fileKey/download-url`

## Storage adapters

- S3-compatible adapter for AWS S3 or R2.
- R2 adapter for Cloudflare R2.
- Filesystem adapter for local/dev and proxy uploads.

## Security notes

- Use presigned URLs for direct uploads to avoid proxying large files.
- Restrict access to list/download endpoints with middleware.

## Common pitfalls

- Missing checksum on `POST /uploads` prevents idempotent resume behavior.
- Mismatch between server `mountRoute` and client configuration.
- Forgetting to include upload storage credentials for S3/R2.

## Next steps

- Use `encodeFileKey` to build stable, prefix-queryable file keys.
- Add cleanup jobs for terminal uploads if needed.
