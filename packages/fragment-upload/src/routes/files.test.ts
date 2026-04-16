import { afterAll, beforeEach, describe, expect, it, assert, vi } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { uploadFragmentDefinition } from "../definition";
import { uploadRoutes } from "../index";
import { createFilesystemStorageAdapter } from "../storage/fs";
import type { StorageAdapter } from "../storage/types";

describe("upload file routes", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragno-upload-routes-"));
  const storage = createFilesystemStorageAdapter({ rootDir });
  const provider = storage.name;

  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
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
    expect(response.status).toBe(200);
    expect(response.data.status).toBe("ready");
    const { fileKey } = response.data;

    const getResponse = await fragment.callRoute("GET", "/files/by-key", {
      query: { provider, key: fileKey },
    });
    assert(getResponse.type === "json");
    expect(getResponse.data.fileKey).toBe(fileKey);
    expect(getResponse.data.filename).toBe("hello.txt");

    const contentResponse = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: fileKey },
    });
    expect(contentResponse.status).toBe(200);
    expect(await contentResponse.text()).toBe("hello");
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
    expect(updateResponse.data.filename).toBe("renamed.txt");

    const downloadResponse = await fragment.callRoute("GET", "/files/by-key/download-url", {
      query: { provider: providerAlias, key: fileKey },
    });
    assert(downloadResponse.type === "error");
    expect(downloadResponse.error.code).toBe("SIGNED_URL_UNSUPPORTED");

    const contentResponse = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider: providerAlias, key: fileKey },
    });
    expect(contentResponse.status).toBe(200);
    expect(await contentResponse.text()).toBe("aliased");

    const deleteResponse = await fragment.callRoute("DELETE", "/files/by-key", {
      query: { provider: providerAlias, key: fileKey },
    });
    assert(deleteResponse.type === "json");
    expect(deleteResponse.data).toEqual({ ok: true });
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
    expect(response.status).toBe(400);
    expect(response.error.code).toBe("INVALID_REQUEST");
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
    expect(contentResponse.status).toBe(410);
    expect(contentResponse.error.code).toBe("FILE_DELETED");
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

    expect(await fs.readFile(storagePath, "utf8")).toBe("hook delete");

    const deleteResponse = await fragment.callRoute("DELETE", "/files/by-key", {
      query: { provider, key: fileKey },
    });
    assert(deleteResponse.type === "json");
    expect(deleteResponse.data).toEqual({ ok: true });

    // The delete route now performs a logical delete only; bytes are removed by the durable hook.
    expect(await fs.readFile(storagePath, "utf8")).toBe("hook delete");

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

    const secondCreate = await fragment.callRoute("POST", "/files", {
      body: secondForm,
    });
    assert(secondCreate.type === "json");
    expect(secondCreate.data.status).toBe("ready");
    expect(secondCreate.data.filename).toBe("second.txt");

    const beforeDrain = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: firstCreate.data.fileKey },
    });
    expect(beforeDrain.status).toBe(200);
    expect(await beforeDrain.text()).toBe("second");

    await drainDurableHooks(fragment);

    const afterDrain = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: firstCreate.data.fileKey },
    });
    expect(afterDrain.status).toBe(200);
    expect(await afterDrain.text()).toBe("second");
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
    expect(response.data.hasNextPage).toBe(true);
    expect(response.data.files[0]?.fileKey.startsWith("users/1/")).toBe(true);
  });

  it("GET /files rejects an empty provider filter", async () => {
    const response = await fragment.callRoute("GET", "/files", {
      query: { provider: "" },
    });

    assert(response.type === "error");
    expect(response.status).toBe(400);
    expect(response.error.code).toBe("INVALID_REQUEST");
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
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(
      (
        (now) => () =>
          now++
      )(Date.UTC(2026, 2, 19, 12, 0, 0, 0)),
    );

    const build = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
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
      dateNowSpy.mockRestore();
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
    expect(downloadResponse.error.code).toBe("SIGNED_URL_UNSUPPORTED");
  });
});
