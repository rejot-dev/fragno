import { describe, expect, test } from "vitest";
import {
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

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }

    expect(result.config.defaultProvider).toBe("r2");
    expect(result.config.namespace.orgPrefix).toBe("org/acme-dev");
    expect(result.config.providers.r2?.provider).toBe("r2");
    expect(result.config.providers.r2?.r2.endpoint).toBe("https://123456.r2.cloudflarestorage.com");
    expect(result.config.providers.r2?.r2.limits?.maxMetadataBytes).toBe(0);
    expect(result.config.providers.r2?.r2.limits?.uploadExpiresInSeconds).toBe(3600);
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
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error(first.message);
    }

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

    expect(second.ok).toBe(true);
    if (!second.ok) {
      throw new Error(second.message);
    }

    expect(second.config.defaultProvider).toBe("r2");
    expect(second.config.providers["r2-binding"]?.provider).toBe("r2-binding");
    expect(second.config.providers.r2?.provider).toBe("r2");
  });

  test("rejects unsupported provider values", () => {
    const result = resolveUploadAdminConfigInput({
      orgId: "acme",
      payload: {
        provider: "s3",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected failure");
    }
    expect(result.message).toContain("Only providers 'r2' and 'r2-binding'");
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

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected failure");
    }
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

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error(resolved.message);
    }

    const response = buildUploadAdminConfigResponse(resolved.config);
    expect(response.configured).toBe(true);
    expect(response.defaultProvider).toBe("r2");
    expect(response.providers.r2?.config?.accessKeyIdPreview).toBe("ACCE...TEST");
    expect(response.providers.r2?.config?.secretAccessKeyPreview).toBe("SECR...TEST");
    expect(response.providers.r2?.config?.storageKeyPrefix).toBe("org/acme");
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
    expect(normalized?.defaultProvider).toBe("r2-binding");
    expect(normalized?.providers["r2-binding"]?.r2Binding.bindingName).toBe("UPLOAD_BUCKET");
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
