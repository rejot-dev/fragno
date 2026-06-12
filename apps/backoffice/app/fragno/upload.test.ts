import { describe, expect, test, assert } from "vitest";

import {
  UPLOAD_DATABASE_DEFAULT_MAX_SINGLE_UPLOAD_BYTES,
  buildUploadAdminConfigResponse,
  normalizeStoredUploadAdminConfig,
  resolveUploadAdminConfigInput,
  resolveUploadStorageKeyPrefix,
} from "./upload";

const TEST_ACCESS_KEY_ID = "ACCESS_KEY_ID_TEST";
const TEST_SECRET_ACCESS_KEY = "SECRET_ACCESS_KEY_TEST";

describe("upload admin contract", () => {
  test("enforces organisation-prefixed storage key namespace", () => {
    const prefix = resolveUploadStorageKeyPrefix("org_ABC", "team/uploads");
    expect(prefix).toBe("org/org_ABC/team/uploads");
  });

  test("resolves a valid r2 config payload with explicit default provider", () => {
    const result = resolveUploadAdminConfigInput({
      orgId: "acme-dev",
      now: "2026-03-08T10:00:00.000Z",
      payload: {
        provider: "r2",
        defaultProvider: "r2",
        bucket: "acme-upload-bucket",
        endpoint: "https://123456.r2.cloudflarestorage.com/",
        accessKeyId: TEST_ACCESS_KEY_ID,
        secretAccessKey: TEST_SECRET_ACCESS_KEY,
        region: "auto",
        storageKeySuffix: "uploads",
        maxMetadataBytes: 0,
        uploadExpiresInSeconds: 3600,
      },
    });

    assert(result.ok);

    assert(result.config.defaultProvider === "r2");
    assert(result.config.namespace.orgPrefix === "org/acme-dev");
    assert(result.config.providers.r2?.provider === "r2");
    assert(result.config.providers.r2?.r2.endpoint === "https://123456.r2.cloudflarestorage.com");
    assert(result.config.providers.r2?.r2.limits?.maxMetadataBytes === 0);
    assert(result.config.providers.r2?.r2.limits?.uploadExpiresInSeconds === 3600);
  });

  test("resolves a database-backed config payload", () => {
    const result = resolveUploadAdminConfigInput({
      orgId: "acme-dev",
      now: "2026-03-08T10:00:00.000Z",
      payload: {
        provider: "database",
        defaultProvider: "database",
        storageKeySuffix: "workspace",
        maxSingleUploadBytes: 10485760,
        uploadExpiresInSeconds: 1800,
      },
    });

    assert(result.ok);

    assert(result.config.defaultProvider === "database");
    assert(result.config.providers.database?.database.storageKeySuffix === "workspace");
    expect(result.config.providers.database?.database.limits).toMatchObject({
      maxSingleUploadBytes: 10485760,
      uploadExpiresInSeconds: 1800,
    });

    const response = buildUploadAdminConfigResponse(result.config);
    assert(response.configured);
    assert(response.defaultProvider === "database");
    assert(response.providers.database?.config?.storageKeyPrefix === "org/acme-dev/workspace");
  });

  test("applies a safe database object-size limit when omitted", () => {
    const result = resolveUploadAdminConfigInput({
      orgId: "acme-dev",
      now: "2026-03-08T10:00:00.000Z",
      payload: {
        provider: "database",
        defaultProvider: "database",
      },
    });

    assert(result.ok);

    expect(result.config.providers.database?.database.limits?.maxSingleUploadBytes).toBe(
      UPLOAD_DATABASE_DEFAULT_MAX_SINGLE_UPLOAD_BYTES,
    );
  });

  test("supports configuring multiple providers in one organisation", () => {
    const first = resolveUploadAdminConfigInput({
      orgId: "acme-dev",
      now: "2026-03-08T10:00:00.000Z",
      payload: {
        provider: "r2-binding",
        defaultProvider: "r2-binding",
        bindingName: "UPLOAD_BUCKET",
        storageKeySuffix: "uploads",
        maxMetadataBytes: 0,
      },
    });
    assert(first.ok);

    const second = resolveUploadAdminConfigInput({
      orgId: "acme-dev",
      now: "2026-03-08T11:00:00.000Z",
      existing: first.config,
      payload: {
        provider: "r2",
        defaultProvider: "r2",
        bucket: "acme-upload-bucket",
        endpoint: "https://123456.r2.cloudflarestorage.com",
        accessKeyId: TEST_ACCESS_KEY_ID,
        secretAccessKey: TEST_SECRET_ACCESS_KEY,
        region: "auto",
      },
    });

    assert(second.ok);

    assert(second.config.defaultProvider === "r2");
    assert(second.config.providers["r2-binding"]?.provider === "r2-binding");
    assert(second.config.providers.r2?.provider === "r2");
  });

  test("rejects unsupported provider values", () => {
    const result = resolveUploadAdminConfigInput({
      orgId: "acme",
      payload: {
        provider: "s3",
      },
    });

    assert(!result.ok);
    expect(result.message).toContain("Only providers 'database', 'r2', and 'r2-binding'");
  });

  test("rejects default provider when it is not configured", () => {
    const result = resolveUploadAdminConfigInput({
      orgId: "acme",
      payload: {
        provider: "r2-binding",
        defaultProvider: "r2",
        bindingName: "UPLOAD_BUCKET",
      },
    });

    assert(!result.ok);
    expect(result.message).toContain("not configured");
  });

  test("builds provider-scoped config response with masked previews", () => {
    const resolved = resolveUploadAdminConfigInput({
      orgId: "acme",
      now: "2026-03-08T10:00:00.000Z",
      payload: {
        provider: "r2",
        defaultProvider: "r2",
        bucket: "acme-upload-bucket",
        endpoint: "https://123456.r2.cloudflarestorage.com",
        accessKeyId: TEST_ACCESS_KEY_ID,
        secretAccessKey: TEST_SECRET_ACCESS_KEY,
      },
    });

    assert(resolved.ok);

    const response = buildUploadAdminConfigResponse(resolved.config);
    assert(response.configured);
    assert(response.defaultProvider === "r2");
    assert(response.providers.r2?.config?.accessKeyIdPreview === "ACCE...TEST");
    assert(response.providers.r2?.config?.secretAccessKeyPreview === "SECR...TEST");
    assert(response.providers.r2?.config?.storageKeyPrefix === "org/acme");
  });

  test("normalizes legacy single-provider config shape", () => {
    const normalized = normalizeStoredUploadAdminConfig({
      provider: "r2-binding",
      namespace: {
        orgId: "acme",
        orgPrefix: "org/acme",
        storageKeyPrefix: "org/acme",
      },
      r2Binding: {
        bindingName: "UPLOAD_BUCKET",
      },
      createdAt: "2026-03-08T10:00:00.000Z",
      updatedAt: "2026-03-08T10:00:00.000Z",
    });

    expect(normalized).not.toBeNull();
    assert(normalized?.defaultProvider === "r2-binding");
    assert(normalized?.providers["r2-binding"]?.r2Binding.bindingName === "UPLOAD_BUCKET");
  });

  test("drops persisted upload limits that fail current non-negative validation", () => {
    const normalized = normalizeStoredUploadAdminConfig({
      defaultProvider: "r2-binding",
      namespace: {
        orgId: "acme",
        orgPrefix: "org/acme",
      },
      providers: {
        "r2-binding": {
          provider: "r2-binding",
          r2Binding: {
            bindingName: "UPLOAD_BUCKET",
            limits: {
              maxMetadataBytes: 0,
              maxSingleUploadBytes: 1024,
              multipartPartSizeBytes: 0,
              uploadExpiresInSeconds: -60,
            },
          },
          createdAt: "2026-03-08T10:00:00.000Z",
          updatedAt: "2026-03-08T10:00:00.000Z",
        },
      },
      createdAt: "2026-03-08T10:00:00.000Z",
      updatedAt: "2026-03-08T10:00:00.000Z",
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.providers["r2-binding"]?.r2Binding.limits).toEqual({
      maxMetadataBytes: 0,
      maxSingleUploadBytes: 1024,
    });
  });
});
