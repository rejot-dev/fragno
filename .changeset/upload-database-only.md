---
"@fragno-dev/upload": minor
---

Store file content in the fragment's own database instead of through storage adapters. A write now
stores its content, publishes the file, and deletes the content it replaces in one transaction;
`apply-edits`, `POST /files`, and file-link writes each take one read and one write.

This is a pre-1.0 breaking change:

- The `storage` config is replaced by a required `maxFileBytes`. The storage adapters
  (`createS3CompatibleStorageAdapter`, `createR2StorageAdapter`, `createR2BindingStorageAdapter`,
  `createFilesystemStorageAdapter`, and `@fragno-dev/upload/storage/db`) are removed; keep large
  files in object storage with `@fragno-dev/blobs`.
- Direct and multipart uploads are removed, with the routes `POST /uploads/:uploadId/complete`,
  `/progress`, `/parts`, `/parts/complete`, and `GET /files/by-key/download-url`. Content always
  goes through `PUT /uploads/:uploadId/content`.
- `provider` is required on `POST /uploads` and in the client helpers, and names any namespace;
  `PROVIDER_MISMATCH` is gone. Upload responses no longer carry `strategy` or follow-up endpoint
  URLs, and prepared writes no longer carry `objectKey`.
- `downloadFile` takes no `method`. Oversized content fails with `FILE_TOO_LARGE` (413).
- Concurrent edits now re-apply to the text another write published, instead of failing with
  `FILE_PRECONDITION_FAILED`. Edits enforce `maxFileBytes` on each file they write.
- Search candidates carry their `byteLength`. `POST /files/search/hydrate` reads every candidate's
  content in its one read, so send only as many candidates as `maxBytes` scans.
- File records no longer carry `errorCode` or `errorMessage`, which were always `null`.
- Cleanup events that earlier versions queued are no longer handled, and fail once their retries run
  out; the content they named stays stored.

The schema drops the `upload_part` table, the upload columns direct and multipart uploads used, and
the file error columns. Existing files keep their content, provided it was stored by the database
storage adapter in the same database.
