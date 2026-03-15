import { afterAll, beforeEach, describe, expect, it, assert } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { uploadFragmentDefinition } from "../definition";
import { uploadRoutes } from "../index";
import { createFilesystemStorageAdapter } from "../storage/fs";

describe("upload file routes", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragno-upload-routes-"));
  const storage = createFilesystemStorageAdapter({ rootDir });
  const provider = storage.name;

  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "upload",
      instantiate(uploadFragmentDefinition).withConfig({ storage }).withRoutes(uploadRoutes),
    )
    .build();

  const { fragment } = fragments["upload"];

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
    const file = new File([Buffer.from("hello")], "hello.txt", { type: "text/plain" });
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
    const file = new File([Buffer.from("aliased")], "aliased.txt", { type: "text/plain" });
    form.set("file", file);
    form.set("provider", providerAlias);
    form.set("keyParts", JSON.stringify(["users", 7, "aliased"]));

    const createResponse = await fragment.callRoute("POST", "/files", { body: form });
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
    const file = new File([Buffer.from("hello")], "hello.txt", { type: "text/plain" });
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
    const file = new File([Buffer.from("goodbye")], "goodbye.txt", { type: "text/plain" });
    form.set("file", file);
    form.set("provider", provider);
    form.set("keyParts", JSON.stringify(["users", 9, "goodbye"]));

    const createResponse = await fragment.callRoute("POST", "/files", { body: form });
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
    const file = new File([Buffer.from("hook delete")], "hook-delete.txt", { type: "text/plain" });
    form.set("file", file);
    form.set("provider", provider);
    form.set("keyParts", JSON.stringify(["users", 10, "hook-delete"]));

    const createResponse = await fragment.callRoute("POST", "/files", { body: form });
    assert(createResponse.type === "json");
    const { fileKey } = createResponse.data;
    const storagePath = path.join(
      rootDir,
      ...storage.resolveStorageKey({ provider, fileKey }).split("/"),
    );

    expect(await fs.readFile(storagePath, "utf8")).toBe("hook delete");

    const deleteResponse = await fragment.callRoute("DELETE", "/files/by-key", {
      query: { provider, key: fileKey },
    });
    assert(deleteResponse.type === "json");
    expect(deleteResponse.data).toEqual({ ok: true });

    // The delete route now performs a logical delete only; bytes are removed by the durable hook.
    expect(await fs.readFile(storagePath, "utf8")).toBe("hook delete");

    await drainDurableHooks(fragment);

    await expect(fs.readFile(storagePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("GET /files supports prefix pagination", async () => {
    const createForm = (name: string, keyParts: (string | number)[]) => {
      const form = new FormData();
      const file = new File([Buffer.from(name)], `${name}.txt`, { type: "text/plain" });
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

  it("GET /files/by-key/download-url returns unsupported for filesystem adapter", async () => {
    const form = new FormData();
    const file = new File([Buffer.from("hello")], "hello.txt", { type: "text/plain" });
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
