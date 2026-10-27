---
"@fragno-dev/backoffice-api": patch
---

feat: add the `blobs.*` operations for large files kept outside the workspace. `blobs.createUpload`
returns a presigned URL that accepts one PUT of the bytes, straight to storage, without knowing
their size; `blobs.completeUpload` records the stored size and ETag and publishes the blob.
`blobs.get`, `blobs.list`, `blobs.createDownloadUrl`, and `blobs.delete` read, share, and remove a
scope's blobs.
