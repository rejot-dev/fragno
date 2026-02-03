# Upload Fragment CLI Smoke Test Plan

> This plan is meant to be executed by an agent. It is intentionally verbose and uses checkboxes for
> tracking.

## Pre-flight: Reset State (required)

> Keep a pristine copy of these instructions before you begin.

- [ ] Copy this file to a pristine copy **before editing or checking any boxes**.
  - Example:
    - `cp packages/fragment-upload/SMOKE_TEST_PLAN.md /tmp/SMOKE_TEST_PLAN.pristine.md`

### 1) Delete the PGlite DB (upload-example)

- [ ] Stop any running dev server for the upload example.
- [ ] Delete the PGlite database directory:
  - `rm -rf example-apps/upload-example/upload-example.pglite`

### 2) Clear filesystem storage (proxy uploads)

By default the proxy filesystem storage path is:

- `~/.fragno/upload-example`

- [ ] Remove the entire directory (this clears all stored objects for the proxy adapter):
  - `rm -rf ~/.fragno/upload-example`

If you use a custom path via `UPLOAD_PROXY_DIR`, remove that path instead.

### 3) Clear MinIO bucket (direct uploads)

The upload example uses MinIO with bucket name `uploads` by default.

Pick one method below:

**Method A: MinIO client (mc) if available**

- [ ] `mc alias set local http://localhost:9000 minioadmin minioadmin`
- [ ] `mc rm -r --force local/uploads`

**Method B: Docker exec (if MinIO runs in compose)**

- [ ] Find the MinIO container name (typically `upload-example-minio-1`):
  - `docker ps --filter "ancestor=minio/minio" --format "table {{.Names}}\t{{.Ports}}"`
- [ ] Remove bucket contents:
  - `docker exec -it <container> mc alias set local http://localhost:9000 minioadmin minioadmin`
  - `docker exec -it <container> mc rm -r --force local/uploads`

## Environment Setup

- [ ] Start MinIO (direct uploads):
  - `cd example-apps/upload-example`
  - `docker compose up -d`
- [ ] Ensure `.env` is set up for direct uploads (S3 env vars present):
  - `cp .env.example .env` (if needed)
- [ ] Start the dev server (HTTPS is enabled by default in this repo):
  - `pnpm -C example-apps/upload-example dev`

Expected base URLs (update if Vite selects a different port, e.g. 5174):

- Direct: `https://localhost:5173/api/uploads-direct`
- Proxy: `https://localhost:5173/api/uploads-proxy`

## CLI Smoke Tests (Direct Uploads)

Use the CLI helper script:

- `packages/fragment-upload/scripts/run-dev-cli.sh --https --direct <command>`

### A) Direct single upload (happy path)

- [ ] `uploads transfer` with small file (direct-single)
  - Example:
    - `echo "direct smoke" > /tmp/direct-smoke.txt`
    - `packages/fragment-upload/scripts/run-dev-cli.sh --https --direct uploads transfer -f /tmp/direct-smoke.txt --key-parts '["smoke","direct","<ts>"]' --content-type text/plain`
- [ ] Capture `uploadId` + `fileKey` from response
- [ ] `uploads get` for `uploadId`
- [ ] `uploads progress` for `uploadId` (expect `UPLOAD_INVALID_STATE` because `uploads transfer`
      completes the upload)
- [ ] `files get` for `fileKey`
- [ ] `files list` by prefix
- [ ] `files update` (e.g. change filename + metadata)
- [ ] `files download-url`
- [ ] `files download` (writes to file)
- [ ] `files delete`

### B) Direct multipart endpoints (expected invalid state for direct-single)

- [ ] `uploads parts-urls` -> expect `UPLOAD_INVALID_STATE`
- [ ] `uploads parts-list` -> empty list or invalid state (observed empty list)
- [ ] `uploads parts-complete` -> expect `UPLOAD_INVALID_STATE`

### C) Direct abort flow

- [ ] Create a new upload (`uploads create`) and immediately `uploads abort`

### D) Direct /files upload endpoint

- [ ] `files upload` with small file and key-parts
- [ ] `files delete` for that file

### E) Direct content endpoint (expected invalid state)

- [ ] `uploads content` with direct upload ID and `text/plain`
  - Observed `UNSUPPORTED_MEDIA_TYPE` when content-type not `application/octet-stream`.
  - Also expect `UPLOAD_INVALID_STATE` for direct strategy if correct content-type is used.

### F) Direct signed download URL behavior (fixed)

- [ ] Confirm that signed URL no longer has double `?` and `files download` works.
  - Fix applied in `example-apps/upload-example/app/uploads/s3-signer.server.ts`.

### G) Direct multipart flow (NOT YET TESTED)

- [ ] Create upload with file size exceeding multipart threshold (default is 5 GiB) **or** configure
      lower multipart threshold in S3 adapter to force multipart. (Note: S3 minimum part size is 5
      MiB; smaller `UPLOAD_S3_MULTIPART_PART_SIZE_BYTES` values will be clamped.)
- [ ] `uploads create` returns `direct-multipart` strategy and includes `partSizeBytes`.
- [ ] `uploads parts-urls` for all part numbers.
- [ ] Upload each part directly to MinIO using provided URLs.
- [ ] `uploads parts-complete` with `{ partNumber, etag, sizeBytes }`.
- [ ] `uploads complete` with `{ partNumber, etag }`.
- [ ] Verify final `files get` shows `ready`.

### H) Direct checksum verification + idempotent reuse (NOT YET TESTED)

- [ ] Create upload with checksum (md5 or sha256) and verify success.
- [ ] Create upload with **incorrect** checksum and verify failure (for direct uploads, the PUT
      fails with HTTP 400 from storage; no fragment error code is returned).
- [ ] Re-run `uploads create` with the same checksum + metadata and verify it reuses the existing
      upload (same `uploadId`, no new storage session).
- [ ] Re-run `uploads create` without checksum and verify `UPLOAD_ALREADY_ACTIVE` when another
      upload is active for the same `fileKey`.

## CLI Smoke Tests (Proxy Uploads)

Use the CLI helper script:

- `packages/fragment-upload/scripts/run-dev-cli.sh --https --proxy <command>`

### A) Proxy upload (happy path)

- [ ] `uploads create` with `application/octet-stream`
- [ ] `uploads content` with `application/octet-stream`
- [ ] `uploads get` for `uploadId`
- [ ] `uploads progress` (expect `UPLOAD_INVALID_STATE` because upload already completed)
- [ ] `files get`
- [ ] `files list` by prefix
- [ ] `files update`
- [ ] `files download` (streaming fallback)
- [ ] `files delete`

### B) Proxy multipart endpoints (expected invalid state)

- [ ] `uploads parts-urls` -> expect `UPLOAD_INVALID_STATE`
- [ ] `uploads parts-list` -> empty list or invalid state (observed empty list)
- [ ] `uploads parts-complete` -> expect `UPLOAD_INVALID_STATE`

### C) Proxy abort flow

- [ ] `uploads create` then `uploads abort`

### D) Proxy /files upload endpoint

- [ ] `files upload`
- [ ] `files delete` for that file

### E) Proxy signed URL unsupported (expected)

- [ ] `files download-url` returns `SIGNED_URL_UNSUPPORTED` (filesystem adapter)

## Additional Coverage (NOT YET TESTED)

These items were not covered in the manual smoke tests above:

- [ ] `files list` pagination (`cursor`, `pageSize`)
- [ ] `files list` status filtering (`ready`, `deleted`)
- [ ] `files list` uploaderId filter
- [ ] Validation errors for invalid `file-key` or mismatched `key-parts`
- [ ] Validation errors for missing required fields (e.g. `uploads create` without `file-key` /
      `key-parts`)
- [ ] `files update` with `tags` and `visibility` variants
- [ ] `files download --stdout`
- [ ] `uploads progress` with only `partsUploaded` (no bytes)
- [ ] `uploads progress` with only `bytesUploaded` (no parts)
- [ ] `uploads get` on non-existent upload id
- [ ] `files get` on non-existent file key
- [ ] `files delete` on already deleted file

## Notes / Known Behavior

- Direct single uploads require `Content-Length` to avoid MinIO `411 Length Required`.
- HTTPS dev server uses a self-signed cert; CLI sets `NODE_TLS_REJECT_UNAUTHORIZED=0` when `--https`
  is used.
- Proxy adapter does **not** support signed download URLs (expected `SIGNED_URL_UNSUPPORTED`).
