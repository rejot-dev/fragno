# Fragno Upload Fragment - Implementation Plan (File-on-Success Semantics)

Reference: spec at `specs/spec-upload-fragment.md`.

- [x] Update `packages/fragment-upload/src/schema.ts` to add a mirrored copy of file metadata +
      storage fields to the `upload` table (including `storageProvider`, `storageKey`, and
      `uploadUrl`/`uploadHeaders` for direct-single idempotent reuse), and constrain `file.status`
      to `ready|deleted` per spec sections 7.1-7.2.
- [x] Update upload services in `packages/fragment-upload/src/services/uploads.ts` to create only
      upload rows, enforce `FILE_ALREADY_EXISTS`/`UPLOAD_ALREADY_ACTIVE`/`UPLOAD_METADATA_MISMATCH`
      (treat `expiresAt <= now` as terminal), return existing uploads for idempotent reuse without
      creating new storage sessions, and create file rows on completion (depends on schema changes;
      spec sections 7.2, 9.2-9.3, 10.1).
- [x] Update upload failure/abort/timeout flows (`markUploadFailed`, `markUploadAborted`,
      `onUploadTimeout`) to only mutate uploads and emit hooks from upload metadata, ensuring the
      timeout hook never overwrites a newly created file (spec sections 9.1, 13).
- [x] Update upload routes in `packages/fragment-upload/src/routes/uploads.ts` to use upload
      metadata/storage keys (not file rows), apply idempotency only when checksums are provided on
      `POST /uploads`, surface new error codes, ensure completion creates the file record, and avoid
      storage side-effects on conflicts (perform conflict checks before storage init; abort
      multipart sessions if a race is detected after init) (spec sections 9.3, 10.1-10.2, 10.5).
- [x] Update the `POST /files` route in `packages/fragment-upload/src/routes/files.ts` to run the
      upload->transfer->complete flow without creating a file row on failure, keep checksum
      optional, and restrict the `status` filter to `ready|deleted` (spec sections 10.3-10.4).
- [x] Update shared types and schemas (`packages/fragment-upload/src/types.ts`,
      `packages/fragment-upload/src/routes/shared.ts`, client types) to reflect the new file status
      set, optional checksums with idempotent matching when provided, and new error codes (spec
      sections 7.1, 10.1, 10.5, 11).
- [x] Add/adjust tests to cover: idempotent upload reuse only when checksum+metadata match,
      `UPLOAD_METADATA_MISMATCH` on mismatch, non-idempotent behavior when checksum is missing, no
      file row on failed/aborted/expired uploads, retry after failure, active upload rejection,
      completion conflict (`FILE_ALREADY_EXISTS`), and timeout hooks not overwriting a completed
      retry (spec section 14).
- [x] Update upload docs (`apps/docs/content/docs/upload/*`) to explain optional checksums on
      `POST /uploads` (idempotency only when provided), idempotency/resume behavior, file-on-success
      semantics, canonical file metadata (uploads are immutable), retention expectations, and the
      new error codes (spec sections 9-10, 15).
- [x] Update `packages/fragment-upload/SMOKE_TEST_PLAN.md` to reflect the new retry and failure
      behavior (spec sections 9-10).
