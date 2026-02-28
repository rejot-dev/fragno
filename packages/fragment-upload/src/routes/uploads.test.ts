import { afterAll, beforeAll, beforeEach, describe, expect, it, assert } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { uploadFragmentDefinition } from "../definition";
import { uploadRoutes } from "../index";
import { createFilesystemStorageAdapter } from "../storage/fs";

describe("upload routes", () => {
  let rootDir: string;
  let storage: ReturnType<typeof createFilesystemStorageAdapter>;
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

  it("PUT /uploads/:uploadId/content streams proxy uploads and records bytes", async () => {
    const createResponse = asJsonResponse<{ uploadId: string; fileKey: string }>(
      await fragment.callRoute("POST", "/uploads", {
        body: {
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
        await fragment.callRoute("GET", "/files/:fileKey", {
          pathParams: { fileKey },
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
      await fragment.callRoute("GET", "/files/:fileKey", {
        pathParams: { fileKey },
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
