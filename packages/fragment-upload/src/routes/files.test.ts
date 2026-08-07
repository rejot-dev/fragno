import { afterAll, beforeEach, describe, expect, it, assert, vi } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { instantiate } from "@fragno-dev/core";
import { getInternalFragment } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { uploadFragmentDefinition } from "../definition";
import { uploadRoutes } from "../index";
import { uploadSchema } from "../schema";
import { createFilesystemStorageAdapter } from "../storage/fs";
import type { StorageAdapter } from "../storage/types";
import type { UploadFileWritePrecondition } from "../types";

describe("upload file routes", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragno-upload-routes-"));
  const storage = createFilesystemStorageAdapter({ rootDir });
  const provider = storage.name;

  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withDbRoundtripGuard({ maxRoundtrips: 2 })
    .withFragment(
      "upload",
      instantiate(uploadFragmentDefinition).withConfig({ storage }).withRoutes(uploadRoutes),
    )
    .build();

  const { fragment, db } = fragments["upload"];

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

  const createFileForm = (input: {
    content: string;
    filename: string;
    fileKey: string;
    precondition?: UploadFileWritePrecondition;
  }) => {
    const form = new FormData();
    form.set(
      "file",
      new File([Buffer.from(input.content)], input.filename, { type: "text/plain" }),
    );
    form.set("provider", provider);
    form.set("fileKey", input.fileKey);
    if (input.precondition) {
      form.set("precondition", JSON.stringify(input.precondition));
    }
    return form;
  };

  const expectMutationResultWithoutTimestamps = (result: object) => {
    expect(result).not.toHaveProperty("createdAt");
    expect(result).not.toHaveProperty("updatedAt");
    expect(result).not.toHaveProperty("completedAt");
    expect(result).not.toHaveProperty("deletedAt");
  };

  const listUploadHooks = async () => {
    const internalFragment = getInternalFragment(testContext.adapter);
    return await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [internalFragment.services.hookService.getHooksByNamespace("upload")] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });
  };

  const prepareProxyFile = async (fileKey: string, content: string) => {
    const created = await fragment.callRoute("POST", "/uploads", {
      body: {
        provider,
        fileKey,
        filename: path.basename(fileKey),
        sizeBytes: Buffer.byteLength(content),
        contentType: "text/plain",
        publicationMode: "batch",
      },
    });
    assert(created.type === "json");

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(content));
        controller.close();
      },
    });
    const prepared = await fragment.callRoute("PUT", "/uploads/:uploadId/content", {
      pathParams: { uploadId: created.data.uploadId },
      body: stream,
    });
    assert(prepared.type === "json");
    assert(prepared.data.kind === "prepared");
    return prepared.data.write;
  };

  it("publishes prepared proxy uploads atomically and replays the committed batch", async () => {
    const first = await prepareProxyFile("prepared/first.txt", "first-v1");
    const second = await prepareProxyFile("prepared/second.txt", "second-v1");

    for (const fileKey of [first.fileKey, second.fileKey]) {
      const invisible = await fragment.callRoute("GET", "/files/by-key", {
        query: { provider, key: fileKey },
      });
      assert(invisible.type === "error");
      assert(invisible.error.code === "FILE_NOT_FOUND");
    }

    const entries = [first, second].map((prepared) => ({
      kind: "write" as const,
      uploadId: prepared.uploadId,
      precondition: { kind: "absent" as const },
    }));
    const committed = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: { entries },
    });
    assert(committed.type === "json");
    expect(committed.data.files.map((file) => [file.fileKey, file.revision])).toEqual([
      [first.fileKey, 0],
      [second.fileKey, 0],
    ]);
    committed.data.files.forEach(expectMutationResultWithoutTimestamps);

    const replayed = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: { entries },
    });
    assert(replayed.type === "json");
    expect(replayed.data.files.map((file) => [file.fileKey, file.revision])).toEqual([
      [first.fileKey, 0],
      [second.fileKey, 0],
    ]);
    replayed.data.files.forEach(expectMutationResultWithoutTimestamps);

    const firstContent = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: first.fileKey },
    });
    const secondContent = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: second.fileKey },
    });
    assert((await firstContent.text()) === "first-v1");
    assert((await secondContent.text()) === "second-v1");
  });

  it("commits and replays prepared writes with revision-conditional deletions", async () => {
    const removedKey = "prepared/removed.txt";
    const removed = await fragment.callRoute("POST", "/files", {
      body: createFileForm({ content: "remove me", filename: "removed.txt", fileKey: removedKey }),
    });
    assert(removed.type === "json");
    const removedSnapshot = await fragment.callRoute("GET", "/files/by-key", {
      query: { provider, key: removedKey },
    });
    assert(removedSnapshot.type === "json");
    const prepared = await prepareProxyFile("prepared/created-with-delete.txt", "created");
    const entries = [
      {
        kind: "write" as const,
        uploadId: prepared.uploadId,
        precondition: { kind: "absent" as const },
      },
      {
        kind: "delete" as const,
        provider,
        fileKey: removedKey,
        precondition: { kind: "revision" as const, revision: removedSnapshot.data.revision },
      },
    ];

    const committed = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: { entries },
    });
    assert(committed.type === "json");
    expect(committed.data.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fileKey: prepared.fileKey, status: "ready" }),
        expect.objectContaining({ fileKey: removedKey, status: "deleted" }),
      ]),
    );

    const replayed = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: { entries },
    });
    assert(replayed.type === "json");
    expect(replayed.data.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fileKey: prepared.fileKey, status: "ready" }),
        expect.objectContaining({ fileKey: removedKey, status: "deleted" }),
      ]),
    );

    const removedContent = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: removedKey },
    });
    assert(removedContent.status === 410);
    const createdContent = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: prepared.fileKey },
    });
    await expect(createdContent.text()).resolves.toBe("created");
  });

  it("leaves prepared writes unpublished when a conditional deletion loses its revision", async () => {
    const removedKey = "prepared/stale-delete.txt";
    const removed = await fragment.callRoute("POST", "/files", {
      body: createFileForm({
        content: "current",
        filename: "stale-delete.txt",
        fileKey: removedKey,
      }),
    });
    assert(removed.type === "json");
    const removedSnapshot = await fragment.callRoute("GET", "/files/by-key", {
      query: { provider, key: removedKey },
    });
    assert(removedSnapshot.type === "json");
    const prepared = await prepareProxyFile("prepared/rejected-by-delete.txt", "unpublished");

    const rejected = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: {
        entries: [
          {
            kind: "write",
            uploadId: prepared.uploadId,
            precondition: { kind: "absent" },
          },
          {
            kind: "delete",
            provider,
            fileKey: removedKey,
            precondition: { kind: "revision", revision: removedSnapshot.data.revision + 1 },
          },
        ],
      },
    });
    assert(rejected.type === "error");
    assert(rejected.status === 412);
    assert(rejected.error.code === "FILE_PRECONDITION_FAILED");

    const removedContent = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: removedKey },
    });
    await expect(removedContent.text()).resolves.toBe("current");
    const unpublished = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: prepared.fileKey },
    });
    assert(unpublished.status === 404);
  });

  it("leaves prepared writes unpublished when a conditional deletion target is missing", async () => {
    const missingKey = "prepared/missing-delete.txt";
    const prepared = await prepareProxyFile(
      "prepared/rejected-by-missing-delete.txt",
      "unpublished",
    );

    const rejected = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: {
        entries: [
          {
            kind: "write",
            uploadId: prepared.uploadId,
            precondition: { kind: "absent" },
          },
          {
            kind: "delete",
            provider,
            fileKey: missingKey,
            precondition: { kind: "revision", revision: 0 },
          },
        ],
      },
    });
    assert(rejected.type === "error");
    assert(rejected.status === 412);
    assert(rejected.error.code === "FILE_PRECONDITION_FAILED");

    const unpublished = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: prepared.fileKey },
    });
    assert(unpublished.status === 404);
  });

  it("leaves every file unchanged when a prepared batch assertion fails", async () => {
    const stableKey = "prepared/stable.txt";
    const changedKey = "prepared/changed.txt";
    for (const [fileKey, content] of [
      [stableKey, "stable-v1"],
      [changedKey, "changed-v1"],
    ] as const) {
      const created = await fragment.callRoute("POST", "/files", {
        body: createFileForm({ content, filename: path.basename(fileKey), fileKey }),
      });
      assert(created.type === "json");
    }

    const stable = await fragment.callRoute("GET", "/files/by-key", {
      query: { provider, key: stableKey },
    });
    const changed = await fragment.callRoute("GET", "/files/by-key", {
      query: { provider, key: changedKey },
    });
    assert(stable.type === "json");
    assert(changed.type === "json");

    const prepared = await prepareProxyFile(changedKey, "changed-v2");
    const rejected = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: {
        entries: [
          {
            kind: "write",
            uploadId: prepared.uploadId,
            precondition: { kind: "revision", revision: changed.data.revision },
          },
          {
            kind: "assert",
            provider,
            fileKey: stableKey,
            precondition: { kind: "revision", revision: stable.data.revision + 1 },
          },
        ],
      },
    });
    assert(rejected.type === "error");
    assert(rejected.status === 412);
    assert(rejected.error.code === "FILE_PRECONDITION_FAILED");

    for (const [fileKey, content] of [
      [stableKey, "stable-v1"],
      [changedKey, "changed-v1"],
    ] as const) {
      const response = await fragment.callRouteRaw("GET", "/files/by-key/content", {
        query: { provider, key: fileKey },
      });
      expect(await response.text()).toBe(content);
    }
  });

  it("commits a prepared write with a matching read-only assertion", async () => {
    const observedKey = "prepared/observed.txt";
    const observed = await fragment.callRoute("POST", "/files", {
      body: createFileForm({
        content: "observed",
        filename: "observed.txt",
        fileKey: observedKey,
      }),
    });
    assert(observed.type === "json");
    const observedSnapshot = await fragment.callRoute("GET", "/files/by-key", {
      query: { provider, key: observedKey },
    });
    assert(observedSnapshot.type === "json");
    const prepared = await prepareProxyFile("prepared/asserted-write.txt", "new");

    const committed = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: {
        entries: [
          {
            kind: "write",
            uploadId: prepared.uploadId,
            precondition: { kind: "absent" },
          },
          {
            kind: "assert",
            provider,
            fileKey: observedKey,
            precondition: { kind: "revision", revision: observedSnapshot.data.revision },
          },
        ],
      },
    });
    assert(committed.type === "json");
    expect(committed.data.files.map((file) => file.fileKey)).toEqual([prepared.fileKey]);
  });

  it("accepts a mixture of exactly published and still-prepared writes", async () => {
    const alreadyCommitted = await prepareProxyFile("prepared/mixed-a.txt", "a");
    const stillPrepared = await prepareProxyFile("prepared/mixed-b.txt", "b");
    const firstCommit = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: {
        entries: [
          {
            kind: "write",
            uploadId: alreadyCommitted.uploadId,
            precondition: { kind: "absent" },
          },
        ],
      },
    });
    assert(firstCommit.type === "json");

    const mixedCommit = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: {
        entries: [
          {
            kind: "write",
            uploadId: alreadyCommitted.uploadId,
            precondition: { kind: "absent" },
          },
          {
            kind: "write",
            uploadId: stillPrepared.uploadId,
            precondition: { kind: "absent" },
          },
        ],
      },
    });
    assert(mixedCommit.type === "json");
    expect(mixedCommit.data.files.map((file) => [file.fileKey, file.revision])).toEqual([
      [alreadyCommitted.fileKey, 0],
      [stillPrepared.fileKey, 0],
    ]);
  });

  it("keeps the published object visible when an unpublished replacement is aborted", async () => {
    const fileKey = "prepared/abort-replacement.txt";
    const created = await fragment.callRoute("POST", "/files", {
      body: createFileForm({ content: "published", filename: "current.txt", fileKey }),
    });
    assert(created.type === "json");
    const prepared = await prepareProxyFile(fileKey, "unpublished");

    const aborted = await fragment.callRoute("POST", "/uploads/:uploadId/abort", {
      pathParams: { uploadId: prepared.uploadId },
    });
    assert(aborted.type === "json");
    await drainDurableHooks(fragment);

    const content = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: fileKey },
    });
    assert((await content.text()) === "published");
  });

  it("rejects aborting a prepared upload after its batch commit wins", async () => {
    const prepared = await prepareProxyFile("prepared/committed-before-abort.txt", "committed");
    const committed = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: {
        entries: [
          {
            kind: "write",
            uploadId: prepared.uploadId,
            precondition: { kind: "absent" },
          },
        ],
      },
    });
    assert(committed.type === "json");

    const aborted = await fragment.callRoute("POST", "/uploads/:uploadId/abort", {
      pathParams: { uploadId: prepared.uploadId },
    });
    assert(aborted.type === "error");
    assert(aborted.status === 409);
    assert(aborted.error.code === "UPLOAD_INVALID_STATE");

    const content = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: prepared.fileKey },
    });
    assert(content.status === 200);
    assert((await content.text()) === "committed");
  });

  it("queues cleanup and ready effects only when prepared replacements commit", async () => {
    const fileKeys = ["prepared/hooks-a.txt", "prepared/hooks-b.txt"];
    for (const fileKey of fileKeys) {
      const created = await fragment.callRoute("POST", "/files", {
        body: createFileForm({ content: "old", filename: path.basename(fileKey), fileKey }),
      });
      assert(created.type === "json");
    }
    const snapshots = await Promise.all(
      fileKeys.map(async (fileKey) => {
        const response = await fragment.callRoute("GET", "/files/by-key", {
          query: { provider, key: fileKey },
        });
        assert(response.type === "json");
        return response.data;
      }),
    );
    const baselineHooks = await listUploadHooks();
    const baselineEffectCount = baselineHooks.filter((hook) =>
      ["cleanupStorageObject", "onFileReady", "onFileTextIndexRequested"].includes(hook.hookName),
    ).length;

    const prepared = await Promise.all(
      fileKeys.map((fileKey, index) => prepareProxyFile(fileKey, `new-${index}`)),
    );
    const afterPrepareHooks = await listUploadHooks();
    expect(
      afterPrepareHooks.filter((hook) =>
        ["cleanupStorageObject", "onFileReady", "onFileTextIndexRequested"].includes(hook.hookName),
      ),
    ).toHaveLength(baselineEffectCount);

    const committed = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: {
        entries: prepared.map((upload, index) => ({
          kind: "write" as const,
          uploadId: upload.uploadId,
          precondition: {
            kind: "revision" as const,
            revision: snapshots[index]?.revision ?? -1,
          },
        })),
      },
    });
    assert(committed.type === "json");

    const committedHooks = await listUploadHooks();
    const newlyQueuedHooks = committedHooks.slice(baselineHooks.length);
    expect(
      newlyQueuedHooks.filter((hook) => hook.hookName === "cleanupStorageObject"),
    ).toHaveLength(2);
    expect(newlyQueuedHooks.filter((hook) => hook.hookName === "onFileReady")).toHaveLength(2);
    expect(
      newlyQueuedHooks.filter((hook) => hook.hookName === "onFileTextIndexRequested"),
    ).toHaveLength(2);
  });

  it("rejects duplicate prepared upload identities and destinations", async () => {
    const first = await prepareProxyFile("prepared/duplicate.txt", "first");
    const duplicateUploadId = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: {
        entries: [
          { kind: "write", uploadId: first.uploadId, precondition: { kind: "absent" } },
          { kind: "write", uploadId: first.uploadId, precondition: { kind: "absent" } },
        ],
      },
    });
    assert(duplicateUploadId.type === "error");
    assert(duplicateUploadId.status === 400);
    assert(duplicateUploadId.error.code === "INVALID_REQUEST");

    const second = await prepareProxyFile("prepared/duplicate.txt", "second");
    const duplicateDestination = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: {
        entries: [
          { kind: "write", uploadId: first.uploadId, precondition: { kind: "absent" } },
          { kind: "write", uploadId: second.uploadId, precondition: { kind: "absent" } },
        ],
      },
    });
    assert(duplicateDestination.type === "error");
    assert(duplicateDestination.status === 400);
    assert(duplicateDestination.error.code === "INVALID_REQUEST");
  });

  it("rejects the losing prepared batch without publishing any of its objects", async () => {
    const firstBatch = [
      await prepareProxyFile("prepared/concurrent-a.txt", "first-a"),
      await prepareProxyFile("prepared/concurrent-b.txt", "first-b"),
    ];
    const secondBatch = [
      await prepareProxyFile("prepared/concurrent-a.txt", "second-a"),
      await prepareProxyFile("prepared/concurrent-b.txt", "second-b"),
    ];
    const toEntries = (batch: typeof firstBatch) =>
      batch.map((prepared) => ({
        kind: "write" as const,
        uploadId: prepared.uploadId,
        precondition: { kind: "absent" as const },
      }));

    const winner = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: { entries: toEntries(firstBatch) },
    });
    assert(winner.type === "json");
    const loser = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: { entries: toEntries(secondBatch) },
    });
    assert(loser.type === "error");
    assert(loser.status === 412);
    assert(loser.error.code === "FILE_PRECONDITION_FAILED");

    for (const [fileKey, content] of [
      ["prepared/concurrent-a.txt", "first-a"],
      ["prepared/concurrent-b.txt", "first-b"],
    ] as const) {
      const response = await fragment.callRouteRaw("GET", "/files/by-key/content", {
        query: { provider, key: fileKey },
      });
      expect(await response.text()).toBe(content);
    }
  });

  it("retries a unique create race and re-evaluates the original absence precondition", async () => {
    const attempts = [
      await prepareProxyFile("prepared/unique-race.txt", "first"),
      await prepareProxyFile("prepared/unique-race.txt", "second"),
    ];
    const responses = await Promise.all(
      attempts.map((prepared) =>
        fragment.callRoute("POST", "/files/commit-prepared", {
          body: {
            entries: [
              {
                kind: "write",
                uploadId: prepared.uploadId,
                precondition: { kind: "absent" },
              },
            ],
          },
        }),
      ),
    );
    const successfulIndex = responses.findIndex((response) => response.type === "json");
    const failures = responses.filter((response) => response.type === "error");
    expect(successfulIndex).not.toBe(-1);
    expect(failures).toHaveLength(1);
    const failure = failures[0];
    assert(failure?.type === "error");
    assert(failure.status === 412);
    assert(failure.error.code === "FILE_PRECONDITION_FAILED");

    const content = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: "prepared/unique-race.txt" },
    });
    expect(await content.text()).toBe(successfulIndex === 0 ? "first" : "second");
  });

  it("rejects unknown, active, failed, aborted, and expired uploads", async () => {
    const active = await fragment.callRoute("POST", "/uploads", {
      body: {
        provider,
        fileKey: "prepared/active.txt",
        filename: "active.txt",
        sizeBytes: 1,
        contentType: "text/plain",
      },
    });
    assert(active.type === "json");
    const failed = await prepareProxyFile("prepared/failed.txt", "failed");
    const aborted = await prepareProxyFile("prepared/aborted.txt", "aborted");
    const expired = await prepareProxyFile("prepared/expired.txt", "expired");

    for (const [uploadId, status, expiresAt] of [
      [failed.uploadId, "failed", undefined],
      [aborted.uploadId, "aborted", undefined],
      [expired.uploadId, "prepared", new Date(Date.now() - 1_000)],
    ] as const) {
      const uow = db.createUnitOfWork("write").forSchema(uploadSchema);
      uow.update("upload", uploadId, (b) => b.set({ status, ...(expiresAt ? { expiresAt } : {}) }));
      assert((await uow.executeMutations()).success);
    }

    const cases = [
      { uploadId: "missing-upload", code: "UPLOAD_NOT_FOUND", status: 404 },
      { uploadId: active.data.uploadId, code: "UPLOAD_INVALID_STATE", status: 409 },
      { uploadId: failed.uploadId, code: "UPLOAD_INVALID_STATE", status: 409 },
      { uploadId: aborted.uploadId, code: "UPLOAD_INVALID_STATE", status: 409 },
      { uploadId: expired.uploadId, code: "UPLOAD_EXPIRED", status: 410 },
    ];
    for (const expected of cases) {
      const response = await fragment.callRoute("POST", "/files/commit-prepared", {
        body: {
          entries: [
            {
              kind: "write",
              uploadId: expected.uploadId,
              precondition: { kind: "absent" },
            },
          ],
        },
      });
      assert(response.type === "error");
      expect(response.status).toBe(expected.status);
      expect(response.error.code).toBe(expected.code);
    }
  });

  it("POST /files uploads and allows reading back content", async () => {
    const form = new FormData();
    const file = new File([Buffer.from("hello")], "hello.txt", {
      type: "text/plain",
    });
    form.set("file", file);
    form.set("provider", provider);
    form.set("keyParts", JSON.stringify(["users", 1, "avatar"]));
    form.set("metadata", JSON.stringify({ purpose: "test" }));
    form.set("tags", JSON.stringify(["profile"]));

    const response = await fragment.callRoute("POST", "/files", { body: form });
    assert(response.type === "json");
    assert(response.status === 200);
    assert(response.data.status === "ready");
    expectMutationResultWithoutTimestamps(response.data);
    const { fileKey } = response.data;

    const getResponse = await fragment.callRoute("GET", "/files/by-key", {
      query: { provider, key: fileKey },
    });
    assert(getResponse.type === "json");
    expect(getResponse.data.fileKey).toBe(fileKey);
    assert(getResponse.data.filename === "hello.txt");
    assert(getResponse.data.revision === 0);

    const contentResponse = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: fileKey },
    });
    assert(contentResponse.status === 200);
    assert((await contentResponse.text()) === "hello");
  });

  it("accepts provider namespaces that differ from the storage adapter name", async () => {
    const providerAlias = "customer-assets";
    const form = new FormData();
    const file = new File([Buffer.from("aliased")], "aliased.txt", {
      type: "text/plain",
    });
    form.set("file", file);
    form.set("provider", providerAlias);
    form.set("keyParts", JSON.stringify(["users", 7, "aliased"]));

    const createResponse = await fragment.callRoute("POST", "/files", {
      body: form,
    });
    assert(createResponse.type === "json");
    expect(createResponse.data.provider).toBe(providerAlias);
    const { fileKey } = createResponse.data;

    const getResponse = await fragment.callRoute("GET", "/files/by-key", {
      query: { provider: providerAlias, key: fileKey },
    });
    assert(getResponse.type === "json");
    expect(getResponse.data.provider).toBe(providerAlias);

    const updateResponse = await fragment.callRoute("PATCH", "/files/by-key", {
      query: { provider: providerAlias, key: fileKey },
      body: { filename: "renamed.txt" },
    });
    assert(updateResponse.type === "json");
    assert(updateResponse.data.filename === "renamed.txt");
    expectMutationResultWithoutTimestamps(updateResponse.data);

    const downloadResponse = await fragment.callRoute("GET", "/files/by-key/download-url", {
      query: { provider: providerAlias, key: fileKey },
    });
    assert(downloadResponse.type === "error");
    assert(downloadResponse.error.code === "SIGNED_URL_UNSUPPORTED");

    const contentResponse = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider: providerAlias, key: fileKey },
    });
    assert(contentResponse.status === 200);
    assert((await contentResponse.text()) === "aliased");

    const deleteResponse = await fragment.callRoute("DELETE", "/files/by-key", {
      query: { provider: providerAlias, key: fileKey },
    });
    assert(deleteResponse.type === "json");
    expect(deleteResponse.data).toEqual({ ok: true });
  });

  it("enforces absent and revision preconditions and cleans up rejected objects", async () => {
    const fileKey = "workspace/conditional.txt";
    const initialResponse = await fragment.callRoute("POST", "/files", {
      body: createFileForm({
        content: "initial",
        filename: "conditional.txt",
        fileKey,
        precondition: { kind: "absent" },
      }),
    });
    assert(initialResponse.type === "json");

    const initialSnapshot = await fragment.callRoute("GET", "/files/by-key", {
      query: { provider, key: fileKey },
    });
    assert(initialSnapshot.type === "json");
    assert(initialSnapshot.data.revision === 0);

    const replacementResponse = await fragment.callRoute("POST", "/files", {
      body: createFileForm({
        content: "replacement",
        filename: "conditional.txt",
        fileKey,
        precondition: { kind: "revision", revision: initialSnapshot.data.revision },
      }),
    });
    assert(replacementResponse.type === "json");

    const replacementSnapshot = await fragment.callRoute("GET", "/files/by-key", {
      query: { provider, key: fileKey },
    });
    assert(replacementSnapshot.type === "json");
    assert(replacementSnapshot.data.revision === 1);

    const deleteObject = vi.spyOn(storage, "deleteObject");
    try {
      const staleResponse = await fragment.callRoute("POST", "/files", {
        body: createFileForm({
          content: "stale overwrite",
          filename: "conditional.txt",
          fileKey,
          precondition: { kind: "revision", revision: initialSnapshot.data.revision },
        }),
      });
      assert(staleResponse.type === "error");
      assert(staleResponse.status === 412);
      assert(staleResponse.error.code === "FILE_PRECONDITION_FAILED");
      expect(deleteObject).toHaveBeenCalledOnce();
    } finally {
      deleteObject.mockRestore();
    }

    const contentResponse = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: fileKey },
    });
    assert(contentResponse.status === 200);
    assert((await contentResponse.text()) === "replacement");
  });

  it("keeps the successful object when concurrent writes begin in the same millisecond", async () => {
    const fileKey = "workspace/concurrent.txt";
    const attempts = [
      { content: "first", filename: "concurrent.txt" },
      { content: "second", filename: "concurrent.txt" },
    ];
    const now = vi.spyOn(Date, "now").mockReturnValue(1_750_000_000_000);
    const deleteObject = vi.spyOn(storage, "deleteObject");

    try {
      const responses = await Promise.all(
        attempts.map((attempt) =>
          fragment.callRoute("POST", "/files", {
            body: createFileForm({
              ...attempt,
              fileKey,
              precondition: { kind: "absent" },
            }),
          }),
        ),
      );

      const successfulIndex = responses.findIndex((response) => response.type === "json");
      const rejected = responses.filter((response) => response.type === "error");
      assert(successfulIndex !== -1);
      assert(rejected.length === 1);
      assert(rejected[0]?.type === "error");
      assert(rejected[0].status === 412);
      assert(rejected[0].error.code === "FILE_PRECONDITION_FAILED");
      expect(deleteObject).toHaveBeenCalledOnce();

      const contentResponse = await fragment.callRouteRaw("GET", "/files/by-key/content", {
        query: { provider, key: fileKey },
      });
      assert(contentResponse.status === 200);
      assert((await contentResponse.text()) === attempts[successfulIndex]?.content);

      const physicalVersions = await fs.readdir(path.join(rootDir, provider, fileKey));
      expect(physicalVersions).toHaveLength(1);
      expect(physicalVersions[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    } finally {
      deleteObject.mockRestore();
      now.mockRestore();
    }
  });

  it("rejects malformed provider namespaces in POST /files", async () => {
    const form = new FormData();
    const file = new File([Buffer.from("hello")], "hello.txt", {
      type: "text/plain",
    });
    form.set("file", file);
    form.set("provider", "bad/provider");
    form.set("keyParts", JSON.stringify(["users", 11, "avatar"]));

    const response = await fragment.callRoute("POST", "/files", { body: form });
    assert(response.type === "error");
    assert(response.status === 400);
    assert(response.error.code === "INVALID_REQUEST");
  });

  it("rejects malformed file write preconditions", async () => {
    const form = createFileForm({
      content: "unsafe",
      filename: "unsafe.txt",
      fileKey: "workspace/unsafe.txt",
    });
    form.set("precondition", "not-json");

    const response = await fragment.callRoute("POST", "/files", { body: form });
    assert(response.type === "error");
    assert(response.status === 400);
    assert(response.error.code === "INVALID_REQUEST");
  });

  it("GET /files/by-key/content rejects deleted files", async () => {
    const form = new FormData();
    const file = new File([Buffer.from("goodbye")], "goodbye.txt", {
      type: "text/plain",
    });
    form.set("file", file);
    form.set("provider", provider);
    form.set("keyParts", JSON.stringify(["users", 9, "goodbye"]));

    const createResponse = await fragment.callRoute("POST", "/files", {
      body: form,
    });
    assert(createResponse.type === "json");
    const { fileKey } = createResponse.data;

    const deleteResponse = await fragment.callRoute("DELETE", "/files/by-key", {
      query: { provider, key: fileKey },
    });
    assert(deleteResponse.type === "json");
    expect(deleteResponse.data).toEqual({ ok: true });

    const contentResponse = await fragment.callRoute("GET", "/files/by-key/content", {
      query: { provider, key: fileKey },
    });
    assert(contentResponse.type === "error");
    assert(contentResponse.status === 410);
    assert(contentResponse.error.code === "FILE_DELETED");
  });

  it("DELETE /files/by-key deletes storage through durable hooks", async () => {
    const form = new FormData();
    const file = new File([Buffer.from("hook delete")], "hook-delete.txt", {
      type: "text/plain",
    });
    form.set("file", file);
    form.set("provider", provider);
    form.set("keyParts", JSON.stringify(["users", 10, "hook-delete"]));

    const createResponse = await fragment.callRoute("POST", "/files", {
      body: form,
    });
    assert(createResponse.type === "json");
    const { fileKey } = createResponse.data;
    const storedFile = await (async () => {
      const uow = db
        .createUnitOfWork("read")
        .forSchema(uploadSchema)
        .findFirst("file", (b) =>
          b.whereIndex("idx_file_provider_key", (eb) =>
            eb.and(eb("provider", "=", provider), eb("key", "=", fileKey)),
          ),
        );
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();
    expect(storedFile?.objectKey).toBeDefined();
    if (!storedFile?.objectKey) {
      throw new Error("Stored file missing objectKey");
    }
    const storagePath = path.join(rootDir, ...storedFile.objectKey.split("/"));

    assert((await fs.readFile(storagePath, "utf8")) === "hook delete");

    const deleteResponse = await fragment.callRoute("DELETE", "/files/by-key", {
      query: { provider, key: fileKey },
    });
    assert(deleteResponse.type === "json");
    expect(deleteResponse.data).toEqual({ ok: true });

    // The delete route now performs a logical delete only; bytes are removed by the durable hook.
    assert((await fs.readFile(storagePath, "utf8")) === "hook delete");

    await drainDurableHooks(fragment);

    await expect(fs.readFile(storagePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("POST /files allows re-uploading a deleted path without deleting the replacement bytes", async () => {
    const firstForm = new FormData();
    firstForm.set("file", new File([Buffer.from("first")], "first.txt", { type: "text/plain" }));
    firstForm.set("provider", provider);
    firstForm.set("keyParts", JSON.stringify(["users", 11, "avatar"]));

    const firstCreate = await fragment.callRoute("POST", "/files", {
      body: firstForm,
    });
    assert(firstCreate.type === "json");

    const deleteResponse = await fragment.callRoute("DELETE", "/files/by-key", {
      query: { provider, key: firstCreate.data.fileKey },
    });
    assert(deleteResponse.type === "json");

    const secondForm = new FormData();
    secondForm.set("file", new File([Buffer.from("second")], "second.txt", { type: "text/plain" }));
    secondForm.set("provider", provider);
    secondForm.set("fileKey", firstCreate.data.fileKey);
    secondForm.set("precondition", JSON.stringify({ kind: "absent" }));

    const secondCreate = await fragment.callRoute("POST", "/files", {
      body: secondForm,
    });
    assert(secondCreate.type === "json");
    assert(secondCreate.data.status === "ready");
    assert(secondCreate.data.filename === "second.txt");

    const beforeDrain = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: firstCreate.data.fileKey },
    });
    assert(beforeDrain.status === 200);
    assert((await beforeDrain.text()) === "second");

    await drainDurableHooks(fragment);

    const afterDrain = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: firstCreate.data.fileKey },
    });
    assert(afterDrain.status === 200);
    assert((await afterDrain.text()) === "second");
  });

  it("GET /files supports prefix pagination", async () => {
    const createForm = (name: string, keyParts: (string | number)[]) => {
      const form = new FormData();
      const file = new File([Buffer.from(name)], `${name}.txt`, {
        type: "text/plain",
      });
      form.set("file", file);
      form.set("provider", provider);
      form.set("keyParts", JSON.stringify(keyParts));
      return form;
    };

    await fragment.callRoute("POST", "/files", {
      body: createForm("one", ["users", 1, "one"]),
    });
    await fragment.callRoute("POST", "/files", {
      body: createForm("two", ["users", 1, "two"]),
    });
    await fragment.callRoute("POST", "/files", {
      body: createForm("other", ["users", 2, "other"]),
    });

    const response = await fragment.callRoute("GET", "/files", {
      query: {
        prefix: "users/1/",
        pageSize: "1",
      },
    });
    assert(response.type === "json");
    expect(response.data.files).toHaveLength(1);
    assert(response.data.hasNextPage);
    assert(response.data.files[0]?.fileKey.startsWith("users/1/"));
  });

  it("GET /files supports larger explicit page sizes", async () => {
    const response = await fragment.callRoute("GET", "/files", {
      query: { pageSize: "200" },
    });

    assert(response.type === "json");
    assert(response.status === 200);
    expect(response.data.files).toEqual([]);
  });

  it("GET /files rejects invalid page sizes", async () => {
    const response = await fragment.callRoute("GET", "/files", {
      query: { pageSize: "501" },
    });

    assert(response.type === "error");
    assert(response.status === 400);
    assert(response.error.code === "INVALID_REQUEST");
  });

  it("POST /files/search/hydrate rejects hydration budgets above 30 MiB", async () => {
    const response = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider,
        candidateKeys: ["workspace/file.txt"],
        query: "workflow",
        maxBytes: 30 * 1024 * 1024 + 1,
      },
    });

    assert(response.type === "error");
    assert(response.status === 400);
  });

  it("GET /files supports delimiter directory listings", async () => {
    const createForm = (name: string, keyParts: (string | number)[]) => {
      const form = new FormData();
      const file = new File([Buffer.from(name)], `${name}.txt`, {
        type: "text/plain",
      });
      form.set("file", file);
      form.set("provider", provider);
      form.set("keyParts", JSON.stringify(keyParts));
      return form;
    };

    await fragment.callRoute("POST", "/files", {
      body: createForm("one", ["users", 1, "one"]),
    });
    await fragment.callRoute("POST", "/files", {
      body: createForm("two", ["users", 1, "nested", "two"]),
    });
    await fragment.callRoute("POST", "/files", {
      body: createForm("other", ["users", 2, "other"]),
    });

    const response = await fragment.callRoute("GET", "/files", {
      query: {
        prefix: "users/1/",
        delimiter: "/",
        pageSize: "20",
      },
    });

    assert(response.type === "json");
    expect(response.data.files.map((file) => file.fileKey)).toEqual(["users/1/one"]);
    expect(response.data.directories).toMatchObject([
      {
        name: "nested",
        prefix: "users/1/nested/",
      },
    ]);
    assert(!response.data.hasNextPage);
  });

  it("GET /files rejects an empty provider filter", async () => {
    const response = await fragment.callRoute("GET", "/files", {
      query: { provider: "" },
    });

    assert(response.type === "error");
    assert(response.status === 400);
    assert(response.error.code === "INVALID_REQUEST");
  });

  it("GET /files/by-key/download-url uses the latest authoritative objectKey after overwrite", async () => {
    const getDownloadUrl = vi.fn(
      async ({
        storageKey,
        expiresInSeconds,
      }: Parameters<NonNullable<StorageAdapter["getDownloadUrl"]>>[0]) => ({
        url: `https://download.local/${encodeURIComponent(storageKey)}`,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1_000),
      }),
    );
    const writeStream = vi.fn(
      async ({ body }: Parameters<NonNullable<StorageAdapter["writeStream"]>>[0]) => {
        await new Response(body).arrayBuffer();
        return {};
      },
    );
    const storage = {
      name: "signed-proxy-test",
      capabilities: {
        directUpload: false,
        multipartUpload: false,
        signedDownload: true,
        proxyUpload: true,
      },
      resolveStorageKey: ({ provider, fileKey }) => `signed/${provider}/${fileKey}`,
      initUpload: async ({ provider, fileKey, objectKeyVersionSegment }) => ({
        strategy: "proxy" as const,
        storageKey: `signed/${provider}/${fileKey}/${objectKeyVersionSegment}`,
        expiresAt: new Date(Date.now() + 60_000),
      }),
      writeStream,
      deleteObject: async () => undefined,
      getDownloadUrl,
    } satisfies StorageAdapter;
    const build = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withDbRoundtripGuard({ maxRoundtrips: 2 })
      .withFragment(
        "upload",
        instantiate(uploadFragmentDefinition).withConfig({ storage }).withRoutes(uploadRoutes),
      )
      .build();

    try {
      const { fragment, db } = build.fragments.upload;

      const firstForm = new FormData();
      firstForm.set("file", new File([Buffer.from("first")], "first.txt", { type: "text/plain" }));
      firstForm.set("provider", storage.name);
      firstForm.set("keyParts", JSON.stringify(["users", 12, "downloadable"]));

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
        new File([Buffer.from("second")], "second.txt", { type: "text/plain" }),
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

      const downloadResponse = await fragment.callRoute("GET", "/files/by-key/download-url", {
        query: { provider: storage.name, key: firstCreate.data.fileKey },
      });
      assert(downloadResponse.type === "json");
      expect(downloadResponse.data.url).toBe(
        `https://download.local/${encodeURIComponent(currentFile.objectKey)}`,
      );
      expect(getDownloadUrl).toHaveBeenCalledTimes(1);
      expect(getDownloadUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          storageKey: currentFile.objectKey,
        }),
      );
      expect(getDownloadUrl).not.toHaveBeenCalledWith(
        expect.objectContaining({
          storageKey: firstFile.objectKey,
        }),
      );
    } finally {
      await build.test.cleanup();
    }
  });

  it("GET /files/by-key/download-url returns unsupported for filesystem adapter", async () => {
    const form = new FormData();
    const file = new File([Buffer.from("hello")], "hello.txt", {
      type: "text/plain",
    });
    form.set("file", file);
    form.set("provider", provider);
    form.set("keyParts", JSON.stringify(["users", 3, "avatar"]));

    const response = await fragment.callRoute("POST", "/files", { body: form });
    assert(response.type === "json");
    const { fileKey } = response.data;

    const downloadResponse = await fragment.callRoute("GET", "/files/by-key/download-url", {
      query: { provider, key: fileKey },
    });
    assert(downloadResponse.type === "error");
    assert(downloadResponse.error.code === "SIGNED_URL_UNSUPPORTED");
  });
});
