import { describe, expect, test } from "vitest";
import { encodeFileKey, type FileKeyParts } from "../../keys";
import { createR2StorageAdapter } from "../r2";
import type { S3Signer } from "../s3";

const createSigner = (): S3Signer => ({
  presign: async (input) => ({
    url: `${input.url}&signed=1`,
    headers: input.headers ?? {},
  }),
  sign: async (input) => ({
    url: input.url,
    headers: input.headers ?? {},
  }),
});

describe("r2 storage adapter", () => {
  test("defaults to the R2 metadata limit", () => {
    const adapter = createR2StorageAdapter({
      bucket: "uploads",
      endpoint: "https://r2.example.com",
      signer: createSigner(),
    });

    expect(adapter.name).toBe("r2");
    expect(adapter.limits?.maxMetadataBytes).toBe(8192);
  });

  test("rejects metadata larger than the default limit", async () => {
    const adapter = createR2StorageAdapter({
      bucket: "uploads",
      endpoint: "https://r2.example.com",
      signer: createSigner(),
    });

    const fileKeyParts: FileKeyParts = ["orgs", 42, "asset"];
    const fileKey = encodeFileKey(fileKeyParts);
    const metadata = { note: "x".repeat(9000) };

    await expect(
      adapter.initUpload({
        fileKey,
        fileKeyParts,
        sizeBytes: 1024n,
        contentType: "text/plain",
        metadata,
      }),
    ).rejects.toThrow("Metadata exceeds maximum size");
  });
});
