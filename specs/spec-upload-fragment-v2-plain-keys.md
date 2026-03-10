# Upload Fragment V2 - Plain Keys, Provider-Aware Storage, and Explicit Download Semantics

## 0. Open Questions

None. User explicitly approved full breaking changes (including schema).

## 1. Overview

This spec replaces the upload fragment key model and related API/storage contracts with a simpler,
fully explicit design:

1. Remove encoded key-parts (`s~...` / `n~...`) and use plain canonical string keys.
2. Remove `:fileKey` path-param routes for file operations and use explicit query/body key inputs.
3. Make provider selection explicit in API and client helpers so behavior is deterministic.
4. Add provider-aware uniqueness in schema to support multiple providers per organization.
5. Keep object-key mapping readable and direct (`<prefix>/<provider>/<fileKey>`).

This is a hard, intentional break and does not preserve compatibility with the previous encoded-key
contracts.

## 2. References

### 2.1 Local

- Existing upload spec: `specs/spec-upload-fragment.md`
- Current key codec: `packages/fragment-upload/src/keys.ts`
- Current upload schema: `packages/fragment-upload/src/schema.ts`
- Current routes using `:fileKey`: `packages/fragment-upload/src/routes/files.ts`
- Current helper download behavior: `packages/fragment-upload/src/client/helpers.ts`
- Docs backoffice upload UI: `apps/docs/app/routes/backoffice/connections/upload/files.tsx`
- Docs upload configuration model: `apps/docs/app/fragno/upload.ts`
- Docs upload server adapter selection: `apps/docs/app/fragno/upload-server.ts`

### 2.2 External

- URI generic syntax (path/query semantics): `https://www.rfc-editor.org/rfc/rfc3986`
- URL Standard (query encoding behavior): `https://url.spec.whatwg.org/`

## 3. Terminology

- `fileKey`: Canonical human-readable key string used by API, DB, and storage mapping.
- `provider`: Logical storage provider id (for example `r2`, `r2-binding`, future `s3`).
- `objectKey`: Final object path in storage (`<storageKeyPrefix>/<provider>/<fileKey>`).
- By-key operation: File operation that targets one file by `{ provider, fileKey }`.

## 4. Goals / Non-goals

### 4.1 Goals

1. Remove key codec complexity and eliminate `keyParts` throughout fragment APIs.
2. Make download and file-operation behavior explicit (no capability probing/fallback guessing).
3. Support multiple providers concurrently in one org namespace.
4. Ensure DB uniqueness and query paths are provider-aware.
5. Keep storage object keys readable and directly derivable.
6. Update all upload docs and examples to the new contracts.

### 4.2 Non-goals

- Backward compatibility with encoded file keys.
- Automatic migration adapters that keep both old and new API contracts alive.
- Preserving old upload/file rows by default.

## 5. Locked Decisions

1. `fileKey` is a plain canonical string, not an encoded structure.
2. `keyParts` is removed from public/client/server contracts.
3. By-key routes no longer use `:fileKey` path params.
4. Provider is explicit in create/upload/file/download operations.
5. Download method is always explicit (`signed-url` or `content`) and never auto-fallback.
6. Schema uniqueness is `(provider, fileKey)` instead of `fileKey` alone.
7. This rollout is intentionally breaking and may require data reset/migration.

## 6. File Key Model (V2)

### 6.1 Type

```ts
export type FileKey = string;
```

`FileKeyPart`, `FileKeyParts`, `FileKeyEncoded`, `encodeFileKey`, `decodeFileKey`,
`encodeFileKeyPrefix` are removed from `@fragno-dev/upload`.

### 6.2 Validation

Validation moves from codec parsing to direct key-string validation:

1. Key must be non-empty UTF-8 string.
2. Maximum UTF-8 byte length must be configurable (adapter limit still enforced).
3. Segments are `/`-delimited.
4. Empty segments are rejected.
5. `.` and `..` segments are rejected.
6. NUL and control characters are rejected.

This validator is shared by routes/services/adapters.

### 6.3 Prefix Semantics

Prefix filters are plain string prefixes over canonical keys. No codec prefix helper exists in v2.

## 7. API and Route Contract Changes

### 7.1 Upload Session Creation

`POST /uploads` request body changes:

```ts
{
  provider: string; // required
  fileKey: string;  // required
  filename: string;
  sizeBytes: number;
  contentType: string;
  checksum?: { algo: "md5" | "sha256"; value: string } | null;
  tags?: string[];
  visibility?: "private" | "public" | "unlisted";
  uploaderId?: string;
  metadata?: Record<string, unknown>;
}
```

`keyParts` is removed.

### 7.2 By-Key File Routes

All by-key routes become query/body driven and provider-explicit:

1. `GET /files/by-key?provider=<provider>&key=<fileKey>`
2. `PATCH /files/by-key?provider=<provider>&key=<fileKey>`
3. `DELETE /files/by-key?provider=<provider>&key=<fileKey>`
4. `GET /files/by-key/download-url?provider=<provider>&key=<fileKey>`
5. `GET /files/by-key/content?provider=<provider>&key=<fileKey>`

`/files/:fileKey*` contracts are removed.

### 7.3 File Listing

`GET /files` accepts:

- `provider?: string` (filter one provider or all providers when omitted)
- `prefix?: string` (plain key prefix)
- existing cursor/status/uploader filters.

### 7.4 Client Helpers

`createUploadAndTransfer(file, options)` requires:

```ts
{
  provider: string;
  fileKey: string;
  // existing metadata/progress options...
}
```

`downloadFile` requires explicit provider and method:

```ts
downloadFile(fileKey, {
  provider: string;
  method: "signed-url" | "content";
});
```

No automatic fallback or probing between download methods is allowed.

### 7.5 CLI

CLI commands add required `--provider` and replace key-part options with `--file-key` only.

## 8. Storage Mapping and Adapter Contract

### 8.1 Storage Key Formula

All adapters map deterministically:

```text
objectKey = join("/", storageKeyPrefix, provider, fileKey)
```

Rules:

1. `provider` segment is always present.
2. `fileKey` is not codec-transformed.
3. Adapters still enforce byte-length limits and forbidden segments.

### 8.2 Adapter Input Contract

Storage adapter API removes `fileKeyParts` and accepts:

```ts
{
  provider: string;
  fileKey: string;
  // other fields unchanged
}
```

`resolveStorageKey` and upload-init signatures are updated accordingly.

## 9. Data Model and Schema Changes

### 9.1 Column Naming

For both `file` and `upload` tables:

1. `fileKey` -> `key`
2. `storageProvider` -> `provider`
3. `storageKey` -> `objectKey`

(`storageUploadId` remains as-is.)

### 9.2 Uniqueness and Indexes

`file` table:

1. Replace unique `idx_file_key` with unique `(provider, key)`.
2. Replace key/status/uploader compound indexes with provider-aware versions:
   - `(provider, key, status)`
   - `(provider, key, uploaderId)`
   - `(provider, key, status, uploaderId)`
3. Keep `createdAt` / `status+createdAt` indexes.

`upload` table:

1. Replace `idx_upload_file_key` with `(provider, key)`.
2. Keep status/expires indexes.

### 9.3 Hook Payloads

Hook payloads remove `fileKeyParts` and include `provider` + plain `fileKey`.

### 9.4 Migration Strategy

This rollout is intentionally breaking. Two supported rollout modes:

1. Destructive reset (preferred for docs/dev): drop and recreate upload schema.
2. One-time migration script: rename columns and backfill provider-aware indexes.

No compatibility shims are required.

## 10. Multi-Provider Configuration Model

### 10.1 Fragment Config

Upload fragment config becomes provider-set based:

```ts
{
  providers: Record<string, StorageAdapter>;
  defaultProvider: string;
  // limits + hooks...
}
```

`defaultProvider` must reference an existing provider id.

### 10.2 Runtime Rules

1. Upload creation fails if requested provider is unknown.
2. By-key operations require provider; no implicit fallback across providers.
3. List route may aggregate or filter by provider.

### 10.3 Docs Backoffice

Backoffice stores multiple provider configs and surfaces active/default provider selection. Per-file
actions operate on file row provider and never probe alternative providers.

## 11. Backoffice UX and Key Generation

Backoffice key generation switches to readable strings, for example:

```text
files/2026-03-09/report-pdf-b2f4e9a1
```

No encoded segments are displayed in UI.

## 12. Testing Requirements

### 12.1 Unit and Integration

1. Validator tests for plain keys and segment rules.
2. Route tests for new by-key query contracts and provider requirements.
3. Service tests for provider-aware uniqueness and listing/prefix behavior.
4. Adapter tests for object-key mapping with provider segment.
5. Client helper tests for explicit provider + explicit download method.
6. CLI tests for required `--provider`.

### 12.2 Regression Coverage

1. Ensure no route path uses `:fileKey` anymore.
2. Ensure no helper probes unsupported download flows automatically.
3. Ensure provider switches do not affect files belonging to other providers.

## 13. Documentation Updates (Required Scope)

Update all user-facing docs and examples to v2:

1. `packages/fragment-upload/README.md`
2. `apps/docs/content/docs/upload/overview.mdx`
3. `apps/docs/content/docs/upload/routes.mdx`
4. `apps/docs/content/docs/upload/client.mdx`
5. `apps/docs/content/docs/upload/quickstart.mdx`
6. Any upload snippets in docs/blog/backoffice guides
7. `example-apps/upload-example` usage and explanation text

Docs must explicitly state:

1. Plain key model.
2. Provider-explicit contracts.
3. Query/body by-key routes (no `:fileKey` path param).
4. Explicit download method behavior (no fallback).
