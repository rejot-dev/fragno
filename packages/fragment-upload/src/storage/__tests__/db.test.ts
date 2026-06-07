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
    .withFragmentFactory(
      "upload",
      uploadFragmentDefinition,
      ({ adapter }) => {
        const storage = createDatabaseStorageAdapter({ databaseAdapter: adapter });
        setStorage(storage);
        return instantiate(uploadFragmentDefinition)
          .withConfig({ storage })
          .withRoutes(uploadRoutes);
      },
      { config: { storage: schemaExtractionStorage } },
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

  it("stores POST /files content in the upload database", async () => {
    const { fragment, db } = build.fragments.upload;
    const form = new FormData();
    form.set("provider", storage.name);
    form.set("fileKey", "reports/q1.txt");
    form.set("file", new File(["database bytes"], "q1.txt", { type: "text/plain" }));

    const uploadResponse = await fragment.callRoute("POST", "/files", { body: form });
    assert(uploadResponse.type === "json");
    expect(uploadResponse.data.status).toBe("ready");

    const contentResponse = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider: storage.name, key: "reports/q1.txt" },
    });
    expect(contentResponse.status).toBe(200);
    expect(contentResponse.headers.get("Content-Type")).toBe("text/plain");
    expect(await contentResponse.text()).toBe("database bytes");

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
    expect(Buffer.from(storedObject!.body).toString("utf8")).toBe("database bytes");
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
