import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createR2BindingStorageAdapter,
  resolveR2BindingBucket,
  type R2BindingBucket,
} from "../r2-binding";

const BYTES_IN_MIB = 1024 * 1024;

const streamFromBytes = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

const concatBytes = (chunks: Uint8Array[]) => {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
};

const createInMemoryBucket = (options?: { failPartNumber?: number }) => {
  const store = new Map<
    string,
    { payload: Uint8Array; contentType?: string | undefined; etag: string }
  >();
  const multipartSessions = new Map<
    string,
    {
      key: string;
      contentType?: string;
      parts: Map<number, { etag: string; payload: Uint8Array }>;
    }
  >();
  const stats = {
    putCalls: 0,
    createMultipartUploadCalls: 0,
    uploadPartCalls: 0,
    completeCalls: 0,
    abortCalls: 0,
    uploadedPartNumbers: [] as number[],
  };
  let sequence = 0;
  let uploadSequence = 0;

  const bucket: R2BindingBucket = {
    put: async (key, value, options) => {
      stats.putCalls += 1;
      const payload = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
      const etag = `etag-${++sequence}`;
      store.set(key, {
        payload,
        contentType: options?.httpMetadata?.contentType,
        etag,
      });
      return {
        httpEtag: etag,
        size: payload.byteLength,
      };
    },
    get: async (key) => {
      const hit = store.get(key);
      if (!hit) {
        return null;
      }

      return {
        body: streamFromBytes(hit.payload),
        size: hit.payload.byteLength,
        httpEtag: hit.etag,
        httpMetadata: hit.contentType ? { contentType: hit.contentType } : undefined,
      };
    },
    delete: async (key) => {
      store.delete(key);
    },
    createMultipartUpload: async (key, uploadOptions) => {
      stats.createMultipartUploadCalls += 1;
      const uploadId = `upload-${++uploadSequence}`;
      multipartSessions.set(uploadId, {
        key,
        contentType: uploadOptions?.httpMetadata?.contentType,
        parts: new Map(),
      });

      return {
        uploadId,
        uploadPart: async (partNumber, value) => {
          stats.uploadPartCalls += 1;
          stats.uploadedPartNumbers.push(partNumber);

          if (options?.failPartNumber === partNumber) {
            throw new Error("part upload failed");
          }

          const session = multipartSessions.get(uploadId);
          if (!session) {
            throw new Error("missing multipart session");
          }

          const payload = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
          const etag = `part-${uploadId}-${partNumber}`;
          session.parts.set(partNumber, { etag, payload });

          return { partNumber, etag };
        },
        complete: async (parts) => {
          stats.completeCalls += 1;

          const session = multipartSessions.get(uploadId);
          if (!session) {
            throw new Error("missing multipart session");
          }

          const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
          const payloadParts: Uint8Array[] = [];
          for (const part of ordered) {
            const uploaded = session.parts.get(part.partNumber);
            if (!uploaded || uploaded.etag !== part.etag) {
              throw new Error("missing multipart part");
            }
            payloadParts.push(uploaded.payload);
          }

          const payload = concatBytes(payloadParts);
          const etag = `etag-${++sequence}`;
          store.set(session.key, {
            payload,
            contentType: session.contentType,
            etag,
          });
          multipartSessions.delete(uploadId);

          return {
            httpEtag: etag,
            size: payload.byteLength,
          };
        },
        abort: async () => {
          stats.abortCalls += 1;
          multipartSessions.delete(uploadId);
        },
      };
    },
  };

  return {
    bucket,
    stats,
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("r2 binding storage adapter", () => {
  const provider = "r2-binding";

  test("uses proxy strategy and exposes expected capabilities", async () => {
    const { bucket } = createInMemoryBucket();
    const adapter = createR2BindingStorageAdapter({
      bucket,
      storageKeyPrefix: "org/acme",
      maxMetadataBytes: 32,
    });
    const fileKey = "users/1/avatar";

    const result = await adapter.initUpload({
      provider,
      fileKey,
      sizeBytes: 16n,
      contentType: "text/plain",
      metadata: { source: "test" },
    });

    expect(result.strategy).toBe("proxy");
    expect(adapter.name).toBe("r2-binding");
    expect(adapter.capabilities.proxyUpload).toBe(true);
    expect(adapter.capabilities.directUpload).toBe(false);
    expect(adapter.capabilities.multipartUpload).toBe(true);
    expect(adapter.limits?.maxMetadataBytes).toBe(32);
    expect(adapter.limits?.minMultipartPartSizeBytes).toBe(5 * BYTES_IN_MIB);
  });

  test("rejects metadata larger than configured limit", async () => {
    const { bucket } = createInMemoryBucket();
    const adapter = createR2BindingStorageAdapter({
      bucket,
      maxMetadataBytes: 16,
    });
    const fileKey = "users/2/avatar";

    await expect(
      adapter.initUpload({
        provider,
        fileKey,
        sizeBytes: 16n,
        contentType: "text/plain",
        metadata: {
          note: "x".repeat(100),
        },
      }),
    ).rejects.toThrow("Metadata exceeds maximum size");
  });

  test("writes, reads, and deletes objects through the bucket binding", async () => {
    const { bucket } = createInMemoryBucket();
    const adapter = createR2BindingStorageAdapter({
      bucket,
    });
    const fileKey = "users/3/avatar";
    const storageKey = adapter.resolveStorageKey({ provider, fileKey });
    const payload = new TextEncoder().encode("hello from r2 binding");

    if (!adapter.writeStream || !adapter.getDownloadStream) {
      throw new Error("Expected proxy upload adapter with stream support");
    }

    await adapter.writeStream({
      storageKey,
      body: streamFromBytes(payload),
      contentType: "text/plain",
      sizeBytes: BigInt(payload.byteLength),
    });

    const response = await adapter.getDownloadStream({
      storageKey,
    });
    const text = await response.text();
    expect(text).toBe("hello from r2 binding");
    expect(response.headers.get("Content-Type")).toBe("text/plain");

    await adapter.deleteObject({
      storageKey,
    });

    await expect(
      adapter.getDownloadStream({
        storageKey,
      }),
    ).rejects.toThrow("STORAGE_ERROR");
  });

  test("uses single put below multipart threshold", async () => {
    const inMemory = createInMemoryBucket();
    const adapter = createR2BindingStorageAdapter({
      bucket: inMemory.bucket,
      multipartThresholdBytes: 5 * BYTES_IN_MIB,
      multipartPartSizeBytes: 5 * BYTES_IN_MIB,
    });
    const fileKey = "users/4/avatar";
    const storageKey = adapter.resolveStorageKey({ provider, fileKey });
    const payload = new Uint8Array(BYTES_IN_MIB);
    payload.fill(7);

    if (!adapter.writeStream) {
      throw new Error("Expected writeStream for proxy adapter");
    }

    await adapter.writeStream({
      storageKey,
      body: streamFromBytes(payload),
      contentType: "application/octet-stream",
      sizeBytes: BigInt(payload.byteLength),
    });

    expect(inMemory.stats.putCalls).toBe(1);
    expect(inMemory.stats.createMultipartUploadCalls).toBe(0);
    expect(inMemory.stats.uploadPartCalls).toBe(0);
  });

  test("uses multipart uploads above threshold and persists assembled content", async () => {
    const inMemory = createInMemoryBucket();
    const adapter = createR2BindingStorageAdapter({
      bucket: inMemory.bucket,
      multipartThresholdBytes: 5 * BYTES_IN_MIB,
      multipartPartSizeBytes: 5 * BYTES_IN_MIB,
    });
    const fileKey = "users/5/avatar";
    const storageKey = adapter.resolveStorageKey({ provider, fileKey });
    const payload = new Uint8Array(5 * BYTES_IN_MIB + 123);
    payload.fill(3);

    if (!adapter.writeStream || !adapter.getDownloadStream) {
      throw new Error("Expected proxy adapter with upload/download stream support");
    }

    const writeResult = await adapter.writeStream({
      storageKey,
      body: streamFromBytes(payload),
      contentType: "application/octet-stream",
      sizeBytes: BigInt(payload.byteLength),
    });

    expect(writeResult.sizeBytes).toBe(BigInt(payload.byteLength));
    expect(inMemory.stats.putCalls).toBe(0);
    expect(inMemory.stats.createMultipartUploadCalls).toBe(1);
    expect(inMemory.stats.uploadPartCalls).toBe(2);
    expect(inMemory.stats.uploadedPartNumbers).toEqual([1, 2]);
    expect(inMemory.stats.completeCalls).toBe(1);

    const response = await adapter.getDownloadStream({ storageKey });
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBe(payload.byteLength);
    expect(bytes[0]).toBe(3);
    expect(bytes[bytes.length - 1]).toBe(3);
  });

  test("aborts multipart upload when a part fails", async () => {
    const inMemory = createInMemoryBucket({
      failPartNumber: 2,
    });
    const adapter = createR2BindingStorageAdapter({
      bucket: inMemory.bucket,
      multipartThresholdBytes: 5 * BYTES_IN_MIB,
      multipartPartSizeBytes: 5 * BYTES_IN_MIB,
    });
    const fileKey = "users/6/avatar";
    const storageKey = adapter.resolveStorageKey({ provider, fileKey });
    const payload = new Uint8Array(11 * BYTES_IN_MIB);
    payload.fill(9);

    if (!adapter.writeStream) {
      throw new Error("Expected writeStream for proxy adapter");
    }

    await expect(
      adapter.writeStream({
        storageKey,
        body: streamFromBytes(payload),
        contentType: "application/octet-stream",
        sizeBytes: BigInt(payload.byteLength),
      }),
    ).rejects.toThrow("part upload failed");

    expect(inMemory.stats.createMultipartUploadCalls).toBe(1);
    expect(inMemory.stats.uploadPartCalls).toBe(2);
    expect(inMemory.stats.completeCalls).toBe(0);
    expect(inMemory.stats.abortCalls).toBe(1);
  });

  test("rejects multipart part sizes smaller than the R2 minimum", () => {
    const { bucket } = createInMemoryBucket();
    expect(() =>
      createR2BindingStorageAdapter({
        bucket,
        multipartPartSizeBytes: BYTES_IN_MIB,
      }),
    ).toThrow("Multipart part size must be at least 5242880 bytes for R2 uploads");
  });

  test("falls back to TextEncoder when Buffer is unavailable", async () => {
    const { bucket } = createInMemoryBucket();
    vi.stubGlobal("Buffer", undefined);

    const adapter = createR2BindingStorageAdapter({
      bucket,
      maxMetadataBytes: 128,
      maxStorageKeyLengthBytes: 128,
    });
    const fileKey = "users/8/avatar";

    expect(adapter.resolveStorageKey({ provider, fileKey })).toBe("r2-binding/users/8/avatar");

    await expect(
      adapter.initUpload({
        provider,
        fileKey,
        sizeBytes: 16n,
        contentType: "text/plain",
        metadata: {
          source: "edge-runtime",
        },
      }),
    ).resolves.toMatchObject({
      strategy: "proxy",
    });
  });
});

describe("resolveR2BindingBucket", () => {
  test("returns a matching binding and rejects missing or invalid bindings", () => {
    const { bucket } = createInMemoryBucket();

    expect(
      resolveR2BindingBucket(
        {
          UPLOAD_BUCKET: bucket,
        },
        "UPLOAD_BUCKET",
      ),
    ).toBe(bucket);

    expect(() =>
      resolveR2BindingBucket(
        {
          UPLOAD_BUCKET: {},
        },
        "UPLOAD_BUCKET",
      ),
    ).toThrow("Upload R2 bucket binding 'UPLOAD_BUCKET' is not configured.");

    expect(() =>
      resolveR2BindingBucket(
        {
          UPLOAD_BUCKET: {
            put: bucket.put,
            get: bucket.get,
            delete: bucket.delete,
          },
        },
        "UPLOAD_BUCKET",
      ),
    ).toThrow("Upload R2 bucket binding 'UPLOAD_BUCKET' is not configured.");

    expect(() => resolveR2BindingBucket({}, "UPLOAD_BUCKET")).toThrow(
      "Upload R2 bucket binding 'UPLOAD_BUCKET' is not configured.",
    );
  });
});
