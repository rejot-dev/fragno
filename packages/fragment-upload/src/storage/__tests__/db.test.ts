import { afterAll, beforeAll, beforeEach, describe, expect, it, assert } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { uploadFragmentDefinition } from "../../definition";
import { uploadRoutes } from "../../routes";
import { uploadSchema } from "../../schema";
import { createDatabaseStorageAdapter } from "../db";
import type { StorageAdapter } from "../types";

const schemaExtractionStorage: StorageAdapter = {
  name: "schema-extraction",
  capabilities: {
    directUpload: false,
    multipartUpload: false,
    signedDownload: false,
    proxyUpload: true,
  },
  resolveStorageKey: ({ provider, fileKey }) => `${provider}/${fileKey}`,
  initUpload: async ({ provider, fileKey }) => ({
    strategy: "proxy",
    storageKey: `${provider}/${fileKey}`,
    expiresAt: new Date(Date.now() + 60_000),
  }),
  deleteObject: async () => {},
};

const createDatabaseStorageTestBuild = (setStorage: (storage: StorageAdapter) => void) => {
  return buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withDbRoundtripGuard({ maxRoundtrips: 2 })
    .withFragmentFactory(
      "upload",
      uploadFragmentDefinition,
      ({ adapter }) => {
        const storage = createDatabaseStorageAdapter({ databaseAdapter: adapter });
        setStorage(storage);
        return instantiate(uploadFragmentDefinition)
          .withConfig({ storage, textIndex: { enabled: true } })
          .withRoutes(uploadRoutes);
      },
      { config: { storage: schemaExtractionStorage, textIndex: { enabled: true } } },
    )
    .build();
};

describe("database storage adapter", () => {
  let build!: Awaited<ReturnType<typeof createDatabaseStorageTestBuild>>;
  let storage!: StorageAdapter;

  beforeAll(async () => {
    build = await createDatabaseStorageTestBuild((createdStorage) => {
      storage = createdStorage;
    });
  });

  beforeEach(async () => {
    await build.test.resetDatabase();
  });

  afterAll(async () => {
    await build.test.cleanup();
  });

  const prepareBatchTextUpload = async (input: {
    fileKey: string;
    content: string;
    contentType?: string;
  }) => {
    const { fragment } = build.fragments.upload;
    const contentType = input.contentType ?? "text/plain";
    const created = await fragment.callRoute("POST", "/uploads", {
      body: {
        provider: storage.name,
        fileKey: input.fileKey,
        filename: input.fileKey.split("/").at(-1) ?? "file.txt",
        sizeBytes: Buffer.byteLength(input.content),
        contentType,
        publicationMode: "batch",
      },
    });
    assert(created.type === "json");
    assert(created.data.publicationMode === "batch");

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(input.content));
        controller.close();
      },
    });
    const prepared = await fragment.callRoute("PUT", "/uploads/:uploadId/content", {
      pathParams: { uploadId: created.data.uploadId },
      body: stream,
    });
    assert(prepared.type === "json");
    assert(prepared.data.kind === "prepared");

    return { created: created.data, write: prepared.data.write };
  };

  const searchCandidateKeys = async (input: { glob: string; query: string }) => {
    const response = await build.fragments.upload.fragment.callRoute("POST", "/files/search", {
      body: {
        provider: storage.name,
        glob: input.glob,
        query: input.query,
      },
    });
    assert(response.type === "json");
    return response.data.candidates.map((candidate) => candidate.key);
  };

  it("stores POST /files content in the upload database", async () => {
    const { fragment, db } = build.fragments.upload;
    const form = new FormData();
    form.set("provider", storage.name);
    form.set("fileKey", "reports/q1.txt");
    form.set("file", new File(["database bytes"], "q1.txt", { type: "text/plain" }));

    const uploadResponse = await fragment.callRoute("POST", "/files", { body: form });
    assert(uploadResponse.type === "json");
    assert(uploadResponse.data.status === "ready");

    const contentResponse = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider: storage.name, key: "reports/q1.txt" },
    });
    assert(contentResponse.status === 200);
    assert(contentResponse.headers.get("Content-Type") === "text/plain");
    assert((await contentResponse.text()) === "database bytes");

    const fileUow = db
      .createUnitOfWork("read-file")
      .forSchema(uploadSchema)
      .findFirst("file", (b) =>
        b.whereIndex("idx_file_provider_key", (eb) =>
          eb.and(eb("provider", "=", storage.name), eb("key", "=", "reports/q1.txt")),
        ),
      );
    await fileUow.executeRetrieve();
    const storedFile = (await fileUow.retrievalPhase)[0];
    expect(storedFile?.objectKey).toBeTruthy();

    const objectUow = db
      .createUnitOfWork("read-object")
      .forSchema(uploadSchema)
      .findFirst("storage_object", (b) =>
        b.whereIndex("idx_storage_object_key", (eb) =>
          eb("storageKey", "=", storedFile!.objectKey),
        ),
      );
    await objectUow.executeRetrieve();
    const storedObject = (await objectUow.retrievalPhase)[0];
    assert(Buffer.from(storedObject!.body).toString("utf8") === "database bytes");
  });

  it("indexes uploaded text and searches through the inverted index", async () => {
    const { fragment } = build.fragments.upload;

    const uploadTextFile = async (fileKey: string, content: string, contentType = "text/plain") => {
      const form = new FormData();
      form.set("provider", storage.name);
      form.set("fileKey", fileKey);
      form.set(
        "file",
        new File([content], fileKey.split("/").at(-1) ?? "file.txt", { type: contentType }),
      );
      const response = await fragment.callRoute("POST", "/files", { body: form });
      assert(response.type === "json");
      assert(response.data.status === "ready");
    };

    await uploadTextFile(
      "workspace/src/workflows.ts",
      [
        "import { workflow } from './runtime';",
        "export const createWorkflow = () => workflow();",
        "createWorkflow();",
      ].join("\n"),
      "application/typescript",
    );
    await uploadTextFile(
      "workspace/src/users.ts",
      "export const createUser = () => {};",
      "application/typescript",
    );
    await uploadTextFile(
      "workspace/README.md",
      "createWorkflow is documented here",
      "text/markdown",
    );

    await drainDurableHooks(fragment);

    const searchResponse = await fragment.callRoute("POST", "/files/search", {
      body: {
        provider: storage.name,
        glob: "/workspace/**/*.ts",
        query: "createWorkflow",
        options: {
          caseSensitive: false,
          contextBefore: 1,
          contextAfter: 1,
          maxMatches: 50,
        },
      },
    });

    assert(searchResponse.type === "json");
    expect(searchResponse.data).toMatchInlineSnapshot(`
      {
        "candidateFiles": 1,
        "candidates": [
          {
            "count": 2,
            "key": "workspace/src/workflows.ts",
            "positions": [
              51,
              86,
            ],
          },
        ],
        "hasMoreCandidates": false,
        "provider": "database",
      }
    `);

    const hydrateResponse = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider: storage.name,
        glob: "/workspace/**/*.ts",
        query: "createWorkflow",
        options: {
          caseSensitive: false,
          contextBefore: 1,
          contextAfter: 1,
          maxMatches: 50,
        },
      },
    });

    assert(hydrateResponse.type === "json");
    expect(hydrateResponse.data).toMatchInlineSnapshot(`
      {
        "matches": [
          {
            "column": 14,
            "contextAfter": [
              "createWorkflow();",
            ],
            "contextBefore": [
              "import { workflow } from './runtime';",
            ],
            "endOffset": 65,
            "line": 2,
            "path": "workspace/src/workflows.ts",
            "startOffset": 51,
            "text": "createWorkflow",
          },
          {
            "column": 1,
            "contextAfter": [],
            "contextBefore": [
              "export const createWorkflow = () => workflow();",
            ],
            "endOffset": 100,
            "line": 3,
            "path": "workspace/src/workflows.ts",
            "startOffset": 86,
            "text": "createWorkflow",
          },
        ],
        "scannedFiles": 1,
      }
    `);
  });

  it("indexes a batch upload only after atomic publication", async () => {
    const { fragment } = build.fragments.upload;
    const prepared = await prepareBatchTextUpload({
      fileKey: "batch/search/new-document.txt",
      content: "batchPublicationToken appears only after commit",
    });

    const preparedStatus = await fragment.callRoute("GET", "/uploads/:uploadId", {
      pathParams: { uploadId: prepared.created.uploadId },
    });
    assert(preparedStatus.type === "json");
    expect(preparedStatus.data).toMatchObject({
      publicationMode: "batch",
      status: "prepared",
    });

    await drainDurableHooks(fragment);
    expect(
      await searchCandidateKeys({
        glob: "batch/**/*.txt",
        query: "batchPublicationToken",
      }),
    ).toEqual([]);

    const committed = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: {
        entries: [
          {
            kind: "write",
            uploadId: prepared.write.uploadId,
            precondition: { kind: "absent" },
          },
        ],
      },
    });
    assert(committed.type === "json");

    expect(
      await searchCandidateKeys({
        glob: "batch/**/*.txt",
        query: "batchPublicationToken",
      }),
    ).toEqual([]);

    await drainDurableHooks(fragment);
    expect(
      await searchCandidateKeys({
        glob: "batch/**/*.txt",
        query: "batchPublicationToken",
      }),
    ).toEqual([prepared.write.fileKey]);

    const completedStatus = await fragment.callRoute("GET", "/uploads/:uploadId", {
      pathParams: { uploadId: prepared.created.uploadId },
    });
    assert(completedStatus.type === "json");
    expect(completedStatus.data).toMatchObject({
      publicationMode: "batch",
      status: "completed",
    });
  });

  it("keeps the published search index until a batch replacement commits", async () => {
    const { fragment } = build.fragments.upload;
    const fileKey = "batch/search/replaced-document.txt";
    const form = new FormData();
    form.set("provider", storage.name);
    form.set("fileKey", fileKey);
    form.set(
      "file",
      new File(["stableSearchToken"], "replaced-document.txt", { type: "text/plain" }),
    );
    const initial = await fragment.callRoute("POST", "/files", { body: form });
    assert(initial.type === "json");
    const initialSnapshot = await fragment.callRoute("GET", "/files/by-key", {
      query: { provider: storage.name, key: fileKey },
    });
    assert(initialSnapshot.type === "json");
    await drainDurableHooks(fragment);

    const replacement = await prepareBatchTextUpload({
      fileKey,
      content: "replacementSearchToken",
    });
    await drainDurableHooks(fragment);

    expect(
      await searchCandidateKeys({ glob: "batch/**/*.txt", query: "stableSearchToken" }),
    ).toEqual([fileKey]);
    expect(
      await searchCandidateKeys({ glob: "batch/**/*.txt", query: "replacementSearchToken" }),
    ).toEqual([]);

    const committed = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: {
        entries: [
          {
            kind: "write",
            uploadId: replacement.write.uploadId,
            precondition: { kind: "revision", revision: initialSnapshot.data.revision },
          },
        ],
      },
    });
    assert(committed.type === "json");
    await drainDurableHooks(fragment);

    expect(
      await searchCandidateKeys({ glob: "batch/**/*.txt", query: "stableSearchToken" }),
    ).toEqual([]);
    expect(
      await searchCandidateKeys({ glob: "batch/**/*.txt", query: "replacementSearchToken" }),
    ).toEqual([fileKey]);
  });

  it("limits text search candidate files before downloading file contents", async () => {
    const { fragment } = build.fragments.upload;

    for (const fileKey of ["workspace/src/a.ts", "workspace/src/b.ts", "workspace/src/c.ts"]) {
      const form = new FormData();
      form.set("provider", storage.name);
      form.set("fileKey", fileKey);
      form.set(
        "file",
        new File([`export const createWorkflow = '${fileKey}';\n`], fileKey.split("/").at(-1)!, {
          type: "application/typescript",
        }),
      );
      const uploadResponse = await fragment.callRoute("POST", "/files", { body: form });
      assert(uploadResponse.type === "json");
    }

    await drainDurableHooks(fragment);

    const searchResponse = await fragment.callRoute("POST", "/files/search", {
      body: {
        provider: storage.name,
        glob: "workspace/**/*.ts",
        query: "createWorkflow",
        maxCandidateFiles: 2,
      },
    });

    assert(searchResponse.type === "json");
    expect(searchResponse.data).toMatchInlineSnapshot(`
      {
        "candidateFiles": 2,
        "candidates": [
          {
            "count": 1,
            "key": "workspace/src/a.ts",
            "positions": [
              13,
            ],
          },
          {
            "count": 1,
            "key": "workspace/src/b.ts",
            "positions": [
              13,
            ],
          },
        ],
        "cursor": "eyJ2IjoxLCJpbmRleE5hbWUiOiJpZHhfZmlsZV90ZXh0X3Rlcm1fcHJvdmlkZXJfdGVybV9rZXkiLCJvcmRlckRpcmVjdGlvbiI6ImFzYyIsInBhZ2VTaXplIjoyLCJpbmRleFZhbHVlcyI6eyJwcm92aWRlciI6ImRhdGFiYXNlIiwidGVybSI6ImNyZWF0ZXdvcmtmbG93Iiwia2V5Ijoid29ya3NwYWNlL3NyYy9iLnRzIn19",
        "hasMoreCandidates": true,
        "provider": "database",
      }
    `);

    const cursor = searchResponse.data.cursor;
    assert(typeof cursor === "string");

    const nextSearchResponse = await fragment.callRoute("POST", "/files/search", {
      body: {
        provider: storage.name,
        glob: "workspace/**/*.ts",
        query: "createWorkflow",
        maxCandidateFiles: 2,
        cursor,
      },
    });

    assert(nextSearchResponse.type === "json");
    expect(nextSearchResponse.data).toMatchInlineSnapshot(`
      {
        "candidateFiles": 1,
        "candidates": [
          {
            "count": 1,
            "key": "workspace/src/c.ts",
            "positions": [
              13,
            ],
          },
        ],
        "hasMoreCandidates": false,
        "provider": "database",
      }
    `);

    const hydrateResponse = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider: storage.name,
        glob: "workspace/**/*.ts",
        query: "createWorkflow",
        maxCandidateFiles: 2,
      },
    });

    assert(hydrateResponse.type === "json");
    expect(hydrateResponse.data).toMatchInlineSnapshot(`
      {
        "matches": [
          {
            "column": 14,
            "contextAfter": [],
            "contextBefore": [],
            "endOffset": 27,
            "line": 1,
            "path": "workspace/src/a.ts",
            "startOffset": 13,
            "text": "createWorkflow",
          },
          {
            "column": 14,
            "contextAfter": [],
            "contextBefore": [],
            "endOffset": 27,
            "line": 1,
            "path": "workspace/src/b.ts",
            "startOffset": 13,
            "text": "createWorkflow",
          },
        ],
        "scannedFiles": 2,
      }
    `);

    const nextHydrateResponse = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider: storage.name,
        glob: "workspace/**/*.ts",
        query: "createWorkflow",
        maxCandidateFiles: 2,
        cursor,
      },
    });

    assert(nextHydrateResponse.type === "json");
    expect(nextHydrateResponse.data).toMatchInlineSnapshot(`
      {
        "matches": [
          {
            "column": 14,
            "contextAfter": [],
            "contextBefore": [],
            "endOffset": 27,
            "line": 1,
            "path": "workspace/src/c.ts",
            "startOffset": 13,
            "text": "createWorkflow",
          },
        ],
        "scannedFiles": 1,
      }
    `);
  });

  it("replaces stale text index terms when a file is re-uploaded", async () => {
    const { fragment } = build.fragments.upload;
    const uploadTextFile = async (content: string) => {
      const form = new FormData();
      form.set("provider", storage.name);
      form.set("fileKey", "workspace/src/stale.ts");
      form.set("file", new File([content], "stale.ts", { type: "application/typescript" }));
      const response = await fragment.callRoute("POST", "/files", { body: form });
      assert(response.type === "json");
    };

    await uploadTextFile("export const createWorkflow = () => {};\n");
    await drainDurableHooks(fragment);

    const before = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider: storage.name,
        glob: "workspace/**/*.ts",
        query: "createWorkflow",
      },
    });
    assert(before.type === "json");
    expect(before.data).toMatchInlineSnapshot(`
      {
        "matches": [
          {
            "column": 14,
            "contextAfter": [],
            "contextBefore": [],
            "endOffset": 27,
            "line": 1,
            "path": "workspace/src/stale.ts",
            "startOffset": 13,
            "text": "createWorkflow",
          },
        ],
        "scannedFiles": 1,
      }
    `);

    await uploadTextFile("export const createUser = () => {};\n");
    await drainDurableHooks(fragment);

    const after = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider: storage.name,
        glob: "workspace/**/*.ts",
        query: "createWorkflow",
      },
    });
    assert(after.type === "json");
    expect(after.data).toMatchInlineSnapshot(`
      {
        "matches": [],
        "scannedFiles": 0,
      }
    `);
  });

  it("clears the text index when a file is replaced by non-indexable content", async () => {
    const { fragment } = build.fragments.upload;
    const uploadFile = async (content: string, contentType: string) => {
      const form = new FormData();
      form.set("provider", storage.name);
      form.set("fileKey", "workspace/src/replaced.ts");
      form.set("file", new File([content], "replaced.ts", { type: contentType }));
      const response = await fragment.callRoute("POST", "/files", { body: form });
      assert(response.type === "json");
    };

    await uploadFile("export const createWorkflow = () => {};\n", "application/typescript");
    await drainDurableHooks(fragment);

    await uploadFile("binary-ish replacement", "application/octet-stream");
    await drainDurableHooks(fragment);

    const searchResponse = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider: storage.name,
        glob: "workspace/**/*.ts",
        query: "createWorkflow",
      },
    });

    assert(searchResponse.type === "json");
    expect(searchResponse.data).toEqual({ matches: [], scannedFiles: 0 });
  });

  it("clears the text index idempotently when a file is deleted", async () => {
    const { fragment, db } = build.fragments.upload;
    const form = new FormData();
    form.set("provider", storage.name);
    form.set("fileKey", "workspace/src/deleted.ts");
    form.set(
      "file",
      new File(["export const createWorkflow = () => {};\n"], "deleted.ts", {
        type: "application/typescript",
      }),
    );

    const uploadResponse = await fragment.callRoute("POST", "/files", { body: form });
    assert(uploadResponse.type === "json");
    await drainDurableHooks(fragment);

    const fileUow = db
      .createUnitOfWork("read-file-before-delete")
      .forSchema(uploadSchema)
      .findFirst("file", (b) =>
        b.whereIndex("idx_file_provider_key", (eb) =>
          eb.and(eb("provider", "=", storage.name), eb("key", "=", "workspace/src/deleted.ts")),
        ),
      );
    await fileUow.executeRetrieve();
    const fileBeforeDelete = (await fileUow.retrievalPhase)[0];
    assert(fileBeforeDelete?.objectKey);

    const deleteResponse = await fragment.callRoute("DELETE", "/files/by-key", {
      query: { provider: storage.name, key: "workspace/src/deleted.ts" },
    });
    assert(deleteResponse.type === "json");
    await drainDurableHooks(fragment);

    const searchResponse = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider: storage.name,
        glob: "workspace/**/*.ts",
        query: "createWorkflow",
      },
    });

    assert(searchResponse.type === "json");
    expect(searchResponse.data).toEqual({ matches: [], scannedFiles: 0 });

    await fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(uploadSchema).triggerHook("onFileDeleted", {
            provider: storage.name,
            fileKey: "workspace/src/deleted.ts",
            objectKey: fileBeforeDelete.objectKey,
            sizeBytes: Number(fileBeforeDelete.sizeBytes),
            contentType: fileBeforeDelete.contentType,
          });
        })
        .execute();
    });
    await drainDurableHooks(fragment);

    const repeatedSearchResponse = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider: storage.name,
        glob: "workspace/**/*.ts",
        query: "createWorkflow",
      },
    });

    assert(repeatedSearchResponse.type === "json");
    expect(repeatedSearchResponse.data).toEqual({ matches: [], scannedFiles: 0 });
  });

  it("removes database bytes when the file deletion hook runs", async () => {
    const { fragment, db } = build.fragments.upload;
    const form = new FormData();
    form.set("provider", storage.name);
    form.set("fileKey", "reports/delete-me.txt");
    form.set("file", new File(["delete me"], "delete-me.txt", { type: "text/plain" }));

    const uploadResponse = await fragment.callRoute("POST", "/files", { body: form });
    assert(uploadResponse.type === "json");

    const deleteResponse = await fragment.callRoute("DELETE", "/files/by-key", {
      query: { provider: storage.name, key: "reports/delete-me.txt" },
    });
    assert(deleteResponse.type === "json");

    await drainDurableHooks(fragment);

    const objectUow = db
      .createUnitOfWork("read-object")
      .forSchema(uploadSchema)
      .find("storage_object", (b) =>
        b.whereIndex("idx_storage_object_key", (eb) => eb("storageKey", "starts with", "")),
      );
    await objectUow.executeRetrieve();
    const objects = (await objectUow.retrievalPhase)[0];
    expect(objects).toEqual([]);
  });
});
