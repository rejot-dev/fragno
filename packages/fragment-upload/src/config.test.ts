import { describe, expect, it, assert } from "vitest";

import { resolveUploadFragmentConfig } from "./config";
import type { StorageAdapter } from "./storage/types";

const createAdapter = (overrides: Partial<StorageAdapter> = {}): StorageAdapter => ({
  name: "test",
  capabilities: {
    directUpload: true,
    multipartUpload: true,
    signedDownload: true,
    proxyUpload: true,
  },
  resolveStorageKey: () => "uploads/test",
  initUpload: async () => ({
    strategy: "proxy",
    storageKey: "uploads/test",
    expiresAt: new Date(0),
  }),
  deleteObject: async () => {},
  ...overrides,
});

describe("resolveUploadFragmentConfig", () => {
  it("defaults signedUrlExpiresInSeconds to 1 hour", () => {
    const config = resolveUploadFragmentConfig({ storage: createAdapter() });

    expect(config.signedUrlExpiresInSeconds).toBe(60 * 60);
  });

  it("uses adapter recommendations when provided", () => {
    const config = resolveUploadFragmentConfig({
      storage: createAdapter({
        recommendations: {
          signedUrlExpiresInSeconds: 900,
          uploadExpiresInSeconds: 120,
          multipartPartSizeBytes: 5,
        },
      }),
    });

    assert(config.signedUrlExpiresInSeconds === 900);
    assert(config.uploadExpiresInSeconds === 120);
    assert(config.multipartPartSizeBytes === 5);
  });

  it("falls back to adapter limits when thresholds are not provided", () => {
    const config = resolveUploadFragmentConfig({
      storage: createAdapter({
        limits: {
          maxSingleUploadBytes: 10,
          maxMultipartUploadBytes: 100,
          minMultipartPartSizeBytes: 2,
        },
      }),
    });

    assert(config.maxSingleUploadBytes === 10);
    assert(config.maxMultipartUploadBytes === 100);
    assert(config.multipartPartSizeBytes === 2);
    assert(config.directUploadThresholdBytes === 10);
    assert(config.multipartThresholdBytes === 10);
  });

  it("respects explicit overrides", () => {
    const config = resolveUploadFragmentConfig({
      storage: createAdapter({
        limits: { maxSingleUploadBytes: 10 },
        recommendations: { signedUrlExpiresInSeconds: 900 },
      }),
      signedUrlExpiresInSeconds: 7200,
      directUploadThresholdBytes: 42,
    });

    assert(config.signedUrlExpiresInSeconds === 7200);
    assert(config.directUploadThresholdBytes === 42);
  });
});
