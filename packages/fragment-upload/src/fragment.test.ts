import { afterAll, beforeAll, beforeEach, describe, expect, it, assert, vi } from "vitest";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import { getInternalFragment } from "@fragno-dev/db";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import type { StorageAdapter } from "./storage/types";
import { uploadFragmentDefinition } from "./definition";
import { uploadRoutes } from "./index";
import { createFilesystemStorageAdapter } from "./storage/fs";
import { uploadSchema } from "./schema";
import type { UploadFragmentConfig } from "./config";

const createDirectAdapter = (
  strategy: "direct-single" | "direct-multipart",
  expiresAtOverride?: Date,
) => {
  const finalizeUpload = vi.fn(async () => ({ etag: "etag-final" }));
  const completeMultipartUpload = vi.fn(async () => ({ etag: "etag-complete" }));
  const expiresAt = expiresAtOverride ?? new Date(Date.now() + 60_000);
  const initUploadMock = vi.fn<StorageAdapter["initUpload"]>(async ({ fileKey }) => {
    if (strategy === "direct-multipart") {
      return {
        strategy: "direct-multipart" as const,
        storageKey: `store/${fileKey}`,
        storageUploadId: "upload-123",
        partSizeBytes: 3,
        expiresAt,
      };
    }

    return {
      strategy: "direct-single" as const,
      storageKey: `store/${fileKey}`,
      expiresAt,
      uploadUrl: "https://storage.local/upload",
      uploadHeaders: { "Content-Type": "text/plain" },
    };
  });

  const adapter: StorageAdapter = {
    name: "direct-test",
    capabilities: {
      directUpload: true,
      multipartUpload: true,
      signedDownload: false,
      proxyUpload: false,
    },
    resolveStorageKey: ({ fileKey }) => `store/${fileKey}`,
    initUpload: initUploadMock,
    getPartUploadUrls: async ({ partNumbers }) =>
      partNumbers.map((partNumber) => ({
        partNumber,
        url: `https://storage.local/part/${partNumber}`,
      })),
    completeMultipartUpload,
    finalizeUpload,
    deleteObject: async () => {},
  };

  return {
    adapter,
    finalizeUpload,
    completeMultipartUpload,
    expiresAt,
    initUpload: initUploadMock,
  };
};

const buildUploadFragment = async (config: UploadFragmentConfig) =>
  buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "upload",
      instantiate(uploadFragmentDefinition).withConfig(config).withRoutes(uploadRoutes),
    )
    .build();

type UploadBuild = Awaited<ReturnType<typeof buildUploadFragment>>;

const withUploadBuild = async (
  config: UploadFragmentConfig,
  fn: (build: UploadBuild) => Promise<void>,
) => {
  const build = await buildUploadFragment(config);
  try {
    await build.test.resetDatabase();
    await fn(build);
  } finally {
    await build.test.cleanup();
  }
};

describe("upload fragment direct single flows", () => {
  const { adapter, finalizeUpload, initUpload } = createDirectAdapter("direct-single");
  let build!: UploadBuild;

  beforeAll(async () => {
    build = await buildUploadFragment({ storage: adapter });
  });

  beforeEach(async () => {
    await build.test.resetDatabase();
    finalizeUpload.mockClear();
    initUpload.mockClear();
  });

  afterAll(async () => {
    await build.test.cleanup();
  });

  it("completes a direct single upload", async () => {
    const { fragment, db } = build.fragments.upload;
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

  it("reuses an upload when checksum and metadata match", async () => {
    const { fragment } = build.fragments.upload;
    const payload = {
      keyParts: ["files", "direct", 10],
      filename: "hello.txt",
      sizeBytes: 5,
      contentType: "text/plain",
      checksum: { algo: "sha256" as const, value: "deadbeef" },
    };

    const first = await fragment.callRoute("POST", "/uploads", {
      body: payload,
    });

    assert(first.type === "json");

    const second = await fragment.callRoute("POST", "/uploads", {
      body: payload,
    });

    assert(second.type === "json");
    expect(second.data.uploadId).toBe(first.data.uploadId);
    expect(second.data.fileKey).toBe(first.data.fileKey);
    expect(initUpload).toHaveBeenCalledTimes(2);
  });

  it("rejects creating a second upload when metadata mismatches", async () => {
    const { fragment } = build.fragments.upload;
    const first = await fragment.callRoute("POST", "/uploads", {
      body: {
        keyParts: ["files", "direct", 11],
        filename: "hello.txt",
        sizeBytes: 5,
        contentType: "text/plain",
        checksum: { algo: "sha256" as const, value: "deadbeef" },
      },
    });

    assert(first.type === "json");

    const second = await fragment.callRoute("POST", "/uploads", {
      body: {
        keyParts: ["files", "direct", 11],
        filename: "different.txt",
        sizeBytes: 5,
        contentType: "text/plain",
        checksum: { algo: "sha256" as const, value: "deadbeef" },
      },
    });

    assert(second.type === "error");
    expect(second.status).toBe(409);
    expect(second.error.code).toBe("UPLOAD_ALREADY_ACTIVE");
    expect(initUpload).toHaveBeenCalledTimes(2);
  });

  it("rejects creating a second upload when checksum is missing", async () => {
    const { fragment } = build.fragments.upload;
    const first = await fragment.callRoute("POST", "/uploads", {
      body: {
        keyParts: ["files", "direct", 12],
        filename: "hello.txt",
        sizeBytes: 5,
        contentType: "text/plain",
      },
    });

    assert(first.type === "json");

    const second = await fragment.callRoute("POST", "/uploads", {
      body: {
        keyParts: ["files", "direct", 12],
        filename: "hello.txt",
        sizeBytes: 5,
        contentType: "text/plain",
      },
    });

    assert(second.type === "error");
    expect(second.status).toBe(409);
    expect(second.error.code).toBe("UPLOAD_ALREADY_ACTIVE");
    expect(initUpload).toHaveBeenCalledTimes(2);
  });

  it("rejects completing an upload twice", async () => {
    const { fragment } = build.fragments.upload;
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
    expect(secondComplete.error.code).toBe("FILE_ALREADY_EXISTS");
  });

  it("rejects expired uploads", async () => {
    const { fragment, db } = build.fragments.upload;
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

  it("returns INTERNAL_SERVER_ERROR when completing an upload after a file is created", async () => {
    const { fragment, db } = build.fragments.upload;
    const createResponse = await fragment.callRoute("POST", "/uploads", {
      body: {
        keyParts: ["files", "direct", 13],
        filename: "hello.txt",
        sizeBytes: 5,
        contentType: "text/plain",
      },
    });

    assert(createResponse.type === "json");

    const upload = await db.findFirst("upload", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", createResponse.data.uploadId)),
    );
    expect(upload).toBeTruthy();
    if (!upload) {
      throw new Error("Upload row missing");
    }

    const now = new Date();
    await db.create("file", {
      fileKey: upload.fileKey,
      uploaderId: upload.uploaderId,
      filename: upload.filename,
      sizeBytes: upload.expectedSizeBytes,
      contentType: upload.contentType,
      checksum: upload.checksum,
      visibility: upload.visibility,
      tags: upload.tags,
      metadata: upload.metadata,
      status: "ready",
      storageProvider: upload.storageProvider,
      storageKey: upload.storageKey,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      deletedAt: null,
      errorCode: null,
      errorMessage: null,
    });

    const completeResponse = await fragment.callRoute("POST", "/uploads/:uploadId/complete", {
      pathParams: { uploadId: createResponse.data.uploadId },
      body: {},
    });

    assert(completeResponse.type === "error");
    expect(completeResponse.status).toBe(500);
    expect(completeResponse.error.code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("surfaces checksum mismatches", async () => {
    const checksumAdapter = {
      ...adapter,
      finalizeUpload: async () => {
        throw new Error("INVALID_CHECKSUM");
      },
    } satisfies StorageAdapter;

    await withUploadBuild({ storage: checksumAdapter }, async ({ fragments }) => {
      const { fragment: checksumFragment } = fragments.upload;
      const createResponse = await checksumFragment.callRoute("POST", "/uploads", {
        body: {
          keyParts: ["files", "checksum", 1],
          filename: "hello.txt",
          sizeBytes: 2,
          contentType: "text/plain",
          checksum: { algo: "sha256" as const, value: "deadbeef" },
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

  it("schedules an upload timeout hook", async () => {
    const { adapter: timedAdapter, expiresAt } = createDirectAdapter(
      "direct-single",
      new Date(Date.now() + 30_000),
    );

    await withUploadBuild({ storage: timedAdapter }, async ({ fragments, test }) => {
      const { fragment: timedFragment } = fragments.upload;
      const createResponse = await timedFragment.callRoute("POST", "/uploads", {
        body: {
          keyParts: ["files", "direct", 4],
          filename: "hello.txt",
          sizeBytes: 2,
          contentType: "text/plain",
        },
      });

      assert(createResponse.type === "json");

      const internalFragment = getInternalFragment(test.adapter);
      const hooks = await internalFragment.inContext(async function () {
        return await this.handlerTx()
          .withServiceCalls(
            () => [internalFragment.services.hookService.getHooksByNamespace("upload")] as const,
          )
          .transform(({ serviceResult: [result] }) => result)
          .execute();
      });

      const timeoutHook = hooks.find((hook) => hook.hookName === "onUploadTimeout");
      expect(timeoutHook).toBeDefined();
      expect(timeoutHook?.nextRetryAt?.getTime()).toBe(expiresAt.getTime());
    });
  });

  it("marks uploads expired when timeout hook executes", async () => {
    const { adapter: expiredAdapter } = createDirectAdapter(
      "direct-single",
      new Date(Date.now() - 1_000),
    );

    await withUploadBuild({ storage: expiredAdapter }, async ({ fragments }) => {
      const { fragment: expiredFragment, db: expiredDb } = fragments.upload;
      const createResponse = await expiredFragment.callRoute("POST", "/uploads", {
        body: {
          keyParts: ["files", "direct", 5],
          filename: "hello.txt",
          sizeBytes: 2,
          contentType: "text/plain",
        },
      });

      assert(createResponse.type === "json");

      await drainDurableHooks(expiredFragment);

      const upload = await expiredDb.findFirst("upload", (b) =>
        b.whereIndex("primary", (eb) => eb("id", "=", createResponse.data.uploadId)),
      );

      const file = await expiredDb.findFirst("file", (b) =>
        b.whereIndex("idx_file_key", (eb) => eb("fileKey", "=", createResponse.data.fileKey)),
      );

      expect(upload?.status).toBe("expired");
      expect(upload?.errorCode).toBe("UPLOAD_EXPIRED");
      expect(file).toBeNull();
    });
  });

  it("does not overwrite a completed retry when the timeout hook runs", async () => {
    const { fragment, db } = build.fragments.upload;
    const createResponse = await fragment.callRoute("POST", "/uploads", {
      body: {
        keyParts: ["files", "direct", 14],
        filename: "hello.txt",
        sizeBytes: 5,
        contentType: "text/plain",
      },
    });

    assert(createResponse.type === "json");

    await db.update("upload", createResponse.data.uploadId, (b) =>
      b.set({ expiresAt: new Date(Date.now() - 1_000) }),
    );

    const retryResponse = await fragment.callRoute("POST", "/uploads", {
      body: {
        keyParts: ["files", "direct", 14],
        filename: "hello.txt",
        sizeBytes: 5,
        contentType: "text/plain",
        checksum: { algo: "sha256" as const, value: "deadbeef" },
      },
    });

    assert(retryResponse.type === "json");

    const completedRetry = await fragment.callRoute("POST", "/uploads/:uploadId/complete", {
      pathParams: { uploadId: retryResponse.data.uploadId },
      body: {},
    });

    assert(completedRetry.type === "json");
    expect(completedRetry.data.status).toBe("ready");

    const internalFragment = getInternalFragment(build.test.adapter);
    const hooks = await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [internalFragment.services.hookService.getHooksByNamespace("upload")] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });

    const timeoutHook = hooks.find((hook) => {
      const hookPayload = hook.payload as { uploadId?: string } | null;
      return (
        hook.hookName === "onUploadTimeout" &&
        hookPayload?.uploadId === createResponse.data.uploadId
      );
    });

    expect(timeoutHook).toBeDefined();
    if (!timeoutHook) {
      throw new Error("Timeout hook missing");
    }

    await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(internalFragment.$internal.deps.schema);
          uow.update("fragno_hooks", timeoutHook.id, (b) =>
            b.set({ nextRetryAt: new Date(Date.now() - 1_000) }),
          );
        })
        .execute();
    });

    await fragment.inContext(async function () {
      return await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(uploadSchema);
          uow.update("upload", retryResponse.data.uploadId, (b) =>
            b.set({ updatedAt: new Date() }),
          );
        })
        .execute();
    });

    await drainDurableHooks(fragment);

    const file = await db.findFirst("file", (b) =>
      b.whereIndex("idx_file_key", (eb) => eb("fileKey", "=", retryResponse.data.fileKey)),
    );

    expect(file?.status).toBe("ready");
  });
});

describe("upload fragment direct multipart flows", () => {
  const { adapter, completeMultipartUpload } = createDirectAdapter("direct-multipart");
  let build!: UploadBuild;

  beforeAll(async () => {
    build = await buildUploadFragment({ storage: adapter });
  });

  beforeEach(async () => {
    await build.test.resetDatabase();
    completeMultipartUpload.mockClear();
  });

  afterAll(async () => {
    await build.test.cleanup();
  });

  it("tracks multipart uploads", async () => {
    const { fragment } = build.fragments.upload;
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

describe("upload fragment proxy streaming", () => {
  let rootDir: string;
  let storage: ReturnType<typeof createFilesystemStorageAdapter>;
  let build!: UploadBuild;

  beforeAll(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragno-upload-fragment-"));
    storage = createFilesystemStorageAdapter({ rootDir });

    build = await buildUploadFragment({ storage });
  });

  beforeEach(async () => {
    await build.test.resetDatabase();
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.mkdir(rootDir, { recursive: true });
  });

  afterAll(async () => {
    await build.test.cleanup();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("streams proxy uploads to storage", async () => {
    const { fragment } = build.fragments.upload;
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
