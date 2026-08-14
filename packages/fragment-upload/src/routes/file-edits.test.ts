import { afterAll, assert, beforeEach, describe, expect, it, vi } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { UOWInstrumentation } from "@fragno-dev/db/unit-of-work";

import { instantiate } from "@fragno-dev/core";
import { getInternalFragment } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { uploadFragmentDefinition } from "../definition";
import { createFilesystemStorageAdapter } from "../storage/fs";
import type { StorageAdapter } from "../storage/types";
import { uploadRoutes } from "./index";

describe("POST /files/apply-edits", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragno-upload-file-edit-routes-"));
  const filesystemStorage = createFilesystemStorageAdapter({ rootDir });
  const getDownloadStream = vi.fn(filesystemStorage.getDownloadStream!.bind(filesystemStorage));
  const writeStream = vi.fn(filesystemStorage.writeStream!.bind(filesystemStorage));
  const deleteObject = vi.fn(filesystemStorage.deleteObject.bind(filesystemStorage));
  const storage: StorageAdapter = {
    ...filesystemStorage,
    getDownloadStream,
    writeStream,
    deleteObject,
  };
  const provider = storage.name;
  const testSetup = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withDbRoundtripGuard({ maxRoundtrips: 3 })
    .withFragment(
      "upload",
      instantiate(uploadFragmentDefinition).withConfig({ storage }).withRoutes(uploadRoutes),
    )
    .build();
  const { fragment } = testSetup.fragments.upload;

  const createFile = async (
    fileKey: string,
    content: string,
    options: {
      filename?: string;
      contentType?: string;
      uploaderId?: string;
      visibility?: "private" | "public" | "unlisted";
      tags?: string[];
      metadata?: Record<string, unknown>;
    } = {},
  ) => {
    const form = new FormData();
    form.set(
      "file",
      new File([Buffer.from(content)], options.filename ?? path.basename(fileKey), {
        type: options.contentType ?? "text/plain",
      }),
    );
    form.set("provider", provider);
    form.set("fileKey", fileKey);
    if (options.uploaderId) {
      form.set("uploaderId", options.uploaderId);
    }
    if (options.visibility) {
      form.set("visibility", options.visibility);
    }
    if (options.tags) {
      form.set("tags", JSON.stringify(options.tags));
    }
    if (options.metadata) {
      form.set("metadata", JSON.stringify(options.metadata));
    }
    const response = await fragment.callRoute("POST", "/files", { body: form });
    assert(response.type === "json");
    return response.data;
  };

  const getFile = async (fileKey: string) => {
    const response = await fragment.callRoute("GET", "/files/by-key", {
      query: { provider, key: fileKey },
    });
    assert(response.type === "json");
    return response.data;
  };

  const listUploadHooks = async () => {
    const internalFragment = getInternalFragment(testSetup.test.adapter);
    return await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [internalFragment.services.hookService.getHooksByNamespace("upload")] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });
  };

  const readFile = async (fileKey: string) => {
    const response = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: fileKey },
    });
    assert(response.status === 200);
    return await response.text();
  };

  beforeEach(async () => {
    await testSetup.test.resetDatabase();
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.mkdir(rootDir, { recursive: true });
    getDownloadStream.mockClear();
    writeStream.mockClear();
    deleteObject.mockClear();
  });

  afterAll(async () => {
    await testSetup.test.cleanup();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("applies sequential operations to one file with one logical revision", async () => {
    await createFile("sequential/file.txt", "one two");
    const before = await getFile("sequential/file.txt");
    getDownloadStream.mockClear();
    writeStream.mockClear();

    const response = await fragment.callRoute("POST", "/files/apply-edits", {
      body: {
        provider,
        edits: [
          {
            kind: "replace",
            fileKey: "sequential/file.txt",
            search: "one",
            replacement: "first",
          },
          {
            kind: "replace",
            fileKey: "sequential/file.txt",
            search: "two",
            replacement: "second",
          },
        ],
      },
    });

    assert(response.type === "json");
    assert(response.data.totalChanged === 1);
    expect(response.data.edits.map((edit) => edit.content)).toEqual(["first two", "first second"]);
    assert((await getFile("sequential/file.txt")).revision === before.revision + 1);
    expect(getDownloadStream).toHaveBeenCalledTimes(1);
    expect(writeStream).toHaveBeenCalledTimes(1);
    assert((await readFile("sequential/file.txt")) === "first second");
  });

  it("does not stage or revise a file when a replacement is a no-op", async () => {
    await createFile("unchanged/file.txt", "unchanged");
    const before = await getFile("unchanged/file.txt");
    getDownloadStream.mockClear();
    writeStream.mockClear();

    const response = await fragment.callRoute("POST", "/files/apply-edits", {
      body: {
        provider,
        edits: [
          {
            kind: "replace",
            fileKey: "unchanged/file.txt",
            search: "missing",
            replacement: "replacement",
          },
        ],
      },
    });

    assert(response.type === "json");
    assert(response.data.totalChanged === 0);
    expect(response.data.edits).toEqual([
      { fileKey: "unchanged/file.txt", changed: false, content: "unchanged", diff: "" },
    ]);
    assert((await getFile("unchanged/file.txt")).revision === before.revision);
    expect(getDownloadStream).toHaveBeenCalledTimes(1);
    expect(writeStream).not.toHaveBeenCalled();
  });

  it("does not download old content when a leading write replaces it", async () => {
    await createFile("overwrite/file.txt", "old");
    getDownloadStream.mockClear();
    writeStream.mockClear();

    const response = await fragment.callRoute("POST", "/files/apply-edits", {
      body: {
        provider,
        edits: [{ kind: "write", fileKey: "overwrite/file.txt", content: "new" }],
      },
    });

    assert(response.type === "json");
    assert(response.data.totalChanged === 1);
    expect(getDownloadStream).not.toHaveBeenCalled();
    expect(writeStream).toHaveBeenCalledTimes(1);
    assert((await readFile("overwrite/file.txt")) === "new");
  });

  it("preserves existing publication metadata", async () => {
    await createFile("metadata/file.txt", "before", {
      filename: "custom.txt",
      contentType: "text/custom",
      uploaderId: "user-1",
      visibility: "unlisted",
      tags: ["source"],
      metadata: { mode: 0o640 },
    });

    const response = await fragment.callRoute("POST", "/files/apply-edits", {
      body: {
        provider,
        edits: [
          {
            kind: "replace",
            fileKey: "metadata/file.txt",
            search: "before",
            replacement: "after",
          },
        ],
      },
    });
    assert(response.type === "json");

    expect(await getFile("metadata/file.txt")).toMatchObject({
      filename: "custom.txt",
      contentType: "text/custom",
      uploaderId: "user-1",
      visibility: "unlisted",
      tags: ["source"],
      metadata: { mode: 0o640 },
    });
  });

  it("uses new-file publication defaults when recreating a deleted file", async () => {
    await createFile("deleted/recreated.txt", "old", {
      filename: "old-name.custom",
      contentType: "application/x-old",
      uploaderId: "previous-user",
      visibility: "public",
      tags: ["previous-tag"],
      metadata: { previous: true },
    });
    const deleted = await fragment.callRoute("DELETE", "/files/by-key", {
      query: { provider, key: "deleted/recreated.txt" },
    });
    assert(deleted.type === "json");

    const response = await fragment.callRoute("POST", "/files/apply-edits", {
      body: {
        provider,
        edits: [{ kind: "write", fileKey: "deleted/recreated.txt", content: "new" }],
      },
    });
    assert(response.type === "json");

    expect(await getFile("deleted/recreated.txt")).toMatchObject({
      filename: "recreated.txt",
      contentType: "text/plain",
      uploaderId: null,
      visibility: "private",
      tags: null,
      metadata: null,
    });
    assert((await readFile("deleted/recreated.txt")) === "new");
  });

  it("queues prepared-upload, publication, indexing, and superseded-object hooks", async () => {
    await createFile("hooks/file.txt", "before");
    const existingHookIds = new Set((await listUploadHooks()).map((hook) => hook.id.toString()));

    const response = await fragment.callRoute("POST", "/files/apply-edits", {
      body: {
        provider,
        edits: [
          {
            kind: "replace",
            fileKey: "hooks/file.txt",
            search: "before",
            replacement: "after",
          },
        ],
      },
    });
    assert(response.type === "json");

    const newHookNames = (await listUploadHooks())
      .filter((hook) => !existingHookIds.has(hook.id.toString()))
      .map((hook) => hook.hookName);
    expect(newHookNames).toEqual(
      expect.arrayContaining([
        "onUploadTimeout",
        "onFileReady",
        "onFileTextIndexRequested",
        "cleanupStorageObject",
      ]),
    );
  });

  it("rejects replacement of a missing file before staging storage", async () => {
    const response = await fragment.callRoute("POST", "/files/apply-edits", {
      body: {
        provider,
        edits: [
          {
            kind: "replace",
            fileKey: "missing/file.txt",
            search: "before",
            replacement: "after",
          },
        ],
      },
    });

    assert(response.type === "error");
    assert(response.status === 404);
    assert(response.error.code === "FILE_NOT_FOUND");
    expect(writeStream).not.toHaveBeenCalled();
  });

  it("rejects a provider other than the configured storage provider", async () => {
    const response = await fragment.callRoute("POST", "/files/apply-edits", {
      body: {
        provider: "other-provider",
        edits: [{ kind: "write", fileKey: "file.txt", content: "content" }],
      },
    });

    assert(response.type === "error");
    assert(response.status === 409);
    assert(response.error.code === "PROVIDER_MISMATCH");
    expect(writeStream).not.toHaveBeenCalled();
  });

  it("rejects more than ten edit operations", async () => {
    const response = await fragment.callRoute("POST", "/files/apply-edits", {
      body: {
        provider,
        edits: Array.from({ length: 11 }, (_, index) => ({
          kind: "write" as const,
          fileKey: `limit/${index}.txt`,
          content: "content",
        })),
      },
    });

    assert(response.type === "error");
    assert(response.status === 400);
    expect(writeStream).not.toHaveBeenCalled();
  });

  it("maps diff line-limit failures to an invalid request", async () => {
    const response = await fragment.callRoute("POST", "/files/apply-edits", {
      body: {
        provider,
        edits: [
          {
            kind: "write",
            fileKey: "limits/too-many-lines.txt",
            content: Array.from({ length: 10_001 }, () => "line").join("\n"),
          },
        ],
      },
    });

    assert(response.type === "error");
    assert(response.status === 400);
    assert(response.error.code === "INVALID_REQUEST");
    expect(writeStream).not.toHaveBeenCalled();
  });

  it("maps download body failures to storage errors", async () => {
    await createFile("failures/read.txt", "before");
    getDownloadStream.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("injected body failure"));
            },
          }),
        ),
    );
    writeStream.mockClear();

    const response = await fragment.callRoute("POST", "/files/apply-edits", {
      body: {
        provider,
        edits: [
          {
            kind: "replace",
            fileKey: "failures/read.txt",
            search: "before",
            replacement: "after",
          },
        ],
      },
    });

    assert(response.type === "error");
    assert(response.status === 502);
    assert(response.error.code === "STORAGE_ERROR");
    expect(writeStream).not.toHaveBeenCalled();
  });
});

describe("file edit storage failures", () => {
  it("retains staged objects when prepared-upload persistence has an ambiguous outcome", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragno-upload-file-edit-ambiguous-"));
    const filesystemStorage = createFilesystemStorageAdapter({ rootDir });
    const deleteObject = vi.fn(filesystemStorage.deleteObject.bind(filesystemStorage));
    const storage: StorageAdapter = { ...filesystemStorage, deleteObject };
    let injectAcknowledgementFailure = false;
    const instrumentation: UOWInstrumentation = {
      afterMutate(context) {
        if (injectAcknowledgementFailure && context.mutationOpsCount > 0) {
          injectAcknowledgementFailure = false;
          return { type: "error", error: new Error("injected lost commit acknowledgement") };
        }
        return undefined;
      },
    };
    const testSetup = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite", uowConfig: { instrumentation } })
      .withDbRoundtripGuard({ maxRoundtrips: 3 })
      .withFragment(
        "upload",
        instantiate(uploadFragmentDefinition).withConfig({ storage }).withRoutes(uploadRoutes),
      )
      .build();

    try {
      await testSetup.test.resetDatabase();
      injectAcknowledgementFailure = true;
      const response = await testSetup.fragments.upload.fragment.callRoute(
        "POST",
        "/files/apply-edits",
        {
          body: {
            provider: storage.name,
            edits: [{ kind: "write", fileKey: "ambiguous/file.txt", content: "content" }],
          },
        },
      );
      assert(response.type === "error");
      assert(response.status === 500);
      expect(deleteObject).not.toHaveBeenCalled();
    } finally {
      await testSetup.test.cleanup();
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects and aborts a direct multipart strategy before writing edited content", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragno-upload-file-edit-strategy-"));
    const filesystemStorage = createFilesystemStorageAdapter({ rootDir });
    const writeStream = vi.fn(filesystemStorage.writeStream!.bind(filesystemStorage));
    const abortMultipartUpload = vi.fn(async () => undefined);
    const storage: StorageAdapter = {
      ...filesystemStorage,
      writeStream,
      abortMultipartUpload,
      initUpload: async (input) => ({
        ...(await filesystemStorage.initUpload(input)),
        strategy: "direct-multipart",
        storageUploadId: "multipart-upload",
      }),
    };
    const testSetup = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withDbRoundtripGuard({ maxRoundtrips: 3 })
      .withFragment(
        "upload",
        instantiate(uploadFragmentDefinition).withConfig({ storage }).withRoutes(uploadRoutes),
      )
      .build();

    try {
      await testSetup.test.resetDatabase();
      const response = await testSetup.fragments.upload.fragment.callRoute(
        "POST",
        "/files/apply-edits",
        {
          body: {
            provider: storage.name,
            edits: [{ kind: "write", fileKey: "strategy/file.txt", content: "content" }],
          },
        },
      );

      assert(response.type === "error");
      assert(response.status === 502);
      assert(response.error.code === "STORAGE_ERROR");
      expect(abortMultipartUpload).toHaveBeenCalledTimes(1);
      expect(writeStream).not.toHaveBeenCalled();
    } finally {
      await testSetup.test.cleanup();
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("deletes an initialized object when its server-side write fails", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragno-upload-file-edit-failure-"));
    const filesystemStorage = createFilesystemStorageAdapter({ rootDir });
    const deleteObject = vi.fn(filesystemStorage.deleteObject.bind(filesystemStorage));
    const storage: StorageAdapter = {
      ...filesystemStorage,
      deleteObject,
      writeStream: async (input) => {
        await filesystemStorage.writeStream!(input);
        throw new Error("injected write failure");
      },
    };
    const testSetup = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withDbRoundtripGuard({ maxRoundtrips: 3 })
      .withFragment(
        "upload",
        instantiate(uploadFragmentDefinition).withConfig({ storage }).withRoutes(uploadRoutes),
      )
      .build();

    try {
      await testSetup.test.resetDatabase();
      const response = await testSetup.fragments.upload.fragment.callRoute(
        "POST",
        "/files/apply-edits",
        {
          body: {
            provider: storage.name,
            edits: [{ kind: "write", fileKey: "failed/file.txt", content: "content" }],
          },
        },
      );

      assert(response.type === "error");
      assert(response.status === 502);
      assert(response.error.code === "STORAGE_ERROR");
      expect(deleteObject).toHaveBeenCalledTimes(1);
    } finally {
      await testSetup.test.cleanup();
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
