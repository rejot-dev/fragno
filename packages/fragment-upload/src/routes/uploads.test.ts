import { afterAll, beforeAll, beforeEach, describe, expect, it, assert, vi } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { uploadFragmentDefinition } from "../definition";
import { uploadRoutes } from "../index";
import { createFilesystemStorageAdapter } from "../storage/fs";
import type { StorageAdapter } from "../storage/types";

describe("upload routes", () => {
  let rootDir: string;
  let storage: ReturnType<typeof createFilesystemStorageAdapter>;
  let provider: string;
  let testContext: { resetDatabase: () => Promise<void> };
  let fragment: UploadFragmentCaller;

  type UploadFragmentCaller = {
    callRoute: (...args: unknown[]) => Promise<unknown>;
  };

  type JsonResponse<T extends Record<string, unknown> = Record<string, unknown>> = {
    type: "json";
    data: T;
  };

  type ErrorResponse = {
    type: "error";
    status: number;
    error: { code: string };
  };

  const asObject = (
    value: unknown,
  ): value is { type?: unknown; status?: unknown; error?: unknown; data?: unknown } =>
    typeof value === "object" && value !== null;

  const asJsonResponse = <T extends Record<string, unknown>>(value: unknown): JsonResponse<T> => {
    assert(asObject(value));
    assert(value.type === "json");
    assert("data" in value);
    return value as JsonResponse<T>;
  };

  const asErrorResponse = (value: unknown): ErrorResponse => {
    assert(asObject(value));
    assert(value.type === "error");
    assert(typeof value.status === "number");
    const errorPayload = value.error as { code?: unknown };
    assert(typeof errorPayload?.code === "string");
    return value as ErrorResponse;
  };

  beforeAll(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragno-upload-routes-"));
    storage = createFilesystemStorageAdapter({ rootDir });
    provider = storage.name;

    const build = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "upload",
        instantiate(uploadFragmentDefinition).withConfig({ storage }).withRoutes(uploadRoutes),
      )
      .build();

    testContext = build.test;
    fragment = build.fragments.upload.fragment as unknown as UploadFragmentCaller;
  });

  const resetStorage = async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.mkdir(rootDir, { recursive: true });
  };

  beforeEach(async () => {
    await testContext.resetDatabase();
    await resetStorage();
  });

  afterAll(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const buildUploadRoutePath = (uploadId: string, suffix = "", activeProvider = provider) =>
    `/uploads/${uploadId}${suffix}?${new URLSearchParams({ provider: activeProvider }).toString()}`;

  it("POST /uploads and GET /uploads/:uploadId return provider-sticky operation URLs", async () => {
    const createResponse = asJsonResponse<{
      uploadId: string;
      fileKey: string;
      provider: string;
      status: string;
      upload: {
        statusEndpoint: string;
        progressEndpoint: string;
        completeEndpoint: string;
        abortEndpoint: string;
        contentEndpoint?: string;
      };
    }>(
      await fragment.callRoute("POST", "/uploads", {
        body: {
          provider,
          keyParts: ["users", 0, "avatar"],
          filename: "sticky.txt",
          sizeBytes: 6,
          contentType: "text/plain",
        },
      }),
    );

    assert(createResponse.type === "json");
    expect(createResponse.data.provider).toBe(provider);
    expect(createResponse.data.upload.statusEndpoint).toBe(
      buildUploadRoutePath(createResponse.data.uploadId),
    );
    expect(createResponse.data.upload.progressEndpoint).toBe(
      buildUploadRoutePath(createResponse.data.uploadId, "/progress"),
    );
    expect(createResponse.data.upload.completeEndpoint).toBe(
      buildUploadRoutePath(createResponse.data.uploadId, "/complete"),
    );
    expect(createResponse.data.upload.abortEndpoint).toBe(
      buildUploadRoutePath(createResponse.data.uploadId, "/abort"),
    );
    expect(createResponse.data.upload.contentEndpoint).toBe(
      buildUploadRoutePath(createResponse.data.uploadId, "/content"),
    );

    const statusResponse = asJsonResponse<{
      provider: string;
      upload: {
        statusEndpoint: string;
        progressEndpoint: string;
        completeEndpoint: string;
        abortEndpoint: string;
        contentEndpoint?: string;
      };
    }>(
      await fragment.callRoute("GET", "/uploads/:uploadId", {
        pathParams: { uploadId: createResponse.data.uploadId },
      }),
    );

    assert(statusResponse.type === "json");
    expect(statusResponse.data.provider).toBe(provider);
    expect(statusResponse.data.upload.statusEndpoint).toBe(
      buildUploadRoutePath(createResponse.data.uploadId),
    );
    expect(statusResponse.data.upload.progressEndpoint).toBe(
      buildUploadRoutePath(createResponse.data.uploadId, "/progress"),
    );
    expect(statusResponse.data.upload.completeEndpoint).toBe(
      buildUploadRoutePath(createResponse.data.uploadId, "/complete"),
    );
    expect(statusResponse.data.upload.abortEndpoint).toBe(
      buildUploadRoutePath(createResponse.data.uploadId, "/abort"),
    );
    expect(statusResponse.data.upload.contentEndpoint).toBe(
      buildUploadRoutePath(createResponse.data.uploadId, "/content"),
    );
  });

  it("POST /uploads accepts provider namespaces that differ from the storage adapter name", async () => {
    const providerAlias = "customer-assets";
    const createResponse = asJsonResponse<{
      uploadId: string;
      fileKey: string;
      provider: string;
      upload: {
        statusEndpoint: string;
        progressEndpoint: string;
        completeEndpoint: string;
        abortEndpoint: string;
        contentEndpoint?: string;
      };
    }>(
      await fragment.callRoute("POST", "/uploads", {
        body: {
          provider: providerAlias,
          keyParts: ["users", 12, "avatar"],
          filename: "alias.txt",
          sizeBytes: 5,
          contentType: "text/plain",
        },
      }),
    );

    assert(createResponse.type === "json");
    expect(createResponse.data.provider).toBe(providerAlias);
    expect(createResponse.data.upload.statusEndpoint).toBe(
      buildUploadRoutePath(createResponse.data.uploadId, "", providerAlias),
    );
    expect(createResponse.data.upload.progressEndpoint).toBe(
      buildUploadRoutePath(createResponse.data.uploadId, "/progress", providerAlias),
    );
    expect(createResponse.data.upload.completeEndpoint).toBe(
      buildUploadRoutePath(createResponse.data.uploadId, "/complete", providerAlias),
    );
    expect(createResponse.data.upload.abortEndpoint).toBe(
      buildUploadRoutePath(createResponse.data.uploadId, "/abort", providerAlias),
    );
    expect(createResponse.data.upload.contentEndpoint).toBe(
      buildUploadRoutePath(createResponse.data.uploadId, "/content", providerAlias),
    );

    const statusResponse = asJsonResponse<{ provider: string }>(
      await fragment.callRoute("GET", "/uploads/:uploadId", {
        pathParams: { uploadId: createResponse.data.uploadId },
      }),
    );

    assert(statusResponse.type === "json");
    expect(statusResponse.data.provider).toBe(providerAlias);
  });

  it("PUT /uploads/:uploadId/content streams proxy uploads and records bytes", async () => {
    const createResponse = asJsonResponse<{ uploadId: string; fileKey: string }>(
      await fragment.callRoute("POST", "/uploads", {
        body: {
          provider,
          keyParts: ["users", 1, "avatar"],
          filename: "hello.txt",
          sizeBytes: 5,
          contentType: "text/plain",
        },
      }),
    );

    assert(createResponse.type === "json");
    const { uploadId, fileKey } = createResponse.data;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    });

    const uploadResponse = asJsonResponse<{ fileKey: string; status: string; sizeBytes: number }>(
      await fragment.callRoute("PUT", "/uploads/:uploadId/content", {
        pathParams: { uploadId },
        body: stream,
      }),
    );

    assert(uploadResponse.type === "json");
    expect(uploadResponse.data.fileKey).toBe(fileKey);
    expect(uploadResponse.data.status).toBe("ready");
    expect(uploadResponse.data.sizeBytes).toBe(5);

    const statusResponse = asJsonResponse<{ status: string; bytesUploaded: number }>(
      await fragment.callRoute("GET", "/uploads/:uploadId", {
        pathParams: { uploadId },
      }),
    );

    assert(statusResponse.type === "json");
    expect(statusResponse.data.status).toBe("completed");
    expect(statusResponse.data.bytesUploaded).toBe(5);
  });

  it("marks uploads as failed when proxy streaming errors", async () => {
    const originalWriteStream = storage.writeStream;
    storage.writeStream = async () => {
      throw new Error("write failed");
    };

    try {
      const createResponse = asJsonResponse<{ uploadId: string; fileKey: string }>(
        await fragment.callRoute("POST", "/uploads", {
          body: {
            provider,
            keyParts: ["users", 2, "avatar"],
            filename: "boom.txt",
            sizeBytes: 4,
            contentType: "text/plain",
          },
        }),
      );

      assert(createResponse.type === "json");
      const { uploadId, fileKey } = createResponse.data;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("boom"));
          controller.close();
        },
      });

      const uploadResponse = asErrorResponse(
        await fragment.callRoute("PUT", "/uploads/:uploadId/content", {
          pathParams: { uploadId },
          body: stream,
        }),
      );

      assert(uploadResponse.type === "error");
      expect(uploadResponse.status).toBe(502);
      expect(uploadResponse.error.code).toBe("STORAGE_ERROR");

      const statusResponse = asJsonResponse<{ status: string; errorCode: string }>(
        await fragment.callRoute("GET", "/uploads/:uploadId", {
          pathParams: { uploadId },
        }),
      );

      assert(statusResponse.type === "json");
      expect(statusResponse.data.status).toBe("failed");
      expect(statusResponse.data.errorCode).toBe("STORAGE_ERROR");

      const fileResponse = asErrorResponse(
        await fragment.callRoute("GET", "/files/by-key", {
          query: { provider, key: fileKey },
        }),
      );

      assert(fileResponse.type === "error");
      expect(fileResponse.status).toBe(404);
      expect(fileResponse.error.code).toBe("FILE_NOT_FOUND");
    } finally {
      storage.writeStream = originalWriteStream;
    }
  });

  it("POST /uploads/:uploadId/progress records client-reported progress", async () => {
    const createResponse = asJsonResponse<{ uploadId: string }>(
      await fragment.callRoute("POST", "/uploads", {
        body: {
          provider,
          keyParts: ["teams", 9, "logo"],
          filename: "logo.png",
          sizeBytes: 10,
          contentType: "image/png",
        },
      }),
    );

    assert(createResponse.type === "json");
    const { uploadId } = createResponse.data;

    const progressResponse = asJsonResponse<{ bytesUploaded: number; partsUploaded: number }>(
      await fragment.callRoute("POST", "/uploads/:uploadId/progress", {
        pathParams: { uploadId },
        body: { bytesUploaded: 2, partsUploaded: 1 },
      }),
    );

    assert(progressResponse.type === "json");
    expect(progressResponse.data.bytesUploaded).toBe(2);
    expect(progressResponse.data.partsUploaded).toBe(1);

    const smallerProgressResponse = asJsonResponse<{
      bytesUploaded: number;
      partsUploaded: number;
    }>(
      await fragment.callRoute("POST", "/uploads/:uploadId/progress", {
        pathParams: { uploadId },
        body: { bytesUploaded: 1, partsUploaded: 0 },
      }),
    );

    assert(smallerProgressResponse.type === "json");
    expect(smallerProgressResponse.data.bytesUploaded).toBe(2);
    expect(smallerProgressResponse.data.partsUploaded).toBe(1);

    const statusResponse = asJsonResponse<{
      status: string;
      bytesUploaded: number;
      partsUploaded: number;
    }>(
      await fragment.callRoute("GET", "/uploads/:uploadId", {
        pathParams: { uploadId },
      }),
    );

    assert(statusResponse.type === "json");
    expect(statusResponse.data.status).toBe("in_progress");
    expect(statusResponse.data.bytesUploaded).toBe(2);
    expect(statusResponse.data.partsUploaded).toBe(1);
  });

  it("POST /uploads/:uploadId/abort does not create a file", async () => {
    const createResponse = asJsonResponse<{ uploadId: string; fileKey: string }>(
      await fragment.callRoute("POST", "/uploads", {
        body: {
          provider,
          keyParts: ["users", 3, "avatar"],
          filename: "abort.txt",
          sizeBytes: 4,
          contentType: "text/plain",
        },
      }),
    );

    assert(createResponse.type === "json");
    const { uploadId, fileKey } = createResponse.data;

    const abortResponse = asJsonResponse<{ ok: boolean }>(
      await fragment.callRoute("POST", "/uploads/:uploadId/abort", {
        pathParams: { uploadId },
      }),
    );

    assert(abortResponse.type === "json");
    expect(abortResponse.data.ok).toBe(true);

    const statusResponse = asJsonResponse<{ status: string }>(
      await fragment.callRoute("GET", "/uploads/:uploadId", {
        pathParams: { uploadId },
      }),
    );

    assert(statusResponse.type === "json");
    expect(statusResponse.data.status).toBe("aborted");

    const fileResponse = asErrorResponse(
      await fragment.callRoute("GET", "/files/by-key", {
        query: { provider, key: fileKey },
      }),
    );

    assert(fileResponse.type === "error");
    expect(fileResponse.status).toBe(404);
    expect(fileResponse.error.code).toBe("FILE_NOT_FOUND");
  });

  it("allows retry after failed proxy upload", async () => {
    const originalWriteStream = storage.writeStream;
    storage.writeStream = async () => {
      throw new Error("write failed");
    };

    const createResponse = asJsonResponse<{ uploadId: string; fileKey: string }>(
      await fragment.callRoute("POST", "/uploads", {
        body: {
          provider,
          keyParts: ["users", 4, "avatar"],
          filename: "retry.txt",
          sizeBytes: 5,
          contentType: "text/plain",
        },
      }),
    );

    assert(createResponse.type === "json");

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("retry"));
        controller.close();
      },
    });

    const firstUpload = asErrorResponse(
      await fragment.callRoute("PUT", "/uploads/:uploadId/content", {
        pathParams: { uploadId: createResponse.data.uploadId },
        body: stream,
      }),
    );

    assert(firstUpload.type === "error");
    expect(firstUpload.status).toBe(502);

    storage.writeStream = originalWriteStream;

    const retryResponse = asJsonResponse<{ uploadId: string; fileKey: string }>(
      await fragment.callRoute("POST", "/uploads", {
        body: {
          provider,
          keyParts: ["users", 4, "avatar"],
          filename: "retry.txt",
          sizeBytes: 5,
          contentType: "text/plain",
        },
      }),
    );

    assert(retryResponse.type === "json");
    expect(retryResponse.data.fileKey).toBe(createResponse.data.fileKey);

    const retryStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("retry"));
        controller.close();
      },
    });

    const retryUpload = asJsonResponse<{ status: string }>(
      await fragment.callRoute("PUT", "/uploads/:uploadId/content", {
        pathParams: { uploadId: retryResponse.data.uploadId },
        body: retryStream,
      }),
    );

    assert(retryUpload.type === "json");
    expect(retryUpload.data.status).toBe("ready");
  });
});

const createMultiStrategyStorageAdapter = (name: string) => {
  const initUpload = vi.fn<StorageAdapter["initUpload"]>(async ({ provider, fileKey }) => {
    const expiresAt = new Date(Date.now() + 60_000);
    const storageKey = `store/${provider}/${fileKey}`;

    if (fileKey.includes("multipart")) {
      return {
        strategy: "direct-multipart" as const,
        storageKey,
        storageUploadId: `upload-${name}`,
        partSizeBytes: 3,
        expiresAt,
      };
    }

    if (fileKey.includes("proxy")) {
      return {
        strategy: "proxy" as const,
        storageKey,
        expiresAt,
      };
    }

    return {
      strategy: "direct-single" as const,
      storageKey,
      uploadUrl: `https://${name}.storage/upload`,
      uploadHeaders: { "Content-Type": "text/plain" },
      expiresAt,
    };
  });

  const getPartUploadUrls = vi.fn(async ({ partNumbers }: { partNumbers: number[] }) =>
    partNumbers.map((partNumber) => ({
      partNumber,
      url: `https://${name}.storage/part/${partNumber}`,
    })),
  );
  const completeMultipartUpload = vi.fn(async () => ({ etag: `etag-${name}` }));
  const abortMultipartUpload = vi.fn(async () => undefined);
  const finalizeUpload = vi.fn(async () => ({ etag: `etag-${name}` }));
  const writeStream = vi.fn(async () => ({ sizeBytes: 5n }));

  const adapter: StorageAdapter = {
    name,
    capabilities: {
      directUpload: true,
      multipartUpload: true,
      signedDownload: false,
      proxyUpload: true,
    },
    resolveStorageKey: ({ provider, fileKey }) => `store/${provider}/${fileKey}`,
    initUpload,
    getPartUploadUrls,
    completeMultipartUpload,
    abortMultipartUpload,
    finalizeUpload,
    writeStream,
    deleteObject: async () => {},
  };

  return {
    adapter,
    initUpload,
    getPartUploadUrls,
    completeMultipartUpload,
    abortMultipartUpload,
    finalizeUpload,
    writeStream,
  };
};

describe("upload route provider mismatch guards", () => {
  type UploadFragmentCaller = {
    callRoute: (...args: unknown[]) => Promise<unknown>;
  };

  type JsonResponse<T extends Record<string, unknown> = Record<string, unknown>> = {
    type: "json";
    data: T;
  };

  type ErrorResponse = {
    type: "error";
    status: number;
    error: { code: string };
  };

  const asObject = (
    value: unknown,
  ): value is { type?: unknown; status?: unknown; error?: unknown; data?: unknown } =>
    typeof value === "object" && value !== null;

  const asJsonResponse = <T extends Record<string, unknown>>(value: unknown): JsonResponse<T> => {
    assert(asObject(value));
    assert(value.type === "json");
    assert("data" in value);
    return value as JsonResponse<T>;
  };

  const asErrorResponse = (value: unknown): ErrorResponse => {
    assert(asObject(value));
    assert(value.type === "error");
    assert(typeof value.status === "number");
    const errorPayload = value.error as { code?: unknown };
    assert(typeof errorPayload?.code === "string");
    return value as ErrorResponse;
  };

  const primaryStorage = createMultiStrategyStorageAdapter("provider-a");
  const secondaryStorage = createMultiStrategyStorageAdapter("provider-b");
  let testContext: { resetDatabase: () => Promise<void> };
  let cleanup: (() => Promise<void>) | undefined;
  let primaryFragment: UploadFragmentCaller;
  let secondaryFragment: UploadFragmentCaller;

  beforeAll(async () => {
    const build = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "upload",
        instantiate(uploadFragmentDefinition)
          .withConfig({ storage: primaryStorage.adapter })
          .withRoutes(uploadRoutes),
      )
      .build();

    const secondary = instantiate(uploadFragmentDefinition)
      .withConfig({ storage: secondaryStorage.adapter })
      .withRoutes(uploadRoutes)
      .withOptions({
        databaseAdapter: build.test.adapter,
      })
      .build();

    testContext = build.test;
    cleanup = async () => {
      await build.test.cleanup();
    };
    primaryFragment = build.fragments.upload.fragment as unknown as UploadFragmentCaller;
    secondaryFragment = secondary as unknown as UploadFragmentCaller;
  });

  beforeEach(async () => {
    await testContext.resetDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it("rejects wrong-provider multipart part URL requests before storage I/O", async () => {
    const createResponse = asJsonResponse<{ uploadId: string }>(
      await primaryFragment.callRoute("POST", "/uploads", {
        body: {
          provider: primaryStorage.adapter.name,
          fileKey: "files.multipart.guard",
          filename: "movie.mp4",
          sizeBytes: 8,
          contentType: "video/mp4",
        },
      }),
    );

    const response = asErrorResponse(
      await secondaryFragment.callRoute("POST", "/uploads/:uploadId/parts", {
        pathParams: { uploadId: createResponse.data.uploadId },
        body: { partNumbers: [1, 2] },
      }),
    );

    expect(response.status).toBe(409);
    expect(response.error.code).toBe("PROVIDER_MISMATCH");
    expect(secondaryStorage.getPartUploadUrls).not.toHaveBeenCalled();
  });

  it("rejects wrong-provider multipart completion before storage I/O", async () => {
    const createResponse = asJsonResponse<{ uploadId: string }>(
      await primaryFragment.callRoute("POST", "/uploads", {
        body: {
          provider: primaryStorage.adapter.name,
          fileKey: "files.multipart.complete-guard",
          filename: "movie.mp4",
          sizeBytes: 8,
          contentType: "video/mp4",
        },
      }),
    );

    const response = asErrorResponse(
      await secondaryFragment.callRoute("POST", "/uploads/:uploadId/complete", {
        pathParams: { uploadId: createResponse.data.uploadId },
        body: {
          parts: [
            { partNumber: 1, etag: "etag-1" },
            { partNumber: 2, etag: "etag-2" },
          ],
        },
      }),
    );

    expect(response.status).toBe(409);
    expect(response.error.code).toBe("PROVIDER_MISMATCH");
    expect(secondaryStorage.completeMultipartUpload).not.toHaveBeenCalled();
    expect(secondaryStorage.finalizeUpload).not.toHaveBeenCalled();
  });

  it("rejects wrong-provider abort requests before storage I/O", async () => {
    const createResponse = asJsonResponse<{ uploadId: string }>(
      await primaryFragment.callRoute("POST", "/uploads", {
        body: {
          provider: primaryStorage.adapter.name,
          fileKey: "files.multipart.abort-guard",
          filename: "movie.mp4",
          sizeBytes: 8,
          contentType: "video/mp4",
        },
      }),
    );

    const response = asErrorResponse(
      await secondaryFragment.callRoute("POST", "/uploads/:uploadId/abort", {
        pathParams: { uploadId: createResponse.data.uploadId },
      }),
    );

    expect(response.status).toBe(409);
    expect(response.error.code).toBe("PROVIDER_MISMATCH");
    expect(secondaryStorage.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it("rejects wrong-provider proxy uploads before storage writes", async () => {
    const createResponse = asJsonResponse<{ uploadId: string }>(
      await primaryFragment.callRoute("POST", "/uploads", {
        body: {
          provider: primaryStorage.adapter.name,
          fileKey: "files.proxy.guard",
          filename: "hello.txt",
          sizeBytes: 5,
          contentType: "text/plain",
        },
      }),
    );

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    });

    const response = asErrorResponse(
      await secondaryFragment.callRoute("PUT", "/uploads/:uploadId/content", {
        pathParams: { uploadId: createResponse.data.uploadId },
        body: stream,
      }),
    );

    expect(response.status).toBe(409);
    expect(response.error.code).toBe("PROVIDER_MISMATCH");
    expect(secondaryStorage.writeStream).not.toHaveBeenCalled();
  });

  it("rejects wrong-provider finalize-only completion before storage I/O", async () => {
    const createResponse = asJsonResponse<{ uploadId: string }>(
      await primaryFragment.callRoute("POST", "/uploads", {
        body: {
          provider: primaryStorage.adapter.name,
          fileKey: "files.single.guard",
          filename: "hello.txt",
          sizeBytes: 5,
          contentType: "text/plain",
        },
      }),
    );

    const response = asErrorResponse(
      await secondaryFragment.callRoute("POST", "/uploads/:uploadId/complete", {
        pathParams: { uploadId: createResponse.data.uploadId },
        body: {},
      }),
    );

    expect(response.status).toBe(409);
    expect(response.error.code).toBe("PROVIDER_MISMATCH");
    expect(secondaryStorage.finalizeUpload).not.toHaveBeenCalled();
  });
});
