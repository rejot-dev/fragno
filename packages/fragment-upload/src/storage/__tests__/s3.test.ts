import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { encodeFileKey, type FileKeyParts } from "../../keys";
import { createS3CompatibleStorageAdapter, type S3Signer, type S3SignerInput } from "../s3";

const createSigner = () => {
  const presignCalls: S3SignerInput[] = [];
  const signCalls: S3SignerInput[] = [];

  const signer: S3Signer = {
    presign: async (input) => {
      presignCalls.push(input);
      return {
        url: `${input.url}&signed=1`,
        headers: {
          ...input.headers,
          "x-test-signed": "true",
        },
      };
    },
    sign: async (input) => {
      signCalls.push(input);
      return {
        url: input.url,
        headers: {
          ...input.headers,
          authorization: "test",
        },
      };
    },
  };

  return { signer, presignCalls, signCalls };
};

const createAdapter = (
  overrides: Partial<Parameters<typeof createS3CompatibleStorageAdapter>[0]> = {},
) => {
  const { signer, presignCalls, signCalls } = createSigner();
  const adapter = createS3CompatibleStorageAdapter({
    bucket: "uploads",
    endpoint: "https://s3.example.com",
    signer,
    storageKeyPrefix: "fragno",
    pathStyle: true,
    ...overrides,
  });

  return { adapter, presignCalls, signCalls };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("s3 storage adapter", () => {
  test("initUpload returns a signed direct upload url", async () => {
    const { adapter, presignCalls } = createAdapter();
    const fileKeyParts: FileKeyParts = ["users", 1, "avatar"];
    const fileKey = encodeFileKey(fileKeyParts);

    const result = await adapter.initUpload({
      fileKey,
      fileKeyParts,
      sizeBytes: 1024n,
      contentType: "text/plain",
      metadata: null,
    });

    expect(result.strategy).toBe("direct-single");
    expect(result.uploadUrl).toContain("signed=1");
    expect(result.uploadHeaders?.["x-test-signed"]).toBe("true");
    expect(result.storageKey.startsWith("fragno/")).toBe(true);
    expect(result.storageKey.split("/").length).toBe(4);
    expect(presignCalls[0]?.method).toBe("PUT");
  });

  test("multipart init creates upload id and part urls", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : typeof (input as { url?: string }).url === "string"
              ? (input as { url: string }).url
              : "";
      if (url.includes("uploads=")) {
        return new Response("<UploadId>upload-123</UploadId>", { status: 200 });
      }

      return new Response("", { status: 200, headers: { ETag: '"etag-1"' } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { adapter, presignCalls, signCalls } = createAdapter({
      maxSingleUploadBytes: 5 * 1024 * 1024,
    });
    const fileKeyParts: FileKeyParts = ["orgs", 99, "asset"];
    const fileKey = encodeFileKey(fileKeyParts);

    const result = await adapter.initUpload({
      fileKey,
      fileKeyParts,
      sizeBytes: 6n * 1024n * 1024n,
      contentType: "application/octet-stream",
      metadata: null,
    });

    expect(result.strategy).toBe("direct-multipart");
    expect(result.storageUploadId).toBe("upload-123");
    expect(result.partSizeBytes).toBeGreaterThanOrEqual(5 * 1024 * 1024);
    expect(signCalls[0]?.method).toBe("POST");
    expect(fetchMock).toHaveBeenCalled();

    const partUrls = await adapter.getPartUploadUrls?.({
      storageKey: result.storageKey,
      storageUploadId: result.storageUploadId ?? "",
      partNumbers: [1, 2],
      partSizeBytes: result.partSizeBytes ?? 0,
    });

    expect(partUrls?.length).toBe(2);
    expect(partUrls?.[0]?.url).toContain("partNumber=1");
    expect(presignCalls.some((call) => call.method === "PUT")).toBe(true);
  });

  test("completeMultipartUpload returns an etag", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("", { status: 200, headers: { ETag: '"etag-complete"' } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { adapter } = createAdapter();

    const result = await adapter.completeMultipartUpload?.({
      storageKey: "fragno/s~a",
      storageUploadId: "upload-123",
      parts: [{ partNumber: 1, etag: '"etag-part"' }],
    });

    expect(result?.etag).toBe('"etag-complete"');
  });

  test("finalizeUpload verifies size and checksums when available", async () => {
    const md5Hex = "5d41402abc4b2a76b9719d911017c592";
    const shaBuffer = Buffer.alloc(32, 7);
    const shaHex = shaBuffer.toString("hex");
    const shaBase64 = shaBuffer.toString("base64");

    const fetchMock = vi.fn(async () => {
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Length": "5",
          ETag: `"${md5Hex}"`,
          "x-amz-checksum-sha256": shaBase64,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { adapter, signCalls } = createAdapter();
    if (!adapter.finalizeUpload) {
      throw new Error("Expected finalizeUpload");
    }

    const result = await adapter.finalizeUpload({
      storageKey: "fragno/s~a",
      expectedSizeBytes: 5n,
      checksum: { algo: "md5", value: md5Hex },
    });

    expect(result?.sizeBytes).toBe(5n);
    expect(signCalls.some((call) => call.method === "HEAD")).toBe(true);

    await adapter.finalizeUpload({
      storageKey: "fragno/s~a",
      expectedSizeBytes: 5n,
      checksum: { algo: "sha256", value: shaHex },
    });
  });

  test("finalizeUpload computes checksum when headers are missing", async () => {
    const payload = new TextEncoder().encode("abc");
    const sha = createHash("sha256").update(payload).digest("hex");

    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "Content-Length": String(payload.length),
          },
        });
      }

      return new Response(payload, {
        status: 200,
        headers: {
          "Content-Length": String(payload.length),
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { adapter, signCalls } = createAdapter();
    if (!adapter.finalizeUpload) {
      throw new Error("Expected finalizeUpload");
    }

    await adapter.finalizeUpload({
      storageKey: "fragno/s~a",
      expectedSizeBytes: BigInt(payload.length),
      checksum: { algo: "sha256", value: sha },
    });

    expect(signCalls.some((call) => call.method === "GET")).toBe(true);
  });

  test("finalizeUpload rejects checksum mismatch when headers are missing", async () => {
    const payload = new TextEncoder().encode("abc");
    const wrongSha = "00".repeat(32);

    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "Content-Length": String(payload.length),
          },
        });
      }

      return new Response(payload, {
        status: 200,
        headers: {
          "Content-Length": String(payload.length),
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { adapter } = createAdapter();
    if (!adapter.finalizeUpload) {
      throw new Error("Expected finalizeUpload");
    }

    await expect(
      adapter.finalizeUpload({
        storageKey: "fragno/s~a",
        expectedSizeBytes: BigInt(payload.length),
        checksum: { algo: "sha256", value: wrongSha },
      }),
    ).rejects.toThrow("INVALID_CHECKSUM");
  });

  test("finalizeUpload rejects size mismatches", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Length": "4",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { adapter } = createAdapter();
    if (!adapter.finalizeUpload) {
      throw new Error("Expected finalizeUpload");
    }

    await expect(
      adapter.finalizeUpload({
        storageKey: "fragno/s~a",
        expectedSizeBytes: 5n,
        checksum: null,
      }),
    ).rejects.toThrow("INVALID_CHECKSUM");
  });

  test("rejects presigned expirations beyond seven days", async () => {
    expect(() =>
      createS3CompatibleStorageAdapter({
        bucket: "uploads",
        endpoint: "https://s3.example.com",
        signer: createSigner().signer,
        uploadExpiresInSeconds: 60 * 60 * 24 * 8,
      }),
    ).toThrow("Expiration exceeds SigV4 maximum of 7 days");
  });
});
