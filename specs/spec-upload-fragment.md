# Fragno Upload Fragment - Spec

## 0. Open Questions

None.

## 1. Overview

This document specifies a **generic file upload + file management Fragment** for Fragno. The
fragment provides:

- A **storage-agnostic** upload and file management API backed by the Fragno data layer.
- **Upload attempts are distinct from files**: file rows are created only after successful
  completion, and failed/expired uploads do not reserve a `fileKey`, enabling retries.
- **Pluggable storage adapters** with an S3-compatible primary adapter (AWS S3 + R2) and a
  filesystem adapter.
- **Direct-to-storage uploads** via signed URLs for large files (S3-compatible), plus **proxy
  streaming** uploads (filesystem and generic adapters).
- A **key system** inspired by Deno KV key parts, encoded into URL-safe strings for use in routes.
- Durable hooks for **upload failures** and **final file lifecycle events** (ready/deleted).
- A client API with hooks + helpers for common upload flows, including progress tracking.

This fragment must align with Fragno's routing, data layer, durable hooks, and client state
management patterns.

## 2. References

External:

- Amazon S3 presigned URLs (expiration limits, usage):
  `https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html`
- Amazon S3 multipart upload limits (part size, max parts):
  `https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html`
- Amazon S3 object key naming and length limits:
  `https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html`
- Amazon S3 ETag and checksum semantics for multipart uploads:
  `https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html`
- Cloudflare R2 S3-compatible presigned URLs:
  `https://developers.cloudflare.com/r2/api/s3/presigned-urls/`
- Cloudflare R2 multipart upload details:
  `https://developers.cloudflare.com/r2/objects/multipart-objects/`
- Cloudflare R2 limits (object size, upload size, metadata size, key length, max parts):
  `https://developers.cloudflare.com/r2/platform/limits/`
- Cloudflare Workers request body size limits (proxy uploads):
  `https://developers.cloudflare.com/workers/platform/limits/`
- Deno KV key space (key parts, delimiter injection rationale, ordering):
  `https://raw.githubusercontent.com/denoland/docs/refs/heads/main/deploy/kv/key_space.md`
- Cloudflare R2 llms-full: `https://developers.cloudflare.com/r2/llms-full.txt`

Local:

- Fragno middleware usage: `apps/docs/content/docs/fragno/for-users/middleware.mdx`
- Client state management (hooks + mutators):
  `apps/docs/content/docs/fragno/for-library-authors/features/client-state-management.mdx`
- Querying + cursor pagination:
  `apps/docs/content/docs/fragno/for-library-authors/database-integration/querying.mdx`
- Transactions:
  `apps/docs/content/docs/fragno/for-library-authors/database-integration/transactions.mdx`
- Durable hooks:
  `apps/docs/content/docs/fragno/for-library-authors/database-integration/durable-hooks.mdx`
- Core routing & content-type handling: `packages/fragno/src/api/api.ts`
  `packages/fragno/src/api/fragment-instantiator.ts`
  `packages/fragno/src/api/request-input-context.ts` `packages/fragno/src/client/client.ts`

## 3. Terminology

- **File**: the durable entity tracked by the fragment (metadata + storage location), created only
  after a successful upload.
- **Upload**: an ephemeral attempt to create a file, storing a mirror of file metadata + storage
  session details until completion.
- **File Key**: a URL-safe, encoded key derived from structured key parts.
- **Storage Adapter**: pluggable implementation for storing and retrieving objects.
- **Direct upload**: client uploads directly to storage (signed URL).
- **Proxy upload**: client uploads to fragment endpoint; fragment streams to storage.

## 4. Goals / Non-goals

### 4.1 Goals

1. Storage-agnostic API surface with a clean adapter interface.
2. File metadata stored in Fragno data layer (DB), independent of storage.
3. Uploads do not reserve file keys until completion; failed/expired uploads can be retried.
4. Support **direct** and **proxy** uploads, including large files.
5. Provide **multipart** upload support (S3-compatible adapter required).
6. URL-safe key system with **prefix querying** and cursor pagination.
7. Durable hooks for upload failures and final file events (ready/deleted).
8. First-class client helpers + hooks, including progress reporting.
9. Idempotent upload creation and resume semantics based on checksums when provided.
10. Full test coverage (routes, services, adapters, core additions).
11. Documentation layer similar to Stripe + Workflows docs.

### 4.2 Non-goals (initial)

- Object-level access control; users should apply auth via Fragno middleware.
- Content scanning/virus detection.
- CDN caching / image transformations.

## 5. Packages

### 5.1 Main package: `@fragno-dev/fragment-upload`

Responsibilities:

- Fragment definition, routes, services, schema, and hooks.
- Storage adapter interface and built-in adapters:
  - S3-compatible adapter (AWS S3 + R2; direct + multipart + signed URLs).
  - Filesystem adapter (proxy streaming).
- Key encoding/decoding utilities.
- Client API helpers and framework-agnostic hooks.

Notes:

- Filesystem adapter is Node-only; export as a separate entrypoint (e.g.
  `@fragno-dev/fragment-upload/fs`).
- S3-compatible adapter should avoid heavyweight deps by allowing a pluggable signer (aws4fetch or
  AWS SDK).
- If R2 requires deviations from S3 semantics, add a separate optional R2 adapter that wraps those
  differences.

### 5.2 Core changes (in `@fragno-dev/core`)

Add streaming upload support to handle large proxy uploads without buffering. See section 12.

### 5.3 Fragment configuration

```ts
export interface UploadFragmentConfig {
  storage: StorageAdapter;
  storageKeyPrefix?: string;
  directUploadThresholdBytes?: number;
  multipartThresholdBytes?: number;
  multipartPartSizeBytes?: number;
  uploadExpiresInSeconds?: number;
  signedUrlExpiresInSeconds?: number;
  maxSingleUploadBytes?: number;
  maxMultipartUploadBytes?: number;

  onFileReady?: (payload: FileHookPayload, idempotencyKey: string) => Promise<void>;
  onUploadFailed?: (payload: FileHookPayload, idempotencyKey: string) => Promise<void>;
  onFileDeleted?: (payload: FileHookPayload, idempotencyKey: string) => Promise<void>;
}
```

Defaults:

- Size limits default to adapter limits.
- Expirations default to adapter recommendations (S3-compatible presigned URL max: 7 days).
- `signedUrlExpiresInSeconds` defaults to 1 hour.
- Strategy selection defaults to:
  - direct single if supported and size <= adapter single-upload limit,
  - direct multipart if supported and size exceeds single-upload limit,
  - proxy otherwise.

Notes:

- `storageKeyPrefix` is prepended to the adapter's storage key to allow user-defined namespaces.

### 5.4 Database atomicity and transactions

All database interactions must be atomic and use Fragno's transaction builders:

- Route handlers must use `this.handlerTx()` to execute transactions.
- Services must use `this.serviceTx(schema)` and return `TxResult` for handlers to execute.
- No direct `deps.db` usage is allowed in this fragment.
- A function must never perform multiple separate DB operations; all DB work must be part of a
  single transaction.
- When DB work is required outside a handler (e.g. background job), use
  `fragment.inContext(...).handlerTx()` so work still executes inside a transaction boundary.

See `apps/docs/content/docs/fragno/for-library-authors/database-integration/transactions.mdx`.

## 6. File Key System

### 6.1 Requirements

- Keys are **structured sequences of parts** (string | number), inspired by Deno KV's key parts.
- Must be **URL-safe** and used in routes as `/files/:fileKey`.
- Must support **prefix queries** without delimiter-injection ambiguity.

### 6.2 Types

```ts
export type FileKeyPart = string | number;
export type FileKeyParts = readonly FileKeyPart[];
export type FileKeyEncoded = string; // encoded, URL-safe
```

Rules:

- Business logic uses `FileKeyParts` everywhere.
- `FileKeyEncoded` is derived from `FileKeyParts` and is the only value stored in the database and
  exposed in URLs.

### 6.3 Encoding format

Encode each part with a type prefix, then join with `.`:

- String part: `s~<base64url(utf8)>`
- Number part: `n~<decimal>`

Example:

```text
["users", 42, "avatar"] -> s~dXNlcnM.n~42.s~YXZhdGFy
```

Rules:

- Base64url uses `A-Z a-z 0-9 - _` with **no padding**.
- `.` and `~` never appear in base64url output, so parsing is unambiguous.
- Numbers must be finite (`Number.isFinite`) and are serialized via `String(n)`.

### 6.4 Prefix encoding

To query by prefix parts:

```text
prefix = encodeParts(prefixParts) + "."
```

This prevents partial-part matches (e.g. `n~1.` won't match `n~10.`).

### 6.5 Helper utilities

`fragment-upload` exports:

- `encodeFileKey(parts: FileKeyParts): FileKeyEncoded`
- `decodeFileKey(key: FileKeyEncoded): FileKeyParts`
- `encodeFileKeyPrefix(parts: FileKeyParts): string`

## 7. Data Model (Fragno DB)

Uploads carry all metadata required to create a file. File rows are created only after a successful
upload completion; failed/aborted/expired uploads do not create file rows.

### 7.1 Tables

#### `file`

- `id` (idColumn) - internal only; not used in API or business logic
- `fileKey` (string, **unique**) - encoded key (see section 6)
- `uploaderId` (string, nullable)
- `filename` (string)
- `sizeBytes` (bigint)
- `contentType` (string)
- `checksum` (json, nullable) - `{ algo: "sha256" | "md5"; value: string }`
- `visibility` (string) - `"private" | "public" | "unlisted"`
- `tags` (json, nullable) - array of strings
- `metadata` (json, nullable) - arbitrary JSON object
- `status` (string) - `"ready" | "deleted"`
- `storageProvider` (string) - adapter name
- `storageKey` (string)
- `createdAt` (timestamp, default now) - set when upload completes
- `updatedAt` (timestamp, default now)
- `completedAt` (timestamp, nullable)
- `deletedAt` (timestamp, nullable)
- `errorCode` (string, nullable)
- `errorMessage` (string, nullable)

Indexes:

- `idx_file_key` (unique) on `fileKey`
- `idx_file_createdAt` on `createdAt`
- `idx_file_status_createdAt` on (`status`, `createdAt`)

#### `upload`

- `id` (idColumn) - **uploadId** (ephemeral)
- `fileKey` (string) - encoded key (not reserved until a file row exists)
- `uploaderId` (string, nullable)
- `filename` (string)
- `expectedSizeBytes` (bigint)
- `contentType` (string)
- `checksum` (json, nullable) - `{ algo: "sha256" | "md5"; value: string }`
- `visibility` (string) - `"private" | "public" | "unlisted"`
- `tags` (json, nullable) - array of strings
- `metadata` (json, nullable) - arbitrary JSON object
- `status` (string) - `"created" | "in_progress" | "completed" | "aborted" | "failed" | "expired"`
- `strategy` (string) - `"direct-single" | "direct-multipart" | "proxy"`
- `storageProvider` (string) - adapter name
- `storageKey` (string)
- `storageUploadId` (string, nullable) - for multipart sessions
- `uploadUrl` (string, nullable) - stored for direct-single idempotent reuse
- `uploadHeaders` (json, nullable) - stored for direct-single idempotent reuse
- `bytesUploaded` (bigint, default 0)
- `partsUploaded` (integer, default 0)
- `partSizeBytes` (integer, nullable)
- `expiresAt` (timestamp) - upload session expiry (also used for idempotent reuse)
- `createdAt` (timestamp, default now)
- `updatedAt` (timestamp, default now)
- `completedAt` (timestamp, nullable)
- `errorCode` (string, nullable)
- `errorMessage` (string, nullable)

Indexes:

- `idx_upload_file_key` on `fileKey`
- `idx_upload_status` on `status`
- `idx_upload_expiresAt` on `expiresAt`

#### `upload_part`

- `id` (idColumn)
- `uploadId` (reference)
- `partNumber` (integer)
- `etag` (string)
- `sizeBytes` (bigint)
- `createdAt` (timestamp, default now)

Indexes:

- `idx_upload_part_upload` on `uploadId`
- `idx_upload_part_number` (unique) on (`uploadId`, `partNumber`)

### 7.2 Constraints & validation

- `fileKey` uniqueness is enforced in the `file` table only.
- Upload creation must reject if a `file` already exists with the same `fileKey`.
- Upload creation must reject if a non-terminal upload with the same `fileKey` already exists.
- Upload creation must treat `expiresAt <= now` as terminal (even if the row is not yet marked
  `expired`) so retries are not blocked by delayed timeout hooks.
- Failed/aborted/expired uploads do **not** reserve file keys; retries are allowed.
- Deleted files keep their `fileKey` reserved and cannot be reused.
- File metadata is canonical after completion; upload metadata is a transient mirror used only until
  file creation.
- Upload metadata fields (`filename`, `contentType`, `checksum`, `visibility`, `tags`, `metadata`,
  `uploaderId`, `expectedSizeBytes`) are immutable after upload creation. Only status, progress, and
  timestamps may change.
- Storage key length <= 1024 bytes (S3 and R2 limit).
- Enforce provider-specific metadata size limits (R2: 8,192 bytes; S3 varies by provider).
- Max upload size and parts enforced per adapter; defaults set to S3-compatible limits where
  applicable.
- Validate encoded `fileKey` length before creating uploads to avoid storage errors.

## 8. Storage Adapter Interface

### 8.1 Capabilities

```ts
export type UploadTransport = "direct" | "proxy";
export type UploadMode = "single" | "multipart";

export interface StorageAdapterCapabilities {
  directUpload: boolean;
  multipartUpload: boolean;
  signedDownload: boolean;
  proxyUpload: boolean;
}
```

### 8.2 Adapter interface

```ts
export interface StorageAdapter {
  name: string;
  capabilities: StorageAdapterCapabilities;

  // Build or validate storage key for this adapter (apply storageKeyPrefix)
  resolveStorageKey(input: { fileKey: FileKeyEncoded; fileKeyParts: FileKeyParts }): string;

  // Create an upload session and decide strategy
  initUpload(input: {
    fileKey: FileKeyEncoded;
    fileKeyParts: FileKeyParts;
    sizeBytes: bigint;
    contentType: string;
    checksum?: { algo: "sha256" | "md5"; value: string } | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<{
    strategy: "direct-single" | "direct-multipart" | "proxy";
    storageKey: string;
    storageUploadId?: string;
    partSizeBytes?: number;
    expiresAt: Date;
    uploadUrl?: string;
    uploadHeaders?: Record<string, string>;
  }>;

  // Direct multipart: issue signed URLs for parts
  getPartUploadUrls?(input: {
    storageKey: string;
    storageUploadId: string;
    partNumbers: number[];
    partSizeBytes: number;
  }): Promise<{ partNumber: number; url: string; headers?: Record<string, string> }[]>;

  // Direct multipart: complete multipart upload
  completeMultipartUpload?(input: {
    storageKey: string;
    storageUploadId: string;
    parts: { partNumber: number; etag: string }[];
  }): Promise<{ etag?: string }>;

  // Direct multipart: abort
  abortMultipartUpload?(input: { storageKey: string; storageUploadId: string }): Promise<void>;

  // Proxy upload: consume stream and store object
  writeStream?(input: {
    storageKey: string;
    body: ReadableStream<Uint8Array>;
    contentType?: string | null;
    sizeBytes?: bigint | null;
  }): Promise<{ etag?: string; sizeBytes?: bigint }>;

  // Finalize / verify size or checksum
  finalizeUpload?(input: {
    storageKey: string;
    expectedSizeBytes: bigint;
    checksum?: { algo: "sha256" | "md5"; value: string } | null;
  }): Promise<{ sizeBytes?: bigint; etag?: string }>;

  // Delete
  deleteObject(input: { storageKey: string }): Promise<void>;

  // Downloads
  getDownloadUrl?(input: {
    storageKey: string;
    expiresInSeconds: number;
    contentDisposition?: string;
    contentType?: string;
  }): Promise<{ url: string; headers?: Record<string, string>; expiresAt: Date }>;

  getDownloadStream?(input: { storageKey: string }): Promise<Response>;
}
```

### 8.3 S3-compatible adapter specifics

- Must work against AWS S3 and S3-compatible endpoints (including R2) using standard SigV4 presigned
  URLs.
- Support **direct** uploads via presigned URLs (PUT) and signed downloads (GET).
- Enforce presigned URL expiration bounds (SigV4 max 7 days).
- Support multipart uploads with part sizes **5 MiB-5 GiB**, max **10,000** parts, and require all
  parts except the last to be >= 5 MiB.
- Treat multipart ETags as opaque (do not assume MD5).
- Enforce object key length <= 1024 bytes and provider upload limits.

### 8.4 R2 adapter specifics (optional)

- If Cloudflare R2 requires deviations from standard S3-compatible behavior (e.g. using Workers
  bindings instead of HTTP endpoints), provide a dedicated adapter that wraps those differences.
- Enforce R2-specific limits (including metadata size and upload size) when using this adapter.

### 8.5 Filesystem adapter specifics

- Always uses **proxy** uploads with streaming.
- Store files under a configured root directory.
- Uses `storageKey` as the relative path (with path separators derived from key parts).
- Provides download as a stream (`Response` with `Content-Type` + `Content-Length`).

## 9. Upload Lifecycle

### 9.1 States

File status:

- `ready` -> `deleted`

Notes:

- File rows are created only when an upload completes successfully.
- Failed/aborted/expired uploads do not create file rows.

Deletion rules:

- `deleted` is terminal; files cannot be undeleted.
- `fileKey` is never re-used once a file has been deleted.

Upload status:

- `created` -> `in_progress` -> `completed`
- `created`/`in_progress` -> `aborted`/`failed`/`expired`

### 9.2 Key reservation and retries

- Upload creation must reject if a file already exists with the same `fileKey`.
- Only one non-terminal upload per `fileKey` may exist at a time.
- Failed/aborted/expired uploads release the key for retries.
- If an existing upload has `expiresAt <= now`, treat it as terminal for create/retry even if the
  timeout hook has not executed yet.

### 9.3 Idempotency and resume

`POST /uploads` is idempotent **only when a checksum is supplied**.

- If a non-terminal upload exists with the same `fileKey` **and** identical metadata (including
  checksum), return the existing upload response (200) to allow resuming.
- If a non-terminal upload exists but metadata differs, return `UPLOAD_METADATA_MISMATCH`.
- If a completed file exists, return `FILE_ALREADY_EXISTS` (no idempotent file response).
- If checksum is missing, skip idempotent matching and return `UPLOAD_ALREADY_ACTIVE` when another
  non-terminal upload exists.
- Idempotent reuse must not create a new storage session. For direct-multipart, reuse the existing
  `storageUploadId` and `storageKey`. For direct-single, return the stored `uploadUrl` +
  `uploadHeaders` from the upload row. If the upload is expired, create a new upload instead.

### 9.4 Strategy selection

`initUpload` chooses strategy based on:

- Adapter capabilities
- Config thresholds (e.g., `directUploadThresholdBytes`)
- Expected file size

### 9.5 Progress tracking

Progress is stored in `upload.bytesUploaded` and `upload.partsUploaded`. Updates can be:

- Server-side (proxy uploads can count bytes as they stream).
- Client-reported via `POST /uploads/:uploadId/progress` (direct uploads).
- Part-based via `POST /uploads/:uploadId/parts/complete` (multipart).

Progress updates do **not** trigger durable hooks.

### 9.6 Retention

- Completed uploads are retained for audit/debugging.
- The fragment does not ship a built-in TTL cleanup job; consumers may run periodic cleanup of
  terminal uploads externally.

## 10. HTTP Routes (API Surface)

All `:fileKey` path parameters use the encoded `FileKeyEncoded` string (see section 6). Route
handlers must decode to `FileKeyParts` before invoking business logic.

### 10.1 Upload session routes

#### `POST /uploads`

Create an upload session.

Input (JSON):

```ts
{
  keyParts?: FileKeyParts;
  fileKey?: FileKeyEncoded; // optional; if provided, server decodes to keyParts
  filename: string;
  sizeBytes: number;
  contentType: string;
  checksum?: { algo: "sha256" | "md5"; value: string };
  tags?: string[];
  visibility?: "private" | "public" | "unlisted";
  uploaderId?: string;
  metadata?: Record<string, unknown>;
}
```

Rules:

- At least one of `keyParts` or `fileKey` is required.
- If both are provided, they must match after decoding.
- `checksum` is optional; idempotent upload creation only applies when a checksum is provided.
- Reject if a file already exists with the same `fileKey` (`FILE_ALREADY_EXISTS`).
- Reject if another non-terminal upload exists for the same `fileKey` (`UPLOAD_ALREADY_ACTIVE`),
  unless checksum is supplied and metadata matches (idempotent reuse).
- For expired uploads (`expiresAt <= now`), allow a new upload without waiting for the timeout hook.
- Storage side-effects must not occur on conflict. Implementations should perform conflict checks
  before creating storage sessions. If a race occurs after storage init, abort multipart sessions
  where possible.

Output:

```ts
{
  uploadId: string;
  fileKey: FileKeyEncoded;
  status: "created";
  strategy: "direct-single" | "direct-multipart" | "proxy";
  expiresAt: string;
  upload: {
    mode: "single" | "multipart";
    transport: "direct" | "proxy";
    uploadUrl?: string;
    uploadHeaders?: Record<string, string>;
    partSizeBytes?: number;
    maxParts?: number;
    partsEndpoint?: string;
    completeEndpoint: string;
    contentEndpoint?: string; // proxy
  };
}
```

#### `GET /uploads/:uploadId`

Returns current upload status + progress.

#### `POST /uploads/:uploadId/parts`

Request signed URLs for multipart parts (direct multipart only).

Input:

```ts
{ partNumbers: number[] }
```

Output:

```ts
{ parts: { partNumber: number; url: string; headers?: Record<string, string> }[] }
```

#### `GET /uploads/:uploadId/parts`

List known uploaded parts (for resume).

#### `POST /uploads/:uploadId/parts/complete`

Record completed parts (direct multipart).

Input:

```ts
{
  parts: {
    partNumber: number;
    etag: string;
    sizeBytes: number;
  }
  [];
}
```

#### `POST /uploads/:uploadId/complete`

Finalize upload and create the file record (ready). If a file already exists with the same
`fileKey`, return `FILE_ALREADY_EXISTS`.

Input:

```ts
{ parts?: { partNumber: number; etag: string }[] }
```

Output: file metadata object (same as `GET /files/:fileKey`).

#### `POST /uploads/:uploadId/abort`

Abort upload; marks the upload as aborted/failed and triggers `onUploadFailed`. No file row is
created or updated.

#### `POST /uploads/:uploadId/progress`

Client-reported progress (direct uploads).

Input:

```ts
{ bytesUploaded?: number; partsUploaded?: number }
```

### 10.2 Proxy upload content route

#### `PUT /uploads/:uploadId/content`

Streams upload body to storage and completes the upload on success.

- Content-Type: `application/octet-stream`
- Body: raw bytes stream (no buffering)

Returns: file metadata (ready state).

### 10.3 Convenience upload route

#### `POST /files` (multipart/form-data)

Simple single-step upload for small files. Internally creates an upload, transfers bytes, and
completes it. If transfer fails, no file row is created and the upload is marked failed.

FormData:

- `file` (File/Blob)
- `fileKey` (encoded) or `keyParts` (JSON-encoded array of parts)
- `uploaderId`, `tags`, `visibility`, `metadata`, `checksum` (optional, JSON-encoded if structured)

Returns: file metadata (ready state).

Notes:

- `POST /files` does **not** implement idempotent matching. If the file key already exists, return
  `FILE_ALREADY_EXISTS`. If an active upload exists, return `UPLOAD_ALREADY_ACTIVE`.

### 10.4 File management routes

#### `GET /files`

List files (cursor pagination).

Only completed uploads create file rows; in-progress or failed uploads are visible via `/uploads`.

Query params:

- `prefix` (encoded prefix produced by `encodeFileKeyPrefix(parts)`; must end with `.`)
- `cursor` (opaque cursor string)
- `pageSize` (default 25, max 100)
- `status` (optional; `"ready"` or `"deleted"`)
- `uploaderId` (optional)

Uses `findWithCursor` on `idx_file_key` with `starts with` and the encoded prefix to guarantee
correct prefix matching (no partial-part collisions).

#### `GET /files/:fileKey`

Return metadata for a file.

#### `PATCH /files/:fileKey`

Update metadata (immutable: fileKey, storageKey, size, contentType).

#### `DELETE /files/:fileKey`

Deletes storage object and marks file deleted (idempotent). Deleted files cannot be undeleted or
reused.

#### `GET /files/:fileKey/download-url`

Returns signed download URL if adapter supports it; otherwise error: `SIGNED_URL_UNSUPPORTED`.

#### `GET /files/:fileKey/content`

Proxy-stream file content (only if adapter supports streaming).

### 10.5 Error codes (initial)

- `UPLOAD_NOT_FOUND`
- `UPLOAD_ALREADY_ACTIVE`
- `UPLOAD_METADATA_MISMATCH`
- `FILE_NOT_FOUND`
- `FILE_ALREADY_EXISTS`
- `UPLOAD_EXPIRED`
- `UPLOAD_INVALID_STATE`
- `SIGNED_URL_UNSUPPORTED`
- `STORAGE_ERROR`
- `INVALID_FILE_KEY`
- `INVALID_CHECKSUM`

## 11. Client API Surface

### 11.1 Hooks + mutators

```ts
export function createUploadFragmentClients(config: FragnoPublicClientConfig) {
  const b = createClientBuilder(uploadFragmentDefinition, config, [routes]);

  return {
    useFiles: b.createHook("/files"),
    useFile: b.createHook("/files/:fileKey"),
    useCreateUpload: b.createMutator("POST", "/uploads"),
    useUploadStatus: b.createHook("/uploads/:uploadId"),
    useCompleteUpload: b.createMutator("POST", "/uploads/:uploadId/complete"),
    useAbortUpload: b.createMutator("POST", "/uploads/:uploadId/abort"),
    useUpdateFile: b.createMutator("PATCH", "/files/:fileKey"),
    useDeleteFile: b.createMutator("DELETE", "/files/:fileKey"),
  };
}
```

### 11.2 Helpers

Expose a small helper layer for common flows:

- `encodeFileKey`, `decodeFileKey`, `encodeFileKeyPrefix`.
- `createUploadAndTransfer(file, opts)` (expects `keyParts` in `opts`):
  - Creates upload.
  - Computes a checksum (default `sha256`) to enable idempotency, unless the caller supplies one.
  - If `direct-single`: PUT to signed URL, then call `complete`.
  - If `direct-multipart`: split file into parts, request URLs, upload parts, call `parts/complete`,
    then `complete`.
  - If `proxy`: stream to `/uploads/:uploadId/content`.
- `downloadFile(fileKeyOrParts)`:
  - Use `/download-url` if supported, otherwise fetch `/content`.
- Progress callback support:
  - For direct multipart, progress is computed per part.
  - For proxy, progress via stream reader + byte counting.

These helpers should be wrapped with `builder.createStore(...)` so they are reactive in supported
frameworks. See client state management docs.

## 12. Core Changes (Fragno)

Large proxy uploads require **streaming request bodies**. Current core parsing buffers JSON or
FormData and does not expose streams.

### 12.1 Route content type extension

Add a new content type:

```ts
export type RouteContentType =
  | "application/json"
  | "multipart/form-data"
  | "application/octet-stream";
```

Semantics:

- `application/octet-stream` does **not** parse the body.
- `RequestInputContext` exposes `bodyStream()` for streaming routes.
- Input validation is skipped for streaming bodies.

### 12.2 RequestInputContext additions

```ts
bodyStream(): ReadableStream<Uint8Array>;
isBodyStream(): boolean;
```

### 12.3 Fragment instantiator updates

In `fragment-instantiator`:

- If route expects `application/octet-stream`, do **not** call `req.formData()` or `req.text()`.
- Pass `req.body` through as the parsed body.
- Enforce content-type mismatch with 415 (similar to JSON/FormData handling).

### 12.4 Client builder changes

When a route's contentType is `application/octet-stream`:

- Allow body to be `File | Blob | ArrayBuffer | Uint8Array | ReadableStream`.
- Do **not** wrap in FormData.
- Set `Content-Type: application/octet-stream` when appropriate.

Add tests for:

- Stream body passthrough.
- Content-type enforcement.
- Large payloads not buffered.

## 13. Durable Hooks

Hooks are triggered **only for final lifecycle events**:

- `onFileReady` (file moved to `ready`)
- `onUploadFailed` (upload failed/aborted/expired)
- `onFileDeleted` (file deleted)

Each hook receives:

```ts
export type FileHookPayload = {
  fileKey: FileKeyEncoded;
  fileKeyParts: FileKeyParts;
  uploadId?: string;
  uploaderId?: string | null;
  sizeBytes: number;
  contentType: string;
};
```

Hooks should be triggered via `uow.triggerHook` during the mutation that changes state.

Timeout safety:

- Timeout processing must **only** update the upload row and must **not** mutate any file rows.
- The hook must never overwrite a newly created file (e.g., a retry that already completed).

Idempotency note:

- File keys are never re-used once deleted (see section 9.1), so `fileKey` is a stable idempotency
  key for `onFileReady` and `onFileDeleted`.
- `onUploadFailed` may fire multiple times for the same `fileKey` across retries; use `uploadId` (or
  the hook idempotency key) to dedupe.

## 14. Testing Requirements

- Storage adapter contract tests (mock adapter baseline + S3-compatible + optional R2 + FS).
- Route tests for each endpoint (success + error cases).
- Multipart flow tests (parts, resume, complete).
- Progress reporting tests.
- File creation semantics: no file row on failed/aborted/expired uploads; file created on success.
- Retry semantics: new upload allowed after terminal failure; concurrent active upload rejected.
- Core streaming tests (`application/octet-stream` contentType).
- Cursor pagination & prefix query tests (idx_file_key + `starts with`).

## 15. Documentation

Add a new docs section:

`apps/docs/content/docs/upload/`

At minimum:

- `overview.mdx` - what the fragment provides.
- `quickstart.mdx` - minimal setup + upload example.
- `routes.mdx` - API reference.
- `adapters.mdx` - S3-compatible + optional R2 + filesystem configuration.
- `key-system.mdx` - file key encoding & prefix queries.
- `client.mdx` - client hooks + helpers.

Structure should mirror Stripe / Workflows documentation conventions.

## 16. Example App

Update `example-apps/upload-example` to:

- Demonstrate direct multipart uploads to S3-compatible storage (R2 is acceptable).
- Demonstrate proxy uploads to filesystem adapter.
- Show progress UI and list/prefix queries.
- Remove all workflow-related code from this example.
