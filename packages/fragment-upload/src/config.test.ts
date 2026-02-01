import { describe, expect, it } from "vitest";
import type { StorageAdapter } from "./storage/types";
import { resolveUploadFragmentConfig } from "./config";

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

    expect(config.signedUrlExpiresInSeconds).toBe(900);
    expect(config.uploadExpiresInSeconds).toBe(120);
    expect(config.multipartPartSizeBytes).toBe(5);
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

    expect(config.maxSingleUploadBytes).toBe(10);
    expect(config.maxMultipartUploadBytes).toBe(100);
    expect(config.multipartPartSizeBytes).toBe(2);
    expect(config.directUploadThresholdBytes).toBe(10);
    expect(config.multipartThresholdBytes).toBe(10);
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

    expect(config.signedUrlExpiresInSeconds).toBe(7200);
    expect(config.directUploadThresholdBytes).toBe(42);
  });
});
