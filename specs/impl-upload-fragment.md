# Fragno Upload Fragment - Implementation Plan

Reference: spec at `specs/spec-upload-fragment.md`.

- [x] Add upload schema in `packages/fragment-upload/src/schema.ts` with `file`, `upload`,
      `upload_part` tables and indexes as defined in spec sections 7.1-7.2; store encoded `fileKey`
      (unique), store `checksum` as JSON, and use `fileKey` (not `fileId`) as the join key between
      `file` and `upload`.
- [x] Implement key encoding utilities in `packages/fragment-upload/src/keys.ts` for
      `encodeFileKey`, `decodeFileKey`, and `encodeFileKeyPrefix` per spec section 6.3-6.4, with
      unit tests covering round-trip, prefix safety, invalid parts, and URL-safe output.
- [x] Define the storage adapter interface in `packages/fragment-upload/src/storage/types.ts` per
      spec section 8.1-8.2 (use `FileKeyParts` + encoded `FileKeyEncoded`, checksum JSON) and export
      it from `packages/fragment-upload/src/index.ts`.
- [x] Implement adapter selection and configuration handling in
      `packages/fragment-upload/src/config.ts` for `UploadFragmentConfig` defaults per spec section
      5.3 (thresholds, expirations, size limits).
- [x] Create a shared adapter test harness in
      `packages/fragment-upload/src/storage/__tests__/adapter-contract.test.ts` that validates
      required behaviors (init, complete, delete, signed download) from spec sections 8 and 9.
- [x] Implement the S3-compatible adapter in `packages/fragment-upload/src/storage/s3.ts` using a
      pluggable SigV4 signer and enforcing multipart constraints per spec section 8.3; add tests
      with mocked signing and in-memory part list.
- [x] Add an optional R2 adapter in `packages/fragment-upload/src/storage/r2.ts` only for
      R2-specific deviations per spec section 8.4; otherwise ensure the S3 adapter works with R2 by
      configuration.
- [x] Implement the filesystem adapter in `packages/fragment-upload/src/storage/fs.ts` (Node-only),
      streaming write and read, plus path mapping from `storageKey` per spec section 8.5; add tests
      guarded for Node and temp directories.
- [ ] Build upload services in `packages/fragment-upload/src/services/` for
      create/progress/complete/ abort/delete flows per spec section 9, using `FileKeyParts` as the
      canonical identifier and encoding to `fileKey` for storage; enforce atomicity with
      `this.serviceTx(...)` and `.check()` for optimistic concurrency as per spec section 5.4.
- [ ] Audit all database access in the fragment to ensure no direct `deps.db` usage; handler routes
      must use `this.handlerTx()` and background work must use `fragment.inContext(...).handlerTx()`
      per spec section 5.4.
- [ ] Add durable hooks to the fragment definition in `packages/fragment-upload/src/definition.ts`
      for final events only (`onFileReady`, `onUploadFailed`, `onFileDeleted`) per spec section 13,
      and wire them into service mutations.
- [ ] Implement upload routes in `packages/fragment-upload/src/routes/uploads.ts` for all endpoints
      in spec section 10.1-10.2, including multipart parts handling and progress updates; decode
      `fileKey` path params into `FileKeyParts` before calling services.
- [ ] Implement file routes in `packages/fragment-upload/src/routes/files.ts` for all endpoints in
      spec section 10.3-10.4, including metadata updates and delete behavior; ensure delete is
      idempotent and does not allow file reuse.
- [ ] Add list/prefix/cursor pagination in `GET /files` using `findWithCursor` and `starts with`
      index query per spec section 10.4 and the querying docs in section 2 references.
- [ ] Implement content streaming route `PUT /uploads/:uploadId/content` with
      `application/octet-stream` handling per spec section 10.2 and core streaming changes in 12.
- [ ] Extend `@fragno-dev/core` routing to support `application/octet-stream` in
      `packages/fragno/src/api/api.ts` and `packages/fragno/src/api/fragment-instantiator.ts`
      following spec section 12.1-12.3, with new tests in core.
- [ ] Add `bodyStream()` and `isBodyStream()` to `RequestInputContext` in
      `packages/fragno/src/api/request-input-context.ts` per spec section 12.2, with tests.
- [ ] Update client request body handling in `packages/fragno/src/client/client.ts` so
      `application/octet-stream` routes pass through `Blob`, `File`, `Uint8Array`, and streams
      without wrapping FormData per spec section 12.4, with tests.
- [ ] Add fragment-level tests for direct single, direct multipart, proxy streaming, and error
      conditions (invalid state, expired upload, checksum mismatch) per spec section 14.
- [ ] Add tests for progress tracking: server-counted proxy bytes and client-reported progress per
      spec section 9.3.
- [ ] Implement client API surface in `packages/fragment-upload/src/client/` with hooks + helpers
      per spec section 11, including `createUploadAndTransfer` and `downloadFile`, and ensure
      helpers accept `FileKeyParts` as canonical inputs.
- [ ] Add client helper tests covering multipart part splitting, progress callbacks, and fallback to
      proxy uploads per spec section 11.2.
- [ ] Write docs under `apps/docs/content/docs/upload/` for overview, quickstart, routes, adapters,
      key-system, and client usage per spec section 15, and add navigation entries.
- [ ] Update `example-apps/upload-example` to demonstrate S3-compatible direct multipart +
      filesystem proxy uploads with progress UI per spec section 16, and remove all workflow-related
      code from this example.
