import { afterAll, beforeEach, describe, expect, it, assert, vi } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import type { StorageAdapter } from "./storage/types";
import { uploadFragmentDefinition } from "./definition";
import { uploadRoutes } from "./index";
import { createFilesystemStorageAdapter } from "./storage/fs";

const createDirectAdapter = (strategy: "direct-single" | "direct-multipart") => {
  const finalizeUpload = vi.fn(async () => ({ etag: "etag-final" }));
  const completeMultipartUpload = vi.fn(async () => ({ etag: "etag-complete" }));

  const adapter: StorageAdapter = {
    name: "direct-test",
    capabilities: {
      directUpload: true,
      multipartUpload: true,
      signedDownload: false,
      proxyUpload: false,
    },
    resolveStorageKey: ({ fileKey }) => `store/${fileKey}`,
    initUpload: async ({ fileKey }) => {
      if (strategy === "direct-multipart") {
        return {
          strategy: "direct-multipart",
          storageKey: `store/${fileKey}`,
          storageUploadId: "upload-123",
          partSizeBytes: 3,
          expiresAt: new Date(Date.now() + 60_000),
        };
      }

      return {
        strategy: "direct-single",
        storageKey: `store/${fileKey}`,
        expiresAt: new Date(Date.now() + 60_000),
        uploadUrl: "https://storage.local/upload",
        uploadHeaders: { "Content-Type": "text/plain" },
      };
    },
    getPartUploadUrls: async ({ partNumbers }) =>
      partNumbers.map((partNumber) => ({
        partNumber,
        url: `https://storage.local/part/${partNumber}`,
      })),
    completeMultipartUpload,
    finalizeUpload,
    deleteObject: async () => {},
  };

  return { adapter, finalizeUpload, completeMultipartUpload };
};

describe("upload fragment direct single flows", async () => {
  const { adapter, finalizeUpload } = createDirectAdapter("direct-single");
  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "upload",
      instantiate(uploadFragmentDefinition)
        .withConfig({ storage: adapter })
        .withRoutes(uploadRoutes),
    )
    .build();

  const { fragment, db } = fragments["upload"];

  beforeEach(async () => {
    await testContext.resetDatabase();
    finalizeUpload.mockClear();
  });

  it("completes a direct single upload", async () => {
    const createResponse = await fragment.callRoute("POST", "/uploads", {
      body: {
        keyParts: ["files", "direct", 1],
        filename: "hello.txt",
        sizeBytes: 5,
        contentType: "text/plain",
      },
    });

    assert(createResponse.type === "json");
    expect(createResponse.data.strategy).toBe("direct-single");

    const completeResponse = await fragment.callRoute("POST", "/uploads/:uploadId/complete", {
      pathParams: { uploadId: createResponse.data.uploadId },
      body: {},
    });

    assert(completeResponse.type === "json");
    expect(completeResponse.data.status).toBe("ready");
    expect(finalizeUpload).toHaveBeenCalled();

    const stored = await db.findFirst("file", (b) =>
      b.whereIndex("idx_file_key", (eb) => eb("fileKey", "=", createResponse.data.fileKey)),
    );

    expect(stored?.status).toBe("ready");
  });

  it("rejects completing an upload twice", async () => {
    const createResponse = await fragment.callRoute("POST", "/uploads", {
      body: {
        keyParts: ["files", "direct", 2],
        filename: "hello.txt",
        sizeBytes: 2,
        contentType: "text/plain",
      },
    });

    assert(createResponse.type === "json");

    const firstComplete = await fragment.callRoute("POST", "/uploads/:uploadId/complete", {
      pathParams: { uploadId: createResponse.data.uploadId },
      body: {},
    });

    assert(firstComplete.type === "json");

    const secondComplete = await fragment.callRoute("POST", "/uploads/:uploadId/complete", {
      pathParams: { uploadId: createResponse.data.uploadId },
      body: {},
    });

    assert(secondComplete.type === "error");
    expect(secondComplete.status).toBe(409);
    expect(secondComplete.error.code).toBe("UPLOAD_INVALID_STATE");
  });

  it("rejects expired uploads", async () => {
    const createResponse = await fragment.callRoute("POST", "/uploads", {
      body: {
        keyParts: ["files", "direct", 3],
        filename: "hello.txt",
        sizeBytes: 2,
        contentType: "text/plain",
      },
    });

    assert(createResponse.type === "json");

    await db.update("upload", createResponse.data.uploadId, (b) =>
      b.set({ expiresAt: new Date(Date.now() - 1000) }),
    );

    const response = await fragment.callRoute("POST", "/uploads/:uploadId/complete", {
      pathParams: { uploadId: createResponse.data.uploadId },
      body: {},
    });

    assert(response.type === "error");
    expect(response.status).toBe(410);
    expect(response.error.code).toBe("UPLOAD_EXPIRED");
  });

  it("surfaces checksum mismatches", async () => {
    const checksumAdapter: StorageAdapter = {
      ...adapter,
      finalizeUpload: async () => {
        throw new Error("INVALID_CHECKSUM");
      },
    };

    const { fragments: checksumFragments, test: checksumContext } =
      await buildDatabaseFragmentsTest()
        .withTestAdapter({ type: "drizzle-pglite" })
        .withFragment(
          "upload",
          instantiate(uploadFragmentDefinition)
            .withConfig({ storage: checksumAdapter })
            .withRoutes(uploadRoutes),
        )
        .build();

    await checksumContext.resetDatabase();

    const { fragment: checksumFragment } = checksumFragments["upload"];
    const createResponse = await checksumFragment.callRoute("POST", "/uploads", {
      body: {
        keyParts: ["files", "checksum", 1],
        filename: "hello.txt",
        sizeBytes: 2,
        contentType: "text/plain",
        checksum: { algo: "sha256", value: "deadbeef" },
      },
    });

    assert(createResponse.type === "json");

    const response = await checksumFragment.callRoute("POST", "/uploads/:uploadId/complete", {
      pathParams: { uploadId: createResponse.data.uploadId },
      body: {},
    });

    assert(response.type === "error");
    expect(response.status).toBe(400);
    expect(response.error.code).toBe("INVALID_CHECKSUM");
  });
});

describe("upload fragment direct multipart flows", async () => {
  const { adapter, completeMultipartUpload } = createDirectAdapter("direct-multipart");
  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "upload",
      instantiate(uploadFragmentDefinition)
        .withConfig({ storage: adapter })
        .withRoutes(uploadRoutes),
    )
    .build();

  const { fragment } = fragments["upload"];

  beforeEach(async () => {
    await testContext.resetDatabase();
    completeMultipartUpload.mockClear();
  });

  it("tracks multipart uploads", async () => {
    const createResponse = await fragment.callRoute("POST", "/uploads", {
      body: {
        keyParts: ["files", "multipart", 1],
        filename: "movie.mp4",
        sizeBytes: 8,
        contentType: "video/mp4",
      },
    });

    assert(createResponse.type === "json");
    expect(createResponse.data.strategy).toBe("direct-multipart");

    const partsResponse = await fragment.callRoute("POST", "/uploads/:uploadId/parts", {
      pathParams: { uploadId: createResponse.data.uploadId },
      body: { partNumbers: [1, 2, 3] },
    });

    assert(partsResponse.type === "json");
    expect(partsResponse.data.parts).toHaveLength(3);

    const partsComplete = await fragment.callRoute("POST", "/uploads/:uploadId/parts/complete", {
      pathParams: { uploadId: createResponse.data.uploadId },
      body: {
        parts: [
          { partNumber: 1, etag: "etag-1", sizeBytes: 3 },
          { partNumber: 2, etag: "etag-2", sizeBytes: 3 },
          { partNumber: 3, etag: "etag-3", sizeBytes: 2 },
        ],
      },
    });

    assert(partsComplete.type === "json");

    const completeResponse = await fragment.callRoute("POST", "/uploads/:uploadId/complete", {
      pathParams: { uploadId: createResponse.data.uploadId },
      body: {
        parts: [
          { partNumber: 1, etag: "etag-1" },
          { partNumber: 2, etag: "etag-2" },
          { partNumber: 3, etag: "etag-3" },
        ],
      },
    });

    assert(completeResponse.type === "json");
    expect(completeResponse.data.status).toBe("ready");
    expect(completeMultipartUpload).toHaveBeenCalledWith({
      storageKey: `store/${createResponse.data.fileKey}`,
      storageUploadId: "upload-123",
      parts: [
        { partNumber: 1, etag: "etag-1" },
        { partNumber: 2, etag: "etag-2" },
        { partNumber: 3, etag: "etag-3" },
      ],
    });
  });
});

describe("upload fragment proxy streaming", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragno-upload-fragment-"));
  const storage = createFilesystemStorageAdapter({ rootDir });

  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "upload",
      instantiate(uploadFragmentDefinition).withConfig({ storage }).withRoutes(uploadRoutes),
    )
    .build();

  const { fragment } = fragments["upload"];

  beforeEach(async () => {
    await testContext.resetDatabase();
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.mkdir(rootDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("streams proxy uploads to storage", async () => {
    const createResponse = await fragment.callRoute("POST", "/uploads", {
      body: {
        keyParts: ["files", "proxy", 1],
        filename: "hello.txt",
        sizeBytes: 5,
        contentType: "text/plain",
      },
    });

    assert(createResponse.type === "json");

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    });

    const uploadResponse = await fragment.callRoute("PUT", "/uploads/:uploadId/content", {
      pathParams: { uploadId: createResponse.data.uploadId },
      body: stream,
    });

    assert(uploadResponse.type === "json");
    expect(uploadResponse.data.status).toBe("ready");
  });
});
