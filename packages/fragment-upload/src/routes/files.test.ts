import { afterAll, beforeEach, describe, expect, it, assert } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { uploadFragmentDefinition } from "../definition";
import { uploadRoutes } from "../index";
import { createFilesystemStorageAdapter } from "../storage/fs";
import { encodeFileKeyPrefix } from "../keys";

describe("upload file routes", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragno-upload-routes-"));
  const storage = createFilesystemStorageAdapter({ rootDir });

  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withDbRoundtripGuard(false)
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
    form.set("keyParts", JSON.stringify(["users", 1, "avatar"]));
    form.set("metadata", JSON.stringify({ purpose: "test" }));
    form.set("tags", JSON.stringify(["profile"]));

    const response = await fragment.callRoute("POST", "/files", { body: form });
    assert(response.type === "json");
    expect(response.status).toBe(200);
    expect(response.data.status).toBe("ready");
    const { fileKey } = response.data;

    const getResponse = await fragment.callRoute("GET", "/files/:fileKey", {
      pathParams: { fileKey },
    });
    assert(getResponse.type === "json");
    expect(getResponse.data.fileKey).toBe(fileKey);
    expect(getResponse.data.filename).toBe("hello.txt");

    const contentResponse = await fragment.callRouteRaw("GET", "/files/:fileKey/content", {
      pathParams: { fileKey },
    });
    expect(contentResponse.status).toBe(200);
    expect(await contentResponse.text()).toBe("hello");
  });

  it("GET /files supports prefix pagination", async () => {
    const createForm = (name: string, keyParts: (string | number)[]) => {
      const form = new FormData();
      const file = new File([Buffer.from(name)], `${name}.txt`, { type: "text/plain" });
      form.set("file", file);
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
        prefix: encodeFileKeyPrefix(["users", 1]),
        pageSize: "1",
      },
    });
    assert(response.type === "json");
    expect(response.data.files).toHaveLength(1);
    expect(response.data.hasNextPage).toBe(true);
    expect(response.data.files[0]?.fileKeyParts[0]).toBe("users");
  });

  it("GET /files/:fileKey/download-url returns unsupported for filesystem adapter", async () => {
    const form = new FormData();
    const file = new File([Buffer.from("hello")], "hello.txt", { type: "text/plain" });
    form.set("file", file);
    form.set("keyParts", JSON.stringify(["users", 3, "avatar"]));

    const response = await fragment.callRoute("POST", "/files", { body: form });
    assert(response.type === "json");
    const { fileKey } = response.data;

    const downloadResponse = await fragment.callRoute("GET", "/files/:fileKey/download-url", {
      pathParams: { fileKey },
    });
    assert(downloadResponse.type === "error");
    expect(downloadResponse.error.code).toBe("SIGNED_URL_UNSUPPORTED");
  });
});
