import { afterAll, assert, beforeEach, describe, expect, it } from "vitest";

import path from "node:path";

import { instantiate } from "@fragno-dev/core";
import { getInternalFragment } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { uploadFragmentDefinition } from "../definition";
import { uploadSchema } from "../schema";
import { uploadRoutes } from "./index";

describe("POST /files/apply-edits", async () => {
  const provider = "workspace";
  const testSetup = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withDbRoundtripGuard(true)
    .withFragment(
      "upload",
      instantiate(uploadFragmentDefinition)
        .withConfig({ maxFileBytes: 1024 * 1024 })
        .withRoutes(uploadRoutes),
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
  });

  afterAll(async () => {
    await testSetup.test.cleanup();
  });

  it("applies sequential operations to one file with one logical revision", async () => {
    await createFile("sequential/file.txt", "one two");
    const before = await getFile("sequential/file.txt");

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
    assert((await readFile("sequential/file.txt")) === "first second");
  });

  it("does not revise a file when a replacement is a no-op", async () => {
    await createFile("unchanged/file.txt", "unchanged");
    const before = await getFile("unchanged/file.txt");

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

  it("replaces the file's content and queues publication and indexing hooks", async () => {
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
    expect(newHookNames.toSorted()).toEqual(["onFileReady", "onFileTextIndexRequested"]);
    const storedObjects = await fragment.inContext(function () {
      return this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(uploadSchema).find("storage_object", (b) => b.whereIndex("primary")),
        )
        .transformRetrieve(([objects]) => objects)
        .execute();
    });
    expect(storedObjects.map((object) => new TextDecoder().decode(object.body))).toEqual(["after"]);
  });

  it("rejects replacement of a missing file", async () => {
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
  });

  it("rejects an edit that grows a file past the largest file size", async () => {
    const content = `${"x".repeat(1024 * 1024 - 6)}before`;
    await createFile("limit/near-max.txt", content);

    const response = await fragment.callRoute("POST", "/files/apply-edits", {
      body: {
        provider,
        edits: [
          {
            kind: "replace",
            fileKey: "limit/near-max.txt",
            search: "before",
            replacement: "after, longer",
          },
        ],
      },
    });

    assert(response.type === "error");
    assert(response.error.code === "FILE_TOO_LARGE");
    expect(await getFile("limit/near-max.txt")).toMatchObject({
      revision: 0,
      sizeBytes: content.length,
    });
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
  });
});
