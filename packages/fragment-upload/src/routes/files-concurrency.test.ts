import { afterEach, assert, describe, expect, it, vi } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { UOWInstrumentation, UOWInstrumentationContext } from "@fragno-dev/db/unit-of-work";

import { instantiate } from "@fragno-dev/core";
import { getInternalFragment } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { uploadFragmentDefinition } from "../definition";
import { uploadRoutes } from "../index";
import { uploadSchema } from "../schema";
import { createFilesystemStorageAdapter } from "../storage/fs";

const pendingCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(pendingCleanups.splice(0).map(async (cleanup) => await cleanup()));
});

const uploadRetrievalOperations = (context: UOWInstrumentationContext) =>
  context.uow
    .getRetrievalOperations()
    .filter((operation) => operation.type === "find" && operation.table.name === "upload");

const operationHasJoins = (
  operation: ReturnType<typeof uploadRetrievalOperations>[number],
): boolean =>
  ("joins" in operation.options &&
    Array.isArray(operation.options.joins) &&
    operation.options.joins.length > 0) ||
  ("queryTree" in operation.options &&
    operation.options.queryTree !== undefined &&
    operation.options.queryTree.children.length > 0);

const isPreparedBatchRetrieval = (context: UOWInstrumentationContext): boolean => {
  const operations = uploadRetrievalOperations(context);
  return operations.length === 2 && operations.some(operationHasJoins);
};

const isUploadTimeoutRetrieval = (context: UOWInstrumentationContext): boolean => {
  const operations = uploadRetrievalOperations(context);
  return operations.length === 2 && operations.every((operation) => !operationHasJoins(operation));
};

const buildUploadRoutesTest = async (instrumentation?: UOWInstrumentation, maxRoundtrips = 2) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragno-upload-concurrency-"));
  const filesystemStorage = createFilesystemStorageAdapter({ rootDir });
  const deleteObject = vi.fn(filesystemStorage.deleteObject.bind(filesystemStorage));
  const storage = { ...filesystemStorage, deleteObject };
  const build = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite", uowConfig: { instrumentation } })
    .withDbRoundtripGuard({ maxRoundtrips })
    .withFragment(
      "upload",
      instantiate(uploadFragmentDefinition).withConfig({ storage }).withRoutes(uploadRoutes),
    )
    .build();

  await build.test.resetDatabase();
  pendingCleanups.push(async () => {
    await build.test.cleanup();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  return { ...build, deleteObject, provider: storage.name };
};

const prepareProxyFile = async (
  fragment: Awaited<ReturnType<typeof buildUploadRoutesTest>>["fragments"]["upload"]["fragment"],
  provider: string,
  fileKey: string,
  content: string,
) => {
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

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });
  const completed = await fragment.callRoute("PUT", "/uploads/:uploadId/content", {
    pathParams: { uploadId: created.data.uploadId },
    body,
  });
  assert(completed.type === "json");
  assert(completed.data.kind === "prepared");
  return completed.data.write;
};

const replaceFile = async (
  fragment: Awaited<ReturnType<typeof buildUploadRoutesTest>>["fragments"]["upload"]["fragment"],
  provider: string,
  fileKey: string,
  content: string,
) => {
  const body = new FormData();
  body.set("provider", provider);
  body.set("fileKey", fileKey);
  body.set(
    "file",
    new File([Buffer.from(content)], path.basename(fileKey), { type: "text/plain" }),
  );

  const response = await fragment.callRoute("POST", "/files", { body });
  assert(response.type === "json");
};

const waitUntil = async (deadline: Date) => {
  const remainingMilliseconds = deadline.getTime() - Date.now();
  if (remainingMilliseconds > 0) {
    await new Promise((resolve) => setTimeout(resolve, remainingMilliseconds + 25));
  }
};

describe("prepared file commit concurrency", () => {
  it("does not expire or clean up an upload published after timeout retrieval", async () => {
    const batchRetrieved = Promise.withResolvers<void>();
    const releaseBatchMutation = Promise.withResolvers<void>();
    const timeoutRetrieved = Promise.withResolvers<void>();
    const releaseTimeoutMutation = Promise.withResolvers<void>();
    let pauseBatch = false;
    let pauseTimeout = false;
    let batchPaused = false;
    let timeoutPaused = false;

    const instrumentation: UOWInstrumentation = {
      async afterRetrieve(context) {
        if (pauseBatch && !batchPaused && isPreparedBatchRetrieval(context)) {
          batchPaused = true;
          batchRetrieved.resolve();
          await releaseBatchMutation.promise;
          return;
        }
        if (pauseTimeout && !timeoutPaused && isUploadTimeoutRetrieval(context)) {
          timeoutPaused = true;
          timeoutRetrieved.resolve();
          await releaseTimeoutMutation.promise;
        }
      },
    };
    const { fragments, test, deleteObject, provider } =
      await buildUploadRoutesTest(instrumentation);
    const { fragment, db } = fragments.upload;
    const prepared = await prepareProxyFile(
      fragment,
      provider,
      "prepared/timeout-race.txt",
      "published",
    );

    const deadline = new Date(Date.now() + 250);
    const uploadUow = db.createUnitOfWork("set timeout deadline").forSchema(uploadSchema);
    uploadUow.update("upload", prepared.uploadId, (builder) =>
      builder.set({ expiresAt: deadline }),
    );
    assert((await uploadUow.executeMutations()).success);

    const internalFragment = getInternalFragment(test.adapter);
    const hooks = await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [internalFragment.services.hookService.getHooksByNamespace("upload")] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });
    const timeoutHook = hooks.find((hook) => {
      const payload = hook.payload as { uploadId?: string } | null;
      return hook.hookName === "onUploadTimeout" && payload?.uploadId === prepared.uploadId;
    });
    assert(timeoutHook);
    await internalFragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(internalFragment.$internal.deps.schema).update(
            "fragno_hooks",
            timeoutHook.id,
            (builder) => builder.set({ nextRetryAt: deadline }),
          );
        })
        .execute();
    });

    pauseBatch = true;
    const batchCommit = fragment.callRoute("POST", "/files/commit-prepared", {
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
    await batchRetrieved.promise;
    await waitUntil(deadline);

    pauseTimeout = true;
    const timeoutProcessing = drainDurableHooks(fragment);
    await timeoutRetrieved.promise;

    releaseBatchMutation.resolve();
    const committed = await batchCommit;
    assert(committed.type === "json");

    releaseTimeoutMutation.resolve();
    await timeoutProcessing;

    const upload = await fragment.callRoute("GET", "/uploads/:uploadId", {
      pathParams: { uploadId: prepared.uploadId },
    });
    assert(upload.type === "json");
    assert(upload.data.status === "completed");
    expect(deleteObject).not.toHaveBeenCalledWith({ storageKey: prepared.objectKey });

    const content = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: prepared.fileKey },
    });
    assert((await content.text()) === "published");
  });

  it("rejects a mixed replay batch when its completed file is concurrently replaced", async () => {
    const batchRetrieved = Promise.withResolvers<void>();
    const releaseBatchMutation = Promise.withResolvers<void>();
    let pauseBatch = false;
    let batchPaused = false;
    const instrumentation: UOWInstrumentation = {
      async afterRetrieve(context) {
        if (pauseBatch && !batchPaused && isPreparedBatchRetrieval(context)) {
          batchPaused = true;
          batchRetrieved.resolve();
          await releaseBatchMutation.promise;
        }
      },
    };
    const { fragments, provider } = await buildUploadRoutesTest(instrumentation);
    const { fragment } = fragments.upload;
    const replayed = await prepareProxyFile(
      fragment,
      provider,
      "prepared/replayed-race.txt",
      "original",
    );
    const pending = await prepareProxyFile(
      fragment,
      provider,
      "prepared/pending-race.txt",
      "pending",
    );
    const firstCommit = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: {
        entries: [
          {
            kind: "write",
            uploadId: replayed.uploadId,
            precondition: { kind: "absent" },
          },
        ],
      },
    });
    assert(firstCommit.type === "json");

    pauseBatch = true;
    const mixedCommit = fragment.callRoute("POST", "/files/commit-prepared", {
      body: {
        entries: [
          {
            kind: "write",
            uploadId: replayed.uploadId,
            precondition: { kind: "absent" },
          },
          {
            kind: "write",
            uploadId: pending.uploadId,
            precondition: { kind: "absent" },
          },
        ],
      },
    });
    await batchRetrieved.promise;

    await replaceFile(fragment, provider, replayed.fileKey, "replacement");
    releaseBatchMutation.resolve();

    const rejected = await mixedCommit;
    assert(rejected.type === "error");
    assert(rejected.status === 409);
    assert(rejected.error.code === "UPLOAD_INVALID_STATE");

    const replayedContent = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: replayed.fileKey },
    });
    assert((await replayedContent.text()) === "replacement");
    const pendingFile = await fragment.callRoute("GET", "/files/by-key", {
      query: { provider, key: pending.fileKey },
    });
    assert(pendingFile.type === "error");
    assert(pendingFile.error.code === "FILE_NOT_FOUND");
  });

  it("rejects a batch when an expected-absent file is created after retrieval", async () => {
    const batchRetrieved = Promise.withResolvers<void>();
    const releaseBatchMutation = Promise.withResolvers<void>();
    let pauseBatch = false;
    let batchPaused = false;
    const instrumentation: UOWInstrumentation = {
      async afterRetrieve(context) {
        if (pauseBatch && !batchPaused && isPreparedBatchRetrieval(context)) {
          batchPaused = true;
          batchRetrieved.resolve();
          await releaseBatchMutation.promise;
        }
      },
    };
    const { fragments, provider } = await buildUploadRoutesTest(instrumentation);
    const { fragment } = fragments.upload;
    const pending = await prepareProxyFile(
      fragment,
      provider,
      "prepared/absence-guard-write.txt",
      "pending",
    );
    const assertedFileKey = "prepared/absence-guard-assertion.txt";

    pauseBatch = true;
    const batchCommit = fragment.callRoute("POST", "/files/commit-prepared", {
      body: {
        entries: [
          {
            kind: "write",
            uploadId: pending.uploadId,
            precondition: { kind: "absent" },
          },
          {
            kind: "assert",
            provider,
            fileKey: assertedFileKey,
            precondition: { kind: "absent" },
          },
        ],
      },
    });
    await batchRetrieved.promise;

    await replaceFile(fragment, provider, assertedFileKey, "concurrent");
    releaseBatchMutation.resolve();

    const rejected = await batchCommit;
    assert(rejected.type === "error");
    assert(rejected.status === 412);
    assert(rejected.error.code === "FILE_PRECONDITION_FAILED");

    const pendingFile = await fragment.callRoute("GET", "/files/by-key", {
      query: { provider, key: pending.fileKey },
    });
    assert(pendingFile.type === "error");
    assert(pendingFile.error.code === "FILE_NOT_FOUND");
    const assertedContent = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: assertedFileKey },
    });
    assert((await assertedContent.text()) === "concurrent");
  });

  it("rejects all server-side edits when one source changes before atomic publication", async () => {
    const batchRetrieved = Promise.withResolvers<void>();
    const releaseBatchMutation = Promise.withResolvers<void>();
    let pauseBatch = false;
    let batchPaused = false;
    const instrumentation: UOWInstrumentation = {
      async afterRetrieve(context) {
        if (pauseBatch && !batchPaused && isPreparedBatchRetrieval(context)) {
          batchPaused = true;
          batchRetrieved.resolve();
          await releaseBatchMutation.promise;
        }
      },
    };
    const { fragments, provider, test } = await buildUploadRoutesTest(instrumentation, 3);
    const { fragment } = fragments.upload;
    await replaceFile(fragment, provider, "edits/first.txt", "first-v1");
    await replaceFile(fragment, provider, "edits/second.txt", "second-v1");

    pauseBatch = true;
    const editRequest = fragment.callRoute("POST", "/files/apply-edits", {
      body: {
        provider,
        edits: [
          {
            kind: "replace",
            fileKey: "edits/first.txt",
            search: "v1",
            replacement: "from-batch",
          },
          {
            kind: "replace",
            fileKey: "edits/second.txt",
            search: "v1",
            replacement: "from-batch",
          },
        ],
      },
    });
    await batchRetrieved.promise;

    await replaceFile(fragment, provider, "edits/first.txt", "first-concurrent");
    releaseBatchMutation.resolve();

    const rejected = await editRequest;
    assert(rejected.type === "error");
    assert(rejected.status === 412);
    assert(rejected.error.code === "FILE_PRECONDITION_FAILED");

    const firstContent = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: "edits/first.txt" },
    });
    const secondContent = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: "edits/second.txt" },
    });
    assert((await firstContent.text()) === "first-concurrent");
    assert((await secondContent.text()) === "second-v1");

    const internalFragment = getInternalFragment(test.adapter);
    const hooks = await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [internalFragment.services.hookService.getHooksByNamespace("upload")] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });
    const editUploadIds = hooks.flatMap((hook) => {
      const payload = hook.payload as { uploadId?: string; fileKey?: string } | null;
      return hook.hookName === "onUploadTimeout" && payload?.fileKey?.startsWith("edits/")
        ? [payload.uploadId]
        : [];
    });
    expect(editUploadIds).toHaveLength(2);
    for (const uploadId of editUploadIds) {
      assert(uploadId);
      const upload = await fragment.callRoute("GET", "/uploads/:uploadId", {
        pathParams: { uploadId },
      });
      assert(upload.type === "json");
      assert(upload.data.status === "prepared");
    }
  });

  it("maps descriptive prepared-batch failures through their structured error codes", async () => {
    const { fragments, provider } = await buildUploadRoutesTest();
    const { fragment } = fragments.upload;
    const active = await fragment.callRoute("POST", "/uploads", {
      body: {
        provider,
        fileKey: "prepared/active-structured-error.txt",
        filename: "active-structured-error.txt",
        sizeBytes: 1,
        contentType: "text/plain",
        publicationMode: "batch",
      },
    });
    assert(active.type === "json");

    const response = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: {
        entries: [
          {
            kind: "write",
            uploadId: active.data.uploadId,
            precondition: { kind: "absent" },
          },
        ],
      },
    });

    assert(response.type === "error");
    assert(response.status === 409);
    assert(response.error.code === "UPLOAD_INVALID_STATE");
    assert(response.error.message === "Upload invalid state");
  });
});
