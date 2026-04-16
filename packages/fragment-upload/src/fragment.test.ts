import { afterAll, beforeAll, beforeEach, describe, expect, it, assert, vi } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { instantiate } from "@fragno-dev/core";
import { getInternalFragment } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import type { UploadFragmentConfig } from "./config";
import { uploadFragmentDefinition } from "./definition";
import { uploadRoutes } from "./index";
import { uploadSchema } from "./schema";
import { createFilesystemStorageAdapter } from "./storage/fs";
import type { StorageAdapter } from "./storage/types";

const createDirectAdapter = (
  strategy: "direct-single" | "direct-multipart",
  expiresAtOverride?: Date,
) => {
  const finalizeUpload = vi.fn(async () => ({ etag: "etag-final" }));
  const completeMultipartUpload = vi.fn(async () => ({
    etag: "etag-complete",
  }));
  const deleteObject = vi.fn(async () => undefined);
  const expiresAt = expiresAtOverride ?? new Date(Date.now() + 60_000);
  const initUploadMock = vi.fn<StorageAdapter["initUpload"]>(
    async ({ provider, fileKey, objectKeyVersionSegment }) => {
      const baseStorageKey = `store/${provider}/${fileKey}`;
      const storageKey = objectKeyVersionSegment
        ? `${baseStorageKey}/${objectKeyVersionSegment}`
        : baseStorageKey;

      if (strategy === "direct-multipart") {
        return {
          strategy: "direct-multipart" as const,
          storageKey,
          storageUploadId: "upload-123",
          partSizeBytes: 3,
          expiresAt,
        };
      }

      return {
        strategy: "direct-single" as const,
        storageKey,
        expiresAt,
        uploadUrl: "https://storage.local/upload",
        uploadHeaders: { "Content-Type": "text/plain" },
      };
    },
  );

  const adapter: StorageAdapter = {
    name: "direct-test",
    capabilities: {
      directUpload: true,
      multipartUpload: true,
      signedDownload: false,
      proxyUpload: false,
    },
    resolveStorageKey: ({ provider, fileKey }) => `store/${provider}/${fileKey}`,
    initUpload: initUploadMock,
    getPartUploadUrls: async ({ partNumbers }) =>
      partNumbers.map((partNumber) => ({
        partNumber,
        url: `https://storage.local/part/${partNumber}`,
      })),
    completeMultipartUpload,
    finalizeUpload,
    deleteObject,
  };

  return {
    adapter,
    finalizeUpload,
    completeMultipartUpload,
    deleteObject,
    expiresAt,
    initUpload: initUploadMock,
  };
};

const buildUploadFragment = async (config: UploadFragmentConfig) =>
  buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withDbRoundtripGuard({ maxRoundtrips: 2 })
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
  const { adapter, finalizeUpload, initUpload, deleteObject } =
    createDirectAdapter("direct-single");
  let build!: UploadBuild;

  beforeAll(async () => {
    build = await buildUploadFragment({ storage: adapter });
  });

  beforeEach(async () => {
    await build.test.resetDatabase();
    finalizeUpload.mockClear();
    initUpload.mockClear();
    deleteObject.mockClear();
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

    const stored = await (async () => {
      const uow = db
        .createUnitOfWork("read")
        .forSchema(uploadSchema)
        .findFirst("file", (b) =>
          b.whereIndex("idx_file_provider_key", (eb) =>
            eb.and(eb("provider", "=", adapter.name), eb("key", "=", createResponse.data.fileKey)),
          ),
        );
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();

    expect(stored?.status).toBe("ready");
    expect(stored?.objectKey).toMatch(
      new RegExp(
        `^store/${adapter.name}/${createResponse.data.fileKey}/\\d{8}T\\d{9}Z(?:-\\d{4})?$`,
      ),
    );
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

    await (async () => {
      const uow = db.createUnitOfWork("write").forSchema(uploadSchema);
      uow.update("upload", createResponse.data.uploadId, (b) =>
        b.set({ expiresAt: new Date(Date.now() - 1000) }),
      );
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to update record");
      }
    })();

    const response = await fragment.callRoute("POST", "/uploads/:uploadId/complete", {
      pathParams: { uploadId: createResponse.data.uploadId },
      body: {},
    });

    assert(response.type === "error");
    expect(response.status).toBe(410);
    expect(response.error.code).toBe("UPLOAD_EXPIRED");
  });

  it("replaces the authoritative file row when a file appears before completion", async () => {
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

    const upload = await (async () => {
      const uow = db
        .createUnitOfWork("read")
        .forSchema(uploadSchema)
        .findFirst("upload", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", createResponse.data.uploadId)),
        );
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();
    expect(upload).toBeTruthy();
    if (!upload) {
      throw new Error("Upload row missing");
    }

    const supersededObjectKey = `store/${upload.provider}/${upload.key}/20260319T115043123Z`;
    const now = new Date();
    await (async () => {
      const uow = db.createUnitOfWork("write").forSchema(uploadSchema);
      const created = uow.create("file", {
        key: upload.key,
        provider: upload.provider,
        uploaderId: upload.uploaderId,
        filename: "old.txt",
        sizeBytes: upload.expectedSizeBytes,
        contentType: upload.contentType,
        checksum: upload.checksum,
        visibility: upload.visibility,
        tags: upload.tags,
        metadata: upload.metadata,
        status: "ready",
        objectKey: supersededObjectKey,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        deletedAt: null,
        errorCode: null,
        errorMessage: null,
      });
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create record");
      }
      return created;
    })();

    const completeResponse = await fragment.callRoute("POST", "/uploads/:uploadId/complete", {
      pathParams: { uploadId: createResponse.data.uploadId },
      body: {},
    });

    assert(completeResponse.type === "json");
    expect(completeResponse.data.status).toBe("ready");

    const currentFile = await (async () => {
      const uow = db
        .createUnitOfWork("read")
        .forSchema(uploadSchema)
        .findFirst("file", (b) =>
          b.whereIndex("idx_file_provider_key", (eb) =>
            eb.and(eb("provider", "=", upload.provider), eb("key", "=", upload.key)),
          ),
        );
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();

    expect(currentFile?.objectKey).toBe(upload.objectKey);
    expect(deleteObject).not.toHaveBeenCalled();

    await drainDurableHooks(fragment);

    expect(deleteObject).toHaveBeenCalledWith({
      storageKey: supersededObjectKey,
    });
  });

  it("allows direct single uploads to overwrite the same logical file key", async () => {
    const { fragment, db } = build.fragments.upload;
    const firstCreate = await fragment.callRoute("POST", "/uploads", {
      body: {
        keyParts: ["files", "direct", 15],
        filename: "first.txt",
        sizeBytes: 5,
        contentType: "text/plain",
      },
    });

    assert(firstCreate.type === "json");

    const firstComplete = await fragment.callRoute("POST", "/uploads/:uploadId/complete", {
      pathParams: { uploadId: firstCreate.data.uploadId },
      body: {},
    });

    assert(firstComplete.type === "json");

    const firstFile = await (async () => {
      const uow = db
        .createUnitOfWork("read")
        .forSchema(uploadSchema)
        .findFirst("file", (b) =>
          b.whereIndex("idx_file_provider_key", (eb) =>
            eb.and(eb("provider", "=", adapter.name), eb("key", "=", firstCreate.data.fileKey)),
          ),
        );
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();
    expect(firstFile?.objectKey).toBeDefined();
    if (!firstFile?.objectKey) {
      throw new Error("First file row missing objectKey");
    }

    const secondCreate = await fragment.callRoute("POST", "/uploads", {
      body: {
        fileKey: firstCreate.data.fileKey,
        filename: "second.txt",
        sizeBytes: 6,
        contentType: "text/plain",
      },
    });

    assert(secondCreate.type === "json");

    const secondComplete = await fragment.callRoute("POST", "/uploads/:uploadId/complete", {
      pathParams: { uploadId: secondCreate.data.uploadId },
      body: {},
    });

    assert(secondComplete.type === "json");
    expect(secondComplete.data.filename).toBe("second.txt");

    const currentFile = await (async () => {
      const uow = db
        .createUnitOfWork("read")
        .forSchema(uploadSchema)
        .findFirst("file", (b) =>
          b.whereIndex("idx_file_provider_key", (eb) =>
            eb.and(eb("provider", "=", adapter.name), eb("key", "=", firstCreate.data.fileKey)),
          ),
        );
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();
    expect(currentFile?.objectKey).toBeDefined();
    expect(currentFile?.objectKey).not.toBe(firstFile.objectKey);

    await drainDurableHooks(fragment);

    expect(deleteObject).toHaveBeenCalledWith({
      storageKey: firstFile.objectKey,
    });
  });

  it("throws when two overwrites resolve to the same timestamped object key", async () => {
    const { fragment } = build.fragments.upload;
    const now = Date.UTC(2026, 2, 19, 11, 50, 43, 123);
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      const firstCreate = await fragment.callRoute("POST", "/uploads", {
        body: {
          keyParts: ["files", "direct", 16],
          filename: "first.txt",
          sizeBytes: 5,
          contentType: "text/plain",
        },
      });

      assert(firstCreate.type === "json");

      const firstComplete = await fragment.callRoute("POST", "/uploads/:uploadId/complete", {
        pathParams: { uploadId: firstCreate.data.uploadId },
        body: {},
      });

      assert(firstComplete.type === "json");

      const secondCreate = await fragment.callRoute("POST", "/uploads", {
        body: {
          fileKey: firstCreate.data.fileKey,
          filename: "second.txt",
          sizeBytes: 6,
          contentType: "text/plain",
        },
      });

      assert(secondCreate.type === "json");

      const secondComplete = await fragment.callRoute("POST", "/uploads/:uploadId/complete", {
        pathParams: { uploadId: secondCreate.data.uploadId },
        body: {},
      });

      assert(secondComplete.type === "error");
      expect(secondComplete.status).toBe(502);
      expect(secondComplete.error.code).toBe("STORAGE_ERROR");
    } finally {
      dateNowSpy.mockRestore();
    }
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

      const upload = await (async () => {
        const uow = expiredDb
          .createUnitOfWork("read")
          .forSchema(uploadSchema)
          .findFirst("upload", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", createResponse.data.uploadId)),
          );
        await uow.executeRetrieve();
        return (await uow.retrievalPhase)[0];
      })();

      const file = await (async () => {
        const uow = expiredDb
          .createUnitOfWork("read")
          .forSchema(uploadSchema)
          .findFirst("file", (b) =>
            b.whereIndex("idx_file_provider_key", (eb) =>
              eb.and(
                eb("provider", "=", expiredAdapter.name),
                eb("key", "=", createResponse.data.fileKey),
              ),
            ),
          );
        await uow.executeRetrieve();
        return (await uow.retrievalPhase)[0];
      })();

      expect(upload?.status).toBe("expired");
      expect(upload?.errorCode).toBe("UPLOAD_EXPIRED");
      expect(file).toBeNull();
    });
  });

  it("runs file deletion and notification through durable hooks", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragno-upload-delete-hook-"));
    const baseStorage = createFilesystemStorageAdapter({ rootDir });
    const deleteObject = vi.fn(baseStorage.deleteObject);
    const onFileDeleted = vi.fn(async () => {});
    const storage = {
      ...baseStorage,
      deleteObject,
    } satisfies StorageAdapter;

    try {
      await withUploadBuild({ storage, onFileDeleted }, async ({ fragments }) => {
        const { fragment, db } = fragments.upload;
        const form = new FormData();
        const file = new File([Buffer.from("delete me")], "delete-me.txt", {
          type: "text/plain",
        });
        form.set("file", file);
        form.set("provider", storage.name);
        form.set("keyParts", JSON.stringify(["users", 99, "delete-me"]));

        const createResponse = await fragment.callRoute("POST", "/files", {
          body: form,
        });
        assert(createResponse.type === "json");

        const storedFile = await (async () => {
          const uow = db
            .createUnitOfWork("read")
            .forSchema(uploadSchema)
            .findFirst("file", (b) =>
              b.whereIndex("idx_file_provider_key", (eb) =>
                eb.and(
                  eb("provider", "=", storage.name),
                  eb("key", "=", createResponse.data.fileKey),
                ),
              ),
            );
          await uow.executeRetrieve();
          return (await uow.retrievalPhase)[0];
        })();
        expect(storedFile?.objectKey).toBeDefined();
        if (!storedFile?.objectKey) {
          throw new Error("Stored file missing objectKey");
        }
        const storageKey = storedFile.objectKey;

        const deleteResponse = await fragment.callRoute("DELETE", "/files/by-key", {
          query: {
            provider: storage.name,
            key: createResponse.data.fileKey,
          },
        });

        assert(deleteResponse.type === "json");
        expect(deleteResponse.data).toEqual({ ok: true });
        expect(deleteObject).not.toHaveBeenCalled();
        expect(onFileDeleted).not.toHaveBeenCalled();

        await drainDurableHooks(fragment);

        expect(deleteObject).toHaveBeenCalledWith({ storageKey });
        expect(onFileDeleted).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: storage.name,
            fileKey: createResponse.data.fileKey,
            objectKey: storageKey,
          }),
          expect.any(String),
        );
      });
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("cleans up superseded objects during overwrite without firing onFileDeleted", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragno-upload-overwrite-hook-"));
    const baseStorage = createFilesystemStorageAdapter({ rootDir });
    const deleteObject = vi.fn(baseStorage.deleteObject);
    const onFileDeleted = vi.fn(async () => {});
    const storage = {
      ...baseStorage,
      deleteObject,
    } satisfies StorageAdapter;

    try {
      await withUploadBuild({ storage, onFileDeleted }, async ({ fragments }) => {
        const { fragment, db } = fragments.upload;
        const firstForm = new FormData();
        firstForm.set(
          "file",
          new File([Buffer.from("first")], "first.txt", {
            type: "text/plain",
          }),
        );
        firstForm.set("provider", storage.name);
        firstForm.set("keyParts", JSON.stringify(["users", 102, "overwrite"]));

        const firstCreate = await fragment.callRoute("POST", "/files", {
          body: firstForm,
        });
        assert(firstCreate.type === "json");

        const firstFile = await (async () => {
          const uow = db
            .createUnitOfWork("read")
            .forSchema(uploadSchema)
            .findFirst("file", (b) =>
              b.whereIndex("idx_file_provider_key", (eb) =>
                eb.and(eb("provider", "=", storage.name), eb("key", "=", firstCreate.data.fileKey)),
              ),
            );
          await uow.executeRetrieve();
          return (await uow.retrievalPhase)[0];
        })();
        expect(firstFile?.objectKey).toBeDefined();
        if (!firstFile?.objectKey) {
          throw new Error("First file row missing objectKey");
        }

        const secondForm = new FormData();
        secondForm.set(
          "file",
          new File([Buffer.from("second")], "second.txt", {
            type: "text/plain",
          }),
        );
        secondForm.set("provider", storage.name);
        secondForm.set("fileKey", firstCreate.data.fileKey);

        const secondCreate = await fragment.callRoute("POST", "/files", {
          body: secondForm,
        });
        assert(secondCreate.type === "json");

        const currentFile = await (async () => {
          const uow = db
            .createUnitOfWork("read")
            .forSchema(uploadSchema)
            .findFirst("file", (b) =>
              b.whereIndex("idx_file_provider_key", (eb) =>
                eb.and(eb("provider", "=", storage.name), eb("key", "=", firstCreate.data.fileKey)),
              ),
            );
          await uow.executeRetrieve();
          return (await uow.retrievalPhase)[0];
        })();
        expect(currentFile?.objectKey).toBeDefined();
        expect(currentFile?.objectKey).not.toBe(firstFile.objectKey);
        if (!currentFile?.objectKey) {
          throw new Error("Current file row missing objectKey");
        }

        expect(deleteObject).not.toHaveBeenCalled();
        expect(onFileDeleted).not.toHaveBeenCalled();

        await drainDurableHooks(fragment);

        expect(deleteObject).toHaveBeenCalledWith({
          storageKey: firstFile.objectKey,
        });
        expect(onFileDeleted).not.toHaveBeenCalled();

        const currentStoragePath = path.join(rootDir, ...currentFile.objectKey.split("/"));
        expect(await fs.readFile(currentStoragePath, "utf8")).toBe("second");
      });
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("cleans up multiple superseded objects after repeated overwrites before hook drain", async () => {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "fragno-upload-overwrite-history-hook-"),
    );
    const baseStorage = createFilesystemStorageAdapter({ rootDir });
    const deleteObject = vi.fn(baseStorage.deleteObject);
    const onFileDeleted = vi.fn(async () => {});
    const storage = {
      ...baseStorage,
      deleteObject,
    } satisfies StorageAdapter;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(
      (
        (now) => () =>
          now++
      )(Date.UTC(2026, 2, 19, 11, 50, 43, 123)),
    );

    try {
      await withUploadBuild({ storage, onFileDeleted }, async ({ fragments }) => {
        const { fragment, db } = fragments.upload;
        const readStoredContent = async (objectKey: string) =>
          await fs.readFile(path.join(rootDir, ...objectKey.split("/")), "utf8");

        const firstForm = new FormData();
        firstForm.set(
          "file",
          new File([Buffer.from("first")], "first.txt", {
            type: "text/plain",
          }),
        );
        firstForm.set("provider", storage.name);
        firstForm.set("keyParts", JSON.stringify(["users", 103, "overwrite-history"]));

        const firstCreate = await fragment.callRoute("POST", "/files", {
          body: firstForm,
        });
        assert(firstCreate.type === "json");

        const firstFile = await (async () => {
          const uow = db
            .createUnitOfWork("read")
            .forSchema(uploadSchema)
            .findFirst("file", (b) =>
              b.whereIndex("idx_file_provider_key", (eb) =>
                eb.and(eb("provider", "=", storage.name), eb("key", "=", firstCreate.data.fileKey)),
              ),
            );
          await uow.executeRetrieve();
          return (await uow.retrievalPhase)[0];
        })();
        expect(firstFile?.objectKey).toBeDefined();
        if (!firstFile?.objectKey) {
          throw new Error("First file row missing objectKey");
        }

        const secondForm = new FormData();
        secondForm.set(
          "file",
          new File([Buffer.from("second")], "second.txt", {
            type: "text/plain",
          }),
        );
        secondForm.set("provider", storage.name);
        secondForm.set("fileKey", firstCreate.data.fileKey);

        const secondCreate = await fragment.callRoute("POST", "/files", {
          body: secondForm,
        });
        assert(secondCreate.type === "json");

        const secondFile = await (async () => {
          const uow = db
            .createUnitOfWork("read")
            .forSchema(uploadSchema)
            .findFirst("file", (b) =>
              b.whereIndex("idx_file_provider_key", (eb) =>
                eb.and(eb("provider", "=", storage.name), eb("key", "=", firstCreate.data.fileKey)),
              ),
            );
          await uow.executeRetrieve();
          return (await uow.retrievalPhase)[0];
        })();
        expect(secondFile?.objectKey).toBeDefined();
        expect(secondFile?.objectKey).not.toBe(firstFile.objectKey);
        if (!secondFile?.objectKey) {
          throw new Error("Second file row missing objectKey");
        }

        const thirdForm = new FormData();
        thirdForm.set(
          "file",
          new File([Buffer.from("third")], "third.txt", {
            type: "text/plain",
          }),
        );
        thirdForm.set("provider", storage.name);
        thirdForm.set("fileKey", firstCreate.data.fileKey);

        const thirdCreate = await fragment.callRoute("POST", "/files", {
          body: thirdForm,
        });
        assert(thirdCreate.type === "json");

        const currentFile = await (async () => {
          const uow = db
            .createUnitOfWork("read")
            .forSchema(uploadSchema)
            .findFirst("file", (b) =>
              b.whereIndex("idx_file_provider_key", (eb) =>
                eb.and(eb("provider", "=", storage.name), eb("key", "=", firstCreate.data.fileKey)),
              ),
            );
          await uow.executeRetrieve();
          return (await uow.retrievalPhase)[0];
        })();
        expect(currentFile?.objectKey).toBeDefined();
        expect(currentFile?.objectKey).not.toBe(firstFile.objectKey);
        expect(currentFile?.objectKey).not.toBe(secondFile.objectKey);
        if (!currentFile?.objectKey) {
          throw new Error("Current file row missing objectKey");
        }

        expect(await readStoredContent(firstFile.objectKey)).toBe("first");
        expect(await readStoredContent(secondFile.objectKey)).toBe("second");
        expect(await readStoredContent(currentFile.objectKey)).toBe("third");
        expect(deleteObject).not.toHaveBeenCalled();
        expect(onFileDeleted).not.toHaveBeenCalled();

        const beforeDrain = await fragment.callRouteRaw("GET", "/files/by-key/content", {
          query: { provider: storage.name, key: firstCreate.data.fileKey },
        });
        expect(beforeDrain.status).toBe(200);
        expect(await beforeDrain.text()).toBe("third");

        await drainDurableHooks(fragment);

        expect(deleteObject).toHaveBeenCalledTimes(2);
        expect(deleteObject).toHaveBeenCalledWith({
          storageKey: firstFile.objectKey,
        });
        expect(deleteObject).toHaveBeenCalledWith({
          storageKey: secondFile.objectKey,
        });
        expect(onFileDeleted).not.toHaveBeenCalled();

        await expect(readStoredContent(firstFile.objectKey)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(readStoredContent(secondFile.objectKey)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readStoredContent(currentFile.objectKey)).toBe("third");
      });
    } finally {
      dateNowSpy.mockRestore();
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("deletes both superseded and current bytes when an overwritten file is later deleted", async () => {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "fragno-upload-overwrite-then-delete-hook-"),
    );
    const baseStorage = createFilesystemStorageAdapter({ rootDir });
    const deleteObject = vi.fn(baseStorage.deleteObject);
    const onFileDeleted = vi.fn(async () => {});
    const storage = {
      ...baseStorage,
      deleteObject,
    } satisfies StorageAdapter;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(
      (
        (now) => () =>
          now++
      )(Date.UTC(2026, 2, 19, 11, 55, 0, 0)),
    );

    try {
      await withUploadBuild({ storage, onFileDeleted }, async ({ fragments }) => {
        const { fragment, db } = fragments.upload;
        const readStoredContent = async (objectKey: string) =>
          await fs.readFile(path.join(rootDir, ...objectKey.split("/")), "utf8");

        const firstForm = new FormData();
        firstForm.set(
          "file",
          new File([Buffer.from("first")], "first.txt", {
            type: "text/plain",
          }),
        );
        firstForm.set("provider", storage.name);
        firstForm.set("keyParts", JSON.stringify(["users", 104, "overwrite-then-delete"]));

        const firstCreate = await fragment.callRoute("POST", "/files", {
          body: firstForm,
        });
        assert(firstCreate.type === "json");

        const firstFile = await (async () => {
          const uow = db
            .createUnitOfWork("read")
            .forSchema(uploadSchema)
            .findFirst("file", (b) =>
              b.whereIndex("idx_file_provider_key", (eb) =>
                eb.and(eb("provider", "=", storage.name), eb("key", "=", firstCreate.data.fileKey)),
              ),
            );
          await uow.executeRetrieve();
          return (await uow.retrievalPhase)[0];
        })();
        expect(firstFile?.objectKey).toBeDefined();
        if (!firstFile?.objectKey) {
          throw new Error("First file row missing objectKey");
        }

        const secondForm = new FormData();
        secondForm.set(
          "file",
          new File([Buffer.from("second")], "second.txt", {
            type: "text/plain",
          }),
        );
        secondForm.set("provider", storage.name);
        secondForm.set("fileKey", firstCreate.data.fileKey);

        const secondCreate = await fragment.callRoute("POST", "/files", {
          body: secondForm,
        });
        assert(secondCreate.type === "json");

        const currentFile = await (async () => {
          const uow = db
            .createUnitOfWork("read")
            .forSchema(uploadSchema)
            .findFirst("file", (b) =>
              b.whereIndex("idx_file_provider_key", (eb) =>
                eb.and(eb("provider", "=", storage.name), eb("key", "=", firstCreate.data.fileKey)),
              ),
            );
          await uow.executeRetrieve();
          return (await uow.retrievalPhase)[0];
        })();
        expect(currentFile?.objectKey).toBeDefined();
        expect(currentFile?.objectKey).not.toBe(firstFile.objectKey);
        if (!currentFile?.objectKey) {
          throw new Error("Current file row missing objectKey");
        }

        const deleteResponse = await fragment.callRoute("DELETE", "/files/by-key", {
          query: {
            provider: storage.name,
            key: firstCreate.data.fileKey,
          },
        });
        assert(deleteResponse.type === "json");

        expect(await readStoredContent(firstFile.objectKey)).toBe("first");
        expect(await readStoredContent(currentFile.objectKey)).toBe("second");
        expect(deleteObject).not.toHaveBeenCalled();
        expect(onFileDeleted).not.toHaveBeenCalled();

        const contentResponse = await fragment.callRoute("GET", "/files/by-key/content", {
          query: { provider: storage.name, key: firstCreate.data.fileKey },
        });
        assert(contentResponse.type === "error");
        expect(contentResponse.status).toBe(410);
        expect(contentResponse.error.code).toBe("FILE_DELETED");

        await drainDurableHooks(fragment);

        expect(deleteObject).toHaveBeenCalledTimes(2);
        expect(deleteObject).toHaveBeenCalledWith({
          storageKey: firstFile.objectKey,
        });
        expect(deleteObject).toHaveBeenCalledWith({
          storageKey: currentFile.objectKey,
        });
        expect(onFileDeleted).toHaveBeenCalledTimes(1);
        expect(onFileDeleted).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: storage.name,
            fileKey: firstCreate.data.fileKey,
            objectKey: currentFile.objectKey,
          }),
          expect.any(String),
        );

        await expect(readStoredContent(firstFile.objectKey)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(readStoredContent(currentFile.objectKey)).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    } finally {
      dateNowSpy.mockRestore();
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reads the persisted file objectKey when the deletion hook payload omits it", async () => {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "fragno-upload-delete-hook-persisted-key-"),
    );
    const baseStorage = createFilesystemStorageAdapter({ rootDir });
    const resolveStorageKey = vi.fn(() => "recomputed/should-not-be-used");
    const deleteObject = vi.fn(baseStorage.deleteObject);
    const onFileDeleted = vi.fn(async () => {});
    const storage = {
      ...baseStorage,
      resolveStorageKey,
      deleteObject,
    } satisfies StorageAdapter;

    try {
      await withUploadBuild({ storage, onFileDeleted }, async ({ fragments, test }) => {
        const { fragment, db } = fragments.upload;
        const form = new FormData();
        const file = new File([Buffer.from("delete me")], "delete-me.txt", {
          type: "text/plain",
        });
        form.set("file", file);
        form.set("provider", storage.name);
        form.set("keyParts", JSON.stringify(["users", 100, "delete-me-missing-payload-key"]));

        const createResponse = await fragment.callRoute("POST", "/files", {
          body: form,
        });
        assert(createResponse.type === "json");

        const deleteResponse = await fragment.callRoute("DELETE", "/files/by-key", {
          query: {
            provider: storage.name,
            key: createResponse.data.fileKey,
          },
        });

        assert(deleteResponse.type === "json");

        const persistedFile = await (async () => {
          const uow = db
            .createUnitOfWork("read")
            .forSchema(uploadSchema)
            .findFirst("file", (b) =>
              b.whereIndex("idx_file_provider_key", (eb) =>
                eb.and(
                  eb("provider", "=", storage.name),
                  eb("key", "=", createResponse.data.fileKey),
                ),
              ),
            );
          await uow.executeRetrieve();
          return (await uow.retrievalPhase)[0];
        })();

        expect(persistedFile?.objectKey).toBeDefined();
        if (!persistedFile?.objectKey) {
          throw new Error("Persisted deleted file is missing objectKey");
        }

        const internalFragment = getInternalFragment(test.adapter);
        const hooks = await internalFragment.inContext(async function () {
          return await this.handlerTx()
            .withServiceCalls(
              () => [internalFragment.services.hookService.getHooksByNamespace("upload")] as const,
            )
            .transform(({ serviceResult: [result] }) => result)
            .execute();
        });

        const deleteHook = hooks.find((hook) => {
          const hookPayload = hook.payload as { fileKey?: string } | null;
          return (
            hook.hookName === "onFileDeleted" &&
            hookPayload?.fileKey === createResponse.data.fileKey
          );
        });

        expect(deleteHook).toBeDefined();
        if (!deleteHook) {
          throw new Error("Delete hook missing");
        }

        const hookPayload = deleteHook.payload as {
          objectKey?: string;
        } & Record<string, unknown>;
        const { objectKey: _objectKey, ...payloadWithoutObjectKey } = hookPayload;

        await internalFragment.inContext(async function () {
          return await this.handlerTx()
            .mutate(({ forSchema }) => {
              const uow = forSchema(internalFragment.$internal.deps.schema);
              uow.update("fragno_hooks", deleteHook.id, (b) =>
                b.set({ payload: payloadWithoutObjectKey }),
              );
            })
            .execute();
        });

        await drainDurableHooks(fragment);

        expect(resolveStorageKey).not.toHaveBeenCalled();
        expect(deleteObject).toHaveBeenCalledWith({
          storageKey: persistedFile.objectKey,
        });
        expect(onFileDeleted).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: storage.name,
            fileKey: createResponse.data.fileKey,
            objectKey: persistedFile.objectKey,
          }),
          expect.any(String),
        );
      });
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("records a clear error when file deletion cannot resolve a persisted objectKey", async () => {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "fragno-upload-delete-hook-missing-persisted-key-"),
    );
    const baseStorage = createFilesystemStorageAdapter({ rootDir });
    const resolveStorageKey = vi.fn(() => "recomputed/should-not-be-used");
    const deleteObject = vi.fn(baseStorage.deleteObject);
    const onFileDeleted = vi.fn(async () => {});
    const storage = {
      ...baseStorage,
      resolveStorageKey,
      deleteObject,
    } satisfies StorageAdapter;

    try {
      await withUploadBuild({ storage, onFileDeleted }, async ({ fragments, test }) => {
        const { fragment, db } = fragments.upload;
        const form = new FormData();
        const file = new File([Buffer.from("delete me")], "delete-me.txt", {
          type: "text/plain",
        });
        form.set("file", file);
        form.set("provider", storage.name);
        form.set("keyParts", JSON.stringify(["users", 101, "delete-me-missing-record"]));

        const createResponse = await fragment.callRoute("POST", "/files", {
          body: form,
        });
        assert(createResponse.type === "json");

        const deleteResponse = await fragment.callRoute("DELETE", "/files/by-key", {
          query: {
            provider: storage.name,
            key: createResponse.data.fileKey,
          },
        });

        assert(deleteResponse.type === "json");

        const deletedFile = await (async () => {
          const uow = db
            .createUnitOfWork("read")
            .forSchema(uploadSchema)
            .findFirst("file", (b) =>
              b.whereIndex("idx_file_provider_key", (eb) =>
                eb.and(
                  eb("provider", "=", storage.name),
                  eb("key", "=", createResponse.data.fileKey),
                ),
              ),
            );
          await uow.executeRetrieve();
          return (await uow.retrievalPhase)[0];
        })();

        expect(deletedFile).toBeDefined();
        if (!deletedFile) {
          throw new Error("Deleted file row missing");
        }

        const internalFragment = getInternalFragment(test.adapter);
        const hooks = await internalFragment.inContext(async function () {
          return await this.handlerTx()
            .withServiceCalls(
              () => [internalFragment.services.hookService.getHooksByNamespace("upload")] as const,
            )
            .transform(({ serviceResult: [result] }) => result)
            .execute();
        });

        const deleteHook = hooks.find((hook) => {
          const hookPayload = hook.payload as { fileKey?: string } | null;
          return (
            hook.hookName === "onFileDeleted" &&
            hookPayload?.fileKey === createResponse.data.fileKey
          );
        });

        expect(deleteHook).toBeDefined();
        if (!deleteHook) {
          throw new Error("Delete hook missing");
        }

        const hookPayload = deleteHook.payload as {
          objectKey?: string;
        } & Record<string, unknown>;
        const { objectKey: _objectKey, ...payloadWithoutObjectKey } = hookPayload;

        await internalFragment.inContext(async function () {
          return await this.handlerTx()
            .mutate(({ forSchema }) => {
              const internalUow = forSchema(internalFragment.$internal.deps.schema);
              internalUow.update("fragno_hooks", deleteHook.id, (b) =>
                b.set({ payload: payloadWithoutObjectKey }),
              );
            })
            .execute();
        });

        await fragment.inContext(async function () {
          return await this.handlerTx()
            .mutate(({ forSchema }) => {
              forSchema(uploadSchema).delete("file", deletedFile.id);
            })
            .execute();
        });

        await drainDurableHooks(fragment, { mode: "singlePass" });

        expect(resolveStorageKey).not.toHaveBeenCalled();
        expect(deleteObject).not.toHaveBeenCalled();
        expect(onFileDeleted).not.toHaveBeenCalled();

        const updatedHook = await internalFragment.inContext(async function () {
          return await this.handlerTx()
            .withServiceCalls(
              () => [internalFragment.services.hookService.getHookById(deleteHook.id)] as const,
            )
            .transform(({ serviceResult: [result] }) => result)
            .execute();
        });

        expect(updatedHook?.status).toBe("pending");
        expect(updatedHook?.error).toContain("Missing persisted objectKey");
        expect(updatedHook?.error).toContain("Refusing to reconstruct storage key");
      });
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
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

    await (async () => {
      const uow = db.createUnitOfWork("write").forSchema(uploadSchema);
      uow.update("upload", createResponse.data.uploadId, (b) =>
        b.set({ expiresAt: new Date(Date.now() - 1_000) }),
      );
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to update record");
      }
    })();

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

    const file = await (async () => {
      const uow = db
        .createUnitOfWork("read")
        .forSchema(uploadSchema)
        .findFirst("file", (b) =>
          b.whereIndex("idx_file_provider_key", (eb) =>
            eb.and(eb("provider", "=", adapter.name), eb("key", "=", retryResponse.data.fileKey)),
          ),
        );
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();

    expect(file?.status).toBe("ready");
  });
});

describe("upload fragment direct multipart flows", () => {
  const { adapter, completeMultipartUpload, deleteObject } =
    createDirectAdapter("direct-multipart");
  let build!: UploadBuild;

  beforeAll(async () => {
    build = await buildUploadFragment({ storage: adapter });
  });

  beforeEach(async () => {
    await build.test.resetDatabase();
    completeMultipartUpload.mockClear();
    deleteObject.mockClear();
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
      storageKey: expect.stringMatching(
        new RegExp(`^store/${adapter.name}/${createResponse.data.fileKey}/\\d{8}T\\d{9}Z$`),
      ),
      storageUploadId: "upload-123",
      parts: [
        { partNumber: 1, etag: "etag-1" },
        { partNumber: 2, etag: "etag-2" },
        { partNumber: 3, etag: "etag-3" },
      ],
    });
  });

  it("allows direct multipart uploads to overwrite the same logical file key", async () => {
    const { fragment, db } = build.fragments.upload;
    const firstCreate = await fragment.callRoute("POST", "/uploads", {
      body: {
        keyParts: ["files", "multipart", 2],
        filename: "movie-v1.mp4",
        sizeBytes: 8,
        contentType: "video/mp4",
      },
    });

    assert(firstCreate.type === "json");

    const firstComplete = await fragment.callRoute("POST", "/uploads/:uploadId/complete", {
      pathParams: { uploadId: firstCreate.data.uploadId },
      body: {
        parts: [
          { partNumber: 1, etag: "etag-1" },
          { partNumber: 2, etag: "etag-2" },
          { partNumber: 3, etag: "etag-3" },
        ],
      },
    });

    assert(firstComplete.type === "json");

    const firstFile = await (async () => {
      const uow = db
        .createUnitOfWork("read")
        .forSchema(uploadSchema)
        .findFirst("file", (b) =>
          b.whereIndex("idx_file_provider_key", (eb) =>
            eb.and(eb("provider", "=", adapter.name), eb("key", "=", firstCreate.data.fileKey)),
          ),
        );
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();
    expect(firstFile?.objectKey).toBeDefined();
    if (!firstFile?.objectKey) {
      throw new Error("First multipart file row missing objectKey");
    }

    const secondCreate = await fragment.callRoute("POST", "/uploads", {
      body: {
        fileKey: firstCreate.data.fileKey,
        filename: "movie-v2.mp4",
        sizeBytes: 8,
        contentType: "video/mp4",
      },
    });

    assert(secondCreate.type === "json");

    const secondComplete = await fragment.callRoute("POST", "/uploads/:uploadId/complete", {
      pathParams: { uploadId: secondCreate.data.uploadId },
      body: {
        parts: [
          { partNumber: 1, etag: "etag-1b" },
          { partNumber: 2, etag: "etag-2b" },
          { partNumber: 3, etag: "etag-3b" },
        ],
      },
    });

    assert(secondComplete.type === "json");
    expect(secondComplete.data.filename).toBe("movie-v2.mp4");

    const currentFile = await (async () => {
      const uow = db
        .createUnitOfWork("read")
        .forSchema(uploadSchema)
        .findFirst("file", (b) =>
          b.whereIndex("idx_file_provider_key", (eb) =>
            eb.and(eb("provider", "=", adapter.name), eb("key", "=", firstCreate.data.fileKey)),
          ),
        );
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();
    expect(currentFile?.objectKey).toBeDefined();
    expect(currentFile?.objectKey).not.toBe(firstFile.objectKey);

    await drainDurableHooks(fragment);

    expect(deleteObject).toHaveBeenCalledWith({
      storageKey: firstFile.objectKey,
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
