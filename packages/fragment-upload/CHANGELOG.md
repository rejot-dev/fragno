# @fragno-dev/upload

## 0.2.0

### Minor Changes

- 68a655f: Store file content in the fragment's own database instead of through storage adapters. A
  write now stores its content, publishes the file, and deletes the content it replaces in one
  transaction; `apply-edits`, `POST /files`, and file-link writes each take one read and one write.

  This is a pre-1.0 breaking change:
  - The `storage` config is replaced by a required `maxFileBytes`. The storage adapters
    (`createS3CompatibleStorageAdapter`, `createR2StorageAdapter`, `createR2BindingStorageAdapter`,
    `createFilesystemStorageAdapter`, and `@fragno-dev/upload/storage/db`) are removed; keep large
    files in object storage with `@fragno-dev/blobs`.
  - Direct and multipart uploads are removed, with the routes `POST /uploads/:uploadId/complete`,
    `/progress`, `/parts`, `/parts/complete`, and `GET /files/by-key/download-url`. Content always
    goes through `PUT /uploads/:uploadId/content`.
  - `provider` is gone: a file is addressed by its key alone in routes, client helpers, the CLI,
    file links, hook payloads, and records. `downloadFile` and `deleteFile` take only the key, and
    `PROVIDER_MISMATCH` is gone. Upload responses no longer carry `strategy` or follow-up endpoint
    URLs, and prepared writes no longer carry `objectKey`.
  - Oversized content fails with `FILE_TOO_LARGE` (413).
  - Concurrent edits now re-apply to the text another write published, instead of failing with
    `FILE_PRECONDITION_FAILED`. Edits enforce `maxFileBytes` on each file they write.
  - Search candidates carry their `byteLength`. `POST /files/search/hydrate` reads every candidate's
    content in its one read, so send only as many candidates as `maxBytes` scans.
  - File records no longer carry `errorCode` or `errorMessage`, which were always `null`.
  - Cleanup events that earlier versions queued are no longer handled, and fail once their retries
    run out; the content they named stays stored.

  The schema drops the `upload_part` table, the upload columns direct and multipart uploads used,
  the file error columns, and every `provider` column. Keys become unique on their own, so a
  database holding one key under two providers fails to migrate; delete one of each pair first.
  Existing files keep their content, provided it was stored by the database storage adapter in the
  same database.

### Patch Changes

- 5bfd508: feat: add atomic server-side text and JSON file edits.
- 267669b: feat: bound text search hydration by explicit candidates and byte budgets
- 66d2ecb: feat: paginate bounded file search and expose glob-filtered file listing.
- 5594802: feat: export upload helpers and stream prepared batch content before publication
- 04f0291: feat: allow prepared batch writes without a file precondition.
- f856070: Ensure all non-private packages include repository metadata in their `package.json`
  entries.
- c926ec5: feat: add prepared upload publication, atomic file batch commits, and typed upload
  errors.
- 71330a3: feat: add bounded batch file snapshot reads with revisions and deleted-file metadata.
- eb5530b: feat: add revision-backed conditional file writes with collision-safe storage cleanup.
- d5410ca: feat: add a database-backed storage adapter for uploads.
- a4ceb64: feat: add `deleteFile(fileKey, { provider })` to the upload helpers, which deletes a file
  through `DELETE /files/by-key`.
- 38081b7: feat: add delimited file listings and allow larger list page sizes.
- f548a30: fix: Publish prepared batches of 100 or more uploads on Durable Object SQLite, which
  binds at most 100 parameters per statement.
- 2084e18: fix: file-link downloads arrive as attachments named after the file, or after the folder
  for archives, and send `X-Content-Type-Options: nosniff` and a sandboxing Content-Security-Policy.
- 44522f6: feat: Add signed file links: `POST /file-links` issues an expiring URL that reads or
  writes one file, or a glob of files as a tar archive, without the integrator's authentication.
- f4fced7: fix: query file prefixes with literal index ranges.
- 23af3d2: feat!: search upload files by any of several keywords; search routes and helpers take
  `keywords` instead of `query`
- 500c81d: feat: support revision-conditional deletions in prepared file batches.
- ee9ef11: feat: `POST /uploads` takes `replaceActiveUpload` to abort unfinished uploads of the same
  file key, cleaning up what they stored, instead of rejecting the new upload with
  `UPLOAD_ALREADY_ACTIVE`.
- 18cb5d9: feat: the S3-compatible and R2 storage adapters accept a `fetch` option for their signed
  storage requests, and a `declaredSize: "maximum"` option that accepts any stored size up to an
  upload's declared one, for uploaders that cannot know the size in advance.
- 0723b72: feat: export the Upload schema for metadata synchronization consumers.
- 01c41c1: feat: add text index powered file search.
- c07f55e: fix: an upload that never completes, including an aborted one, no longer leaves bytes
  behind. An hour after its URL expires, its stored object is deleted and its multipart session
  aborted. Aborting a multipart session that S3 no longer has now succeeds.
- dc1de38: feat: allow up to 200 context lines while limiting hydrated searches to 100 matches.
- Updated dependencies [0d4cbe8]
- Updated dependencies [2797663]
- Updated dependencies [fcecfed]
- Updated dependencies [d2da73f]
- Updated dependencies [cff3b99]
- Updated dependencies [fcd0179]
- Updated dependencies [4db850e]
- Updated dependencies [766f977]
- Updated dependencies [27b7db5]
- Updated dependencies [9419f78]
- Updated dependencies [73e14d7]
- Updated dependencies [a8010b8]
- Updated dependencies [26a21e3]
- Updated dependencies [eb6ea3e]
- Updated dependencies [71b0233]
- Updated dependencies [0186a7a]
- Updated dependencies [4fd5010]
- Updated dependencies [2ab64f4]
- Updated dependencies [3f9d1bb]
- Updated dependencies [867bc9d]
- Updated dependencies [8b651fe]
- Updated dependencies [b79e697]
- Updated dependencies [c1314be]
- Updated dependencies [767c934]
- Updated dependencies [b854e42]
- Updated dependencies [c13b6c7]
- Updated dependencies [e6d80bb]
- Updated dependencies [d9a5ffe]
- Updated dependencies [a15bcc2]
- Updated dependencies [719ac3b]
- Updated dependencies [d1b4bd9]
- Updated dependencies [83bea0b]
- Updated dependencies [9a01df4]
- Updated dependencies [d92f4ce]
- Updated dependencies [1d2125e]
- Updated dependencies [fc794d7]
- Updated dependencies [0cf8414]
- Updated dependencies [fe0e92d]
- Updated dependencies [20324e7]
- Updated dependencies [6b028b6]
- Updated dependencies [c1255e4]
- Updated dependencies [318921d]
- Updated dependencies [92adef0]
- Updated dependencies [7e2d989]
- Updated dependencies [d62cc57]
- Updated dependencies [ae415ff]
- Updated dependencies [204bbb7]
- Updated dependencies [8a60280]
- Updated dependencies [2b8f4b7]
- Updated dependencies [a7bf719]
- Updated dependencies [9ea7170]
- Updated dependencies [187d67e]
- Updated dependencies [aff91d1]
- Updated dependencies [03d5a5c]
- Updated dependencies [a28094e]
- Updated dependencies [b4fc242]
- Updated dependencies [033a643]
- Updated dependencies [c41c1e2]
- Updated dependencies [bfe589e]
- Updated dependencies [6cc8f36]
- Updated dependencies [f42c8c6]
- Updated dependencies [9cd79f3]
- Updated dependencies [7a625f6]
- Updated dependencies [d689267]
- Updated dependencies [49ca4fb]
- Updated dependencies [0e63275]
- Updated dependencies [4944ecf]
- Updated dependencies [d9ac2a3]
- Updated dependencies [4e5d611]
- Updated dependencies [2dbc550]
- Updated dependencies [2dbc550]
- Updated dependencies [7405040]
- Updated dependencies [04fac88]
- Updated dependencies [b40a129]
- Updated dependencies [5256cee]
- Updated dependencies [6c0de3b]
- Updated dependencies [f297b5d]
- Updated dependencies [caf581b]
- Updated dependencies [02e29d4]
- Updated dependencies [7de0078]
- Updated dependencies [ff3673f]
- Updated dependencies [d7236a2]
- Updated dependencies [1e1088b]
- Updated dependencies [9e2ee05]
- Updated dependencies [3734573]
- Updated dependencies [1c57f29]
- Updated dependencies [2e7263b]
- Updated dependencies [801e6ab]
- Updated dependencies [f510d32]
- Updated dependencies [48c0094]
- Updated dependencies [7a60491]
- Updated dependencies [6649e1f]
- Updated dependencies [3570c2a]
- Updated dependencies [d125074]
- Updated dependencies [8afaf3d]
- Updated dependencies [2d729a4]
- Updated dependencies [85be413]
- Updated dependencies [fa21507]
- Updated dependencies [79055dd]
- Updated dependencies [e7b36e1]
- Updated dependencies [a61b3a5]
- Updated dependencies [4dc14bf]
- Updated dependencies [3328fe3]
- Updated dependencies [a64dc64]
- Updated dependencies [ea8ea88]
- Updated dependencies [5599183]
- Updated dependencies [e2cad8d]
- Updated dependencies [93bc657]
- Updated dependencies [5e0cfe8]
- Updated dependencies [9919fdd]
  - @fragno-dev/db@0.5.0
  - @fragno-dev/core@0.2.3

## 0.1.3

### Patch Changes

- Updated dependencies [0020e39]
  - @fragno-dev/core@0.2.2
  - @fragno-dev/db@0.4.1

## 0.1.2

### Patch Changes

- 4d141f8: fix: remove development exports from published packages
- 172c6c6: feat(upload): add provider-sticky upload session endpoints
- a8b793c: fix: allow overwriting existing logical file keys by writing a new versioned object
- 9f92afd: fix: reduce db roundtrip guard violations in upload routes
- f7b43ce: fix(upload): run file deletion through durable hooks
- 9da36eb: feat(upload): switch upload keys to provider-aware plain strings
- Updated dependencies [8a96998]
- Updated dependencies [3e2ff94]
- Updated dependencies [f34d7d7]
- Updated dependencies [4d141f8]
- Updated dependencies [c8841b5]
- Updated dependencies [83f6223]
- Updated dependencies [ae54a60]
- Updated dependencies [7dd7055]
- Updated dependencies [e178bf4]
- Updated dependencies [d2f68ba]
- Updated dependencies [567c3b3]
- Updated dependencies [75191db]
- Updated dependencies [d395ad2]
- Updated dependencies [75407f3]
- Updated dependencies [8a2da9d]
- Updated dependencies [bfdd4b1]
- Updated dependencies [3ffa711]
- Updated dependencies [c2c3229]
- Updated dependencies [e559425]
- Updated dependencies [fc5c256]
- Updated dependencies [93fa469]
- Updated dependencies [14e00b1]
- Updated dependencies [f33286c]
- Updated dependencies [b3ad7eb]
- Updated dependencies [95cdf95]
- Updated dependencies [eabdb9c]
- Updated dependencies [9eeba53]
- Updated dependencies [49a9f4f]
- Updated dependencies [dcba383]
- Updated dependencies [c895c07]
- Updated dependencies [ed4b4a0]
- Updated dependencies [1102ce0]
- Updated dependencies [2ae432c]
- Updated dependencies [ad2ef56]
- Updated dependencies [9f87189]
- Updated dependencies [0f9b7ef]
- Updated dependencies [6d043ea]
- Updated dependencies [fe55a13]
- Updated dependencies [01fc2cb]
- Updated dependencies [f4aedad]
- Updated dependencies [f042c9d]
- Updated dependencies [0176aa8]
- Updated dependencies [00f2631]
- Updated dependencies [c13c1c1]
- Updated dependencies [0a6c8da]
- Updated dependencies [7a40517]
- Updated dependencies [91a2ac0]
- Updated dependencies [7bda0b2]
- Updated dependencies [c115600]
- Updated dependencies [b84a3d0]
  - @fragno-dev/db@0.4.0
  - @fragno-dev/core@0.2.1

## 0.1.1

### Patch Changes

- d35d8de: feat(fragment-upload): add upload schema and file key utilities.
- 45e7e6d: feat: add s3-compatible and R2 storage adapters for fragment-upload
- 53e5f97: fix(core,fragment-upload): honor client mount routes and avoid upload config crashes.
- 1db35f9: fix(fragment-upload): invalidate file and upload queries after mutations.
- 51b0477: feat(fragment-upload): add storage adapter types and config defaults.
- 5b118c9: fix: update upload retry semantics and file-on-success behavior
- Updated dependencies [f569301]
- Updated dependencies [dbbbf60]
- Updated dependencies [3e07799]
- Updated dependencies [20a98f8]
- Updated dependencies [1902f30]
- Updated dependencies [15e3263]
- Updated dependencies [208cb8e]
- Updated dependencies [33f671b]
- Updated dependencies [fc803fc]
- Updated dependencies [0628c1f]
- Updated dependencies [7e1eb47]
- Updated dependencies [301e2f8]
- Updated dependencies [5f6f90e]
- Updated dependencies [1dc4e7f]
- Updated dependencies [2eafef4]
- Updated dependencies [3c9fbac]
- Updated dependencies [a5ead11]
- Updated dependencies [7d7b2b9]
- Updated dependencies [c4d4cc6]
- Updated dependencies [d4baad3]
- Updated dependencies [548bf37]
- Updated dependencies [a79e90d]
- Updated dependencies [3041732]
- Updated dependencies [7e179d1]
- Updated dependencies [0013fa6]
- Updated dependencies [7c60341]
- Updated dependencies [afb06a4]
- Updated dependencies [53e5f97]
- Updated dependencies [8e9b6cd]
- Updated dependencies [c5fd7b3]
- Updated dependencies [69b9a79]
- Updated dependencies [5cef16e]
  - @fragno-dev/core@0.2.0
  - @fragno-dev/db@0.3.0
