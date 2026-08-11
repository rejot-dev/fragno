import { assert, describe, expect, test } from "vitest";

import { createCodemodeStateRuntime } from "@/fragno/runtime-tools/codemode-state-runtime";
import { createTrustedSystemBackofficeToolContext } from "@/fragno/runtime-tools/runtime-tools";

import { MemoryUploadObject, createTestStateBackend } from "./state-backend.test-utils";

const UNIQUE_SEARCH_TEXT = "state-backend-unique-telegram-token";

describe("BackofficeStateBackend", () => {
  test("uses the selected scope's state backend", async () => {
    const rootState = createTestStateBackend();
    const otherState = createTestStateBackend();
    const rootContext = createTrustedSystemBackofficeToolContext({
      runtimes: { state: rootState },
    });
    const otherContext = createTrustedSystemBackofficeToolContext({
      runtimes: { state: otherState },
    }).createScopedContext({ kind: "org", orgId: "other" });
    const context = {
      ...rootContext,
      createScopedContext: (scope: Parameters<typeof rootContext.createScopedContext>[0]) =>
        scope.kind === "org" && scope.orgId === "other"
          ? otherContext
          : rootContext.createScopedContext(scope),
    };

    await context
      .createScopedContext({ kind: "org", orgId: "other" })
      .runtimes.state.writeFile("/workspace/scoped.txt", "other");

    await expect(otherState.readFile("/workspace/scoped.txt")).resolves.toBe("other");
    await expect(rootState.readFile("/workspace/scoped.txt")).rejects.toThrow();
  });

  test("reads the Upload collection and static collection through their mounted paths", async () => {
    const upload = new MemoryUploadObject({
      "automations/telegram.workflow.js": `export const token = '${UNIQUE_SEARCH_TEXT}';`,
    });
    const tools = createStateTools(upload, {
      "fixtures/state-backend-fixture-static.md": UNIQUE_SEARCH_TEXT,
    });

    await tools.writeFile?.execute({
      path: "/workspace/state-backend-fixture-workspace.md",
      content: "workspace",
    });

    upload.requests.length = 0;
    await expect(
      tools.readFile?.execute({
        path: "/workspace/automations/telegram.workflow.js",
      }),
    ).resolves.toContain(UNIQUE_SEARCH_TEXT);
    expect(upload.requests).toEqual(["GET /api/upload/files/by-key/content"]);
    await expect(
      tools.readFile?.execute({
        path: "/static/fixtures/state-backend-fixture-static.md",
      }),
    ).resolves.toBe(UNIQUE_SEARCH_TEXT);
    await expect(tools.readdir?.execute({ path: "/" })).resolves.toEqual(["static", "workspace"]);
    await expect(
      tools.glob?.execute({ pattern: "**/state-backend-fixture-*.md" }),
    ).resolves.toEqual([
      "/static/fixtures/state-backend-fixture-static.md",
      "/workspace/state-backend-fixture-workspace.md",
    ]);
    expect(upload.readyKeys()).toContain("state-backend-fixture-workspace.md");
    expect(upload.readyKeys()).not.toContain("workspace/state-backend-fixture-workspace.md");
  });

  test("reports regex positions correctly after CRLF line endings", async () => {
    const backend = createTestStateBackend({
      staticFiles: {
        "crlf.txt": "first\r\nprefix target suffix\r\nlast",
      },
    });

    await expect(
      backend.searchText("/static/crlf.txt", "target", { regex: true }),
    ).resolves.toMatchObject([
      {
        line: 2,
        column: 8,
        match: "target",
        lineText: "prefix target suffix",
      },
    ]);
  });

  test("uses Upload indexed search and merges static matches", async () => {
    const upload = new MemoryUploadObject({
      "automations/telegram.workflow.js": `export const token = '${UNIQUE_SEARCH_TEXT}';`,
      "outside.txt": "unrelated",
    });
    const tools = createStateTools(upload, {
      "fixtures/state-backend-fixture-static.md": UNIQUE_SEARCH_TEXT,
    });

    const results = (await searchAllFiles(tools, {
      pattern: "**/*",
      query: UNIQUE_SEARCH_TEXT,
      options: { caseSensitive: false },
    })) as Array<{ path: string }>;

    expect(results.map((result) => result.path)).toEqual([
      "/static/fixtures/state-backend-fixture-static.md",
      "/workspace/automations/telegram.workflow.js",
    ]);
    expect(upload.requests).toContain("POST /api/upload/files/search");
    expect(upload.requests).toContain("POST /api/upload/files/search/hydrate");
    expect(upload.requests).not.toContain("GET /api/upload/files/by-key/content");
  });

  test("persists directory markers and rejects non-empty directory removal", async () => {
    const upload = new MemoryUploadObject();
    const tools = createStateTools(upload);

    await tools.mkdir?.execute({ path: "/workspace/generated" });
    await tools.mkdir?.execute({ path: "/workspace/generated/empty" });
    await tools.writeFile?.execute({
      path: "/workspace/generated/file.txt",
      content: "content",
    });

    expect(upload.readyKeys()).toContain("generated/.fragno/dir-marker");
    expect(upload.readyKeys()).toContain("generated/empty/.fragno/dir-marker");
    await expect(
      tools.stat?.execute({ path: "/workspace/generated/empty" }),
    ).resolves.toMatchObject({
      type: "directory",
    });

    await expect(tools.rm?.execute({ path: "/workspace/generated" })).rejects.toThrow("ENOTEMPTY");
    expect(upload.readyKeys()).toContain("generated/file.txt");
    expect(upload.readyKeys()).toContain("generated/empty/.fragno/dir-marker");
  });

  test("rejects static and cross-mount mutations", async () => {
    const upload = new MemoryUploadObject();
    const tools = createStateTools(upload, { "SYSTEM.md": "read only" });

    await expect(
      tools.writeFile?.execute({ path: "/static/new.md", content: "nope" }),
    ).rejects.toThrow("EROFS");
    await expect(tools.rm?.execute({ path: "/static/SYSTEM.md" })).rejects.toThrow("EROFS");
    await expect(
      tools.cp?.execute({
        src: "/static/SYSTEM.md",
        dest: "/workspace/SYSTEM.md",
      }),
    ).rejects.toThrow("EROFS");
    await expect(
      tools.mv?.execute({
        src: "/static/SYSTEM.md",
        dest: "/workspace/SYSTEM.md",
      }),
    ).rejects.toThrow("EROFS");
  });

  test("retrieves Upload trees across metadata pages", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 501 }, (_, index) => [
        `generated/state-backend-page-${index}.txt`,
        String(index),
      ]),
    );
    const upload = new MemoryUploadObject(files);
    const tools = createStateTools(upload);

    const paths = (await tools.glob?.execute({
      pattern: "/workspace/generated/state-backend-page-*.txt",
    })) as string[];

    expect(paths).toHaveLength(501);
    expect(upload.requests.filter((request) => request === "GET /api/upload/files")).toHaveLength(
      2,
    );
  });

  test("supports JSON, hashing, copy, and move within the Upload mount", async () => {
    const upload = new MemoryUploadObject();
    const tools = createStateTools(upload);

    await tools.writeJson?.execute({
      path: "/workspace/config.json",
      value: { enabled: true },
      options: { spaces: 0 },
    });
    await tools.cp?.execute({
      src: "/workspace/config.json",
      dest: "/workspace/copied.json",
    });
    await tools.mv?.execute({
      src: "/workspace/copied.json",
      dest: "/workspace/moved.json",
    });

    await expect(tools.readJson?.execute({ path: "/workspace/moved.json" })).resolves.toEqual({
      enabled: true,
    });
    await expect(
      tools.hashFile?.execute({
        path: "/workspace/config.json",
        algorithm: "sha256",
      }),
    ).resolves.toBe("26b3426b2593763c96d0890b4a77a0bbf66d13fc512b0c6b138a23c290f30a2a");
    upload.requests.length = 0;
    await expect(tools.stat?.execute({ path: "/workspace/config.json" })).resolves.toMatchObject({
      type: "file",
    });
    expect(upload.requests).toEqual(["GET /api/upload/files/by-key"]);

    await expect(tools.exists?.execute({ path: "/workspace/copied.json" })).resolves.toBe(false);
    await expect(tools.stat?.execute({ path: "/workspace/missing.txt" })).resolves.toBeNull();
  });

  describe("reads and metadata", () => {
    test("exists on an existing Upload file only performs an exact metadata lookup", async () => {
      const upload = new MemoryUploadObject({ "notes.txt": "hello" });
      const tools = createStateTools(upload);

      await expect(tools.exists?.execute({ path: "/workspace/notes.txt" })).resolves.toBe(true);
      expect(upload.requests).toEqual(["GET /api/upload/files/by-key"]);
    });

    test("stat on an existing Upload file only performs an exact metadata lookup", async () => {
      const upload = new MemoryUploadObject({ "notes.txt": "hello" });
      const tools = createStateTools(upload);

      await expect(tools.stat?.execute({ path: "/workspace/notes.txt" })).resolves.toMatchObject({
        type: "file",
        size: 5,
      });
      expect(upload.requests).toEqual(["GET /api/upload/files/by-key"]);
    });

    test("missing Upload files fall back to tree enumeration for virtual directories", async () => {
      const upload = new MemoryUploadObject({
        "generated/nested/file.txt": "hello",
      });
      const tools = createStateTools(upload);

      await expect(tools.exists?.execute({ path: "/workspace/generated" })).resolves.toBe(true);
      expect(upload.requests).toEqual(["GET /api/upload/files/by-key", "GET /api/upload/files"]);
    });

    test("virtual Upload directories return directory metadata", async () => {
      const upload = new MemoryUploadObject({
        "generated/nested/file.txt": "hello",
      });
      const tools = createStateTools(upload);

      await expect(
        tools.stat?.execute({ path: "/workspace/generated/nested" }),
      ).resolves.toMatchObject({
        type: "directory",
        size: 0,
      });
    });

    test("reading a missing file throws ENOENT", async () => {
      const tools = createStateTools(new MemoryUploadObject());

      await expect(tools.readFile?.execute({ path: "/workspace/missing.txt" })).rejects.toThrow(
        "ENOENT",
      );
    });

    test("reading the workspace mount throws EISDIR", async () => {
      const upload = new MemoryUploadObject();
      const tools = createStateTools(upload);

      await expect(tools.readFile?.execute({ path: "/workspace" })).rejects.toThrow("EISDIR");
      expect(upload.requests).toEqual([]);
    });

    test("reading the workspace mount with a trailing slash throws EISDIR", async () => {
      const upload = new MemoryUploadObject();
      const tools = createStateTools(upload);

      await expect(tools.readFile?.execute({ path: "/workspace/" })).rejects.toThrow("EISDIR");
      expect(upload.requests).toEqual([]);
    });

    test("reading a virtual Upload directory throws EISDIR", async () => {
      const upload = new MemoryUploadObject({ "generated/file.txt": "hello" });
      const tools = createStateTools(upload);

      await expect(tools.readFile?.execute({ path: "/workspace/generated" })).rejects.toThrow(
        "EISDIR",
      );
    });

    test("reading the static mount throws EISDIR", async () => {
      const tools = createStateTools(new MemoryUploadObject(), {
        "docs/readme.md": "hello",
      });

      await expect(tools.readFile?.execute({ path: "/static" })).rejects.toThrow("EISDIR");
    });

    test("reading a static file does not contact Upload", async () => {
      const upload = new MemoryUploadObject();
      const tools = createStateTools(upload, { "docs/readme.md": "hello" });

      await expect(tools.readFile?.execute({ path: "/static/docs/readme.md" })).resolves.toBe(
        "hello",
      );
      expect(upload.requests).toEqual([]);
    });

    test("readdir classifies and lists an Upload directory from one tree request", async () => {
      const upload = new MemoryUploadObject({
        "generated/first.txt": "first",
        "generated/nested/second.txt": "second",
      });
      const tools = createStateTools(upload);

      await expect(
        tools.readdirWithFileTypes?.execute({ path: "/workspace/generated" }),
      ).resolves.toEqual([
        { name: "first.txt", type: "file" },
        { name: "nested", type: "directory" },
      ]);
      expect(upload.requests).toEqual(["GET /api/upload/files"]);
    });

    test("readdir rejects an Upload file without an exact metadata request", async () => {
      const upload = new MemoryUploadObject({ "notes.txt": "hello" });
      const tools = createStateTools(upload);

      await expect(tools.readdir?.execute({ path: "/workspace/notes.txt" })).rejects.toThrow(
        "ENOTDIR",
      );
      expect(upload.requests).toEqual(["GET /api/upload/files"]);
    });
  });

  describe("tree cache invalidation", () => {
    test("writeFile invalidates a previously populated Upload tree", async () => {
      const upload = new MemoryUploadObject({ "existing.txt": "existing" });
      const tools = createStateTools(upload);

      await tools.glob?.execute({ pattern: "/workspace/**/*.txt" });
      await tools.writeFile?.execute({
        path: "/workspace/created.txt",
        content: "created",
      });

      await expect(tools.glob?.execute({ pattern: "/workspace/**/*.txt" })).resolves.toEqual([
        "/workspace/created.txt",
        "/workspace/existing.txt",
      ]);
      assert(countUploadTreeRequests(upload) === 2);
    });

    test("rm invalidates a previously populated Upload tree", async () => {
      const upload = new MemoryUploadObject({
        "deleted.txt": "deleted",
        "preserved.txt": "preserved",
      });
      const tools = createStateTools(upload);

      await tools.glob?.execute({ pattern: "/workspace/**/*.txt" });
      await tools.rm?.execute({ path: "/workspace/deleted.txt" });

      await expect(tools.exists?.execute({ path: "/workspace/deleted.txt" })).resolves.toBe(false);
      await expect(tools.stat?.execute({ path: "/workspace/deleted.txt" })).resolves.toBeNull();
      await expect(tools.realpath?.execute({ path: "/workspace/deleted.txt" })).rejects.toThrow(
        "ENOENT",
      );
      await expect(tools.glob?.execute({ pattern: "/workspace/**/*.txt" })).resolves.toEqual([
        "/workspace/preserved.txt",
      ]);
      expect(upload.requests).toContain("GET /api/upload/files/by-key");
      assert(countUploadTreeRequests(upload) === 2);
    });

    test("mkdir invalidates a previously populated Upload tree", async () => {
      const upload = new MemoryUploadObject({ "existing.txt": "existing" });
      const tools = createStateTools(upload);

      await tools.glob?.execute({ pattern: "/workspace/**" });
      await tools.mkdir?.execute({ path: "/workspace/created" });

      await expect(tools.stat?.execute({ path: "/workspace/created" })).resolves.toMatchObject({
        type: "directory",
      });
      assert(countUploadTreeRequests(upload) === 2);
    });

    test("cp invalidates a previously populated Upload tree", async () => {
      const upload = new MemoryUploadObject({ "source.txt": "source" });
      const tools = createStateTools(upload);

      await tools.glob?.execute({ pattern: "/workspace/**/*.txt" });
      await tools.cp?.execute({
        src: "/workspace/source.txt",
        dest: "/workspace/copied.txt",
      });

      await expect(tools.glob?.execute({ pattern: "/workspace/**/*.txt" })).resolves.toEqual([
        "/workspace/copied.txt",
        "/workspace/source.txt",
      ]);
      assert(countUploadTreeRequests(upload) === 2);
    });

    test("mv invalidates a previously populated Upload tree", async () => {
      const upload = new MemoryUploadObject({ "source.txt": "source" });
      const tools = createStateTools(upload);

      await tools.glob?.execute({ pattern: "/workspace/**/*.txt" });
      await tools.mv?.execute({
        src: "/workspace/source.txt",
        dest: "/workspace/moved.txt",
      });

      await expect(tools.glob?.execute({ pattern: "/workspace/**/*.txt" })).resolves.toEqual([
        "/workspace/moved.txt",
      ]);
      assert(countUploadTreeRequests(upload) === 2);
    });
  });

  describe("append", () => {
    test("appends text to an existing file", async () => {
      const upload = new MemoryUploadObject({ "notes.txt": "first" });
      const tools = createStateTools(upload);

      await tools.appendFile?.execute({
        path: "/workspace/notes.txt",
        content: " second",
      });

      expect(upload.requests).toEqual([
        "GET /api/upload/files/by-key",
        "GET /api/upload/files/by-key/content",
        "POST /api/upload/files",
      ]);
      await expect(tools.readFile?.execute({ path: "/workspace/notes.txt" })).resolves.toBe(
        "first second",
      );
    });

    test("rejects an append when the observed file revision changes before the write", async () => {
      const upload = new MemoryUploadObject({ "notes.txt": "first" });
      const tools = createStateTools(upload);
      upload.beforeNextWrite(() => {
        upload.replaceFile("notes.txt", "concurrent");
      });

      await expect(
        tools.appendFile?.execute({
          path: "/workspace/notes.txt",
          content: " appended",
        }),
      ).rejects.toThrow("FILE_PRECONDITION_FAILED");
      await expect(tools.readFile?.execute({ path: "/workspace/notes.txt" })).resolves.toBe(
        "concurrent",
      );
    });

    test("appends bytes to an existing file", async () => {
      const tools = createStateTools(
        new MemoryUploadObject({ "data.bin": new Uint8Array([0, 1]) }),
      );

      await tools.appendFile?.execute({
        path: "/workspace/data.bin",
        content: new Uint8Array([254, 255]),
      });

      await expect(tools.readFileBytes?.execute({ path: "/workspace/data.bin" })).resolves.toEqual(
        new Uint8Array([0, 1, 254, 255]),
      );
    });

    test("creates a missing file when appending", async () => {
      const tools = createStateTools(new MemoryUploadObject());

      await tools.appendFile?.execute({
        path: "/workspace/created.txt",
        content: "created",
      });

      await expect(tools.readFile?.execute({ path: "/workspace/created.txt" })).resolves.toBe(
        "created",
      );
    });

    test("throws EISDIR when appending to a directory", async () => {
      const upload = new MemoryUploadObject({
        "generated/file.txt": "preserved",
      });
      const tools = createStateTools(upload);

      await expect(
        tools.appendFile?.execute({
          path: "/workspace/generated",
          content: "invalid",
        }),
      ).rejects.toThrow("EISDIR");
      expect(upload.readyKeys()).toEqual(["generated/file.txt"]);
    });

    test("throws EROFS when appending to a static file", async () => {
      const tools = createStateTools(new MemoryUploadObject(), {
        "notes.txt": "static",
      });

      await expect(
        tools.appendFile?.execute({
          path: "/static/notes.txt",
          content: "invalid",
        }),
      ).rejects.toThrow("EROFS");
      await expect(tools.readFile?.execute({ path: "/static/notes.txt" })).resolves.toBe("static");
    });
  });

  describe("directories", () => {
    test.fails("writeFile rejects an existing virtual directory", async () => {
      const upload = new MemoryUploadObject({
        "generated/file.txt": "preserved",
      });
      const tools = createStateTools(upload);

      await expect(
        tools.writeFile?.execute({
          path: "/workspace/generated",
          content: "invalid",
        }),
      ).rejects.toThrow("EISDIR");
      expect(upload.readyKeys()).toEqual(["generated/file.txt"]);
    });

    test("mkdir throws ENOENT when its parent is missing", async () => {
      const upload = new MemoryUploadObject();
      const tools = createStateTools(upload);

      await expect(tools.mkdir?.execute({ path: "/workspace/missing/nested" })).rejects.toThrow(
        "ENOENT",
      );
      expect(upload.readyKeys()).toEqual([]);
    });

    test("mkdir throws EEXIST when the directory already exists", async () => {
      const upload = new MemoryUploadObject();
      const tools = createStateTools(upload);
      await tools.mkdir?.execute({ path: "/workspace/existing" });

      await expect(tools.mkdir?.execute({ path: "/workspace/existing" })).rejects.toThrow("EEXIST");
    });

    test("mkdir creates a directory beneath an existing parent", async () => {
      const upload = new MemoryUploadObject();
      const tools = createStateTools(upload);
      await tools.mkdir?.execute({ path: "/workspace/parent" });

      await tools.mkdir?.execute({ path: "/workspace/parent/child" });

      expect(upload.readyKeys()).toEqual([
        "parent/.fragno/dir-marker",
        "parent/child/.fragno/dir-marker",
      ]);
    });

    test("mkdir throws ENOTDIR when a parent segment is a file", async () => {
      const upload = new MemoryUploadObject({ "parent.txt": "file" });
      const tools = createStateTools(upload);

      await expect(tools.mkdir?.execute({ path: "/workspace/parent.txt/child" })).rejects.toThrow(
        "ENOTDIR",
      );
      expect(upload.readyKeys()).toEqual(["parent.txt"]);
    });

    test("empty marker-backed directories remain visible", async () => {
      const tools = createStateTools(new MemoryUploadObject());

      await tools.mkdir?.execute({ path: "/workspace/empty" });

      await expect(tools.readdir?.execute({ path: "/workspace" })).resolves.toContain("empty");
      await expect(tools.stat?.execute({ path: "/workspace/empty" })).resolves.toMatchObject({
        type: "directory",
      });
    });

    test("mkdir on the workspace root is a no-op", async () => {
      const upload = new MemoryUploadObject();
      const tools = createStateTools(upload);

      await expect(tools.mkdir?.execute({ path: "/workspace" })).resolves.toBeUndefined();
      expect(upload.readyKeys()).toEqual([]);
      expect(upload.requests).toEqual([]);
    });
  });

  describe("removal", () => {
    test("rm throws ENOENT for a missing path", async () => {
      const tools = createStateTools(new MemoryUploadObject());

      await expect(tools.rm?.execute({ path: "/workspace/missing.txt" })).rejects.toThrow("ENOENT");
    });

    test("rm with force succeeds for a missing path", async () => {
      const tools = createStateTools(new MemoryUploadObject());

      await expect(
        tools.rm?.execute({
          path: "/workspace/missing.txt",
          options: { force: true },
        }),
      ).resolves.toBeUndefined();
    });

    test("rm throws ENOTEMPTY for a non-empty directory", async () => {
      const upload = new MemoryUploadObject({
        "generated/file.txt": "preserved",
      });
      const tools = createStateTools(upload);

      await expect(tools.rm?.execute({ path: "/workspace/generated" })).rejects.toThrow(
        "ENOTEMPTY",
      );
      await expect(
        tools.readFile?.execute({ path: "/workspace/generated/file.txt" }),
      ).resolves.toBe("preserved");
    });

    test("rm throws EPERM for the workspace root", async () => {
      const upload = new MemoryUploadObject({ "preserved.txt": "preserved" });
      const tools = createStateTools(upload);

      await expect(tools.rm?.execute({ path: "/workspace" })).rejects.toThrow("EPERM");
      expect(upload.readyKeys()).toEqual(["preserved.txt"]);
    });

    test("rm deletes an empty marker-backed directory", async () => {
      const upload = new MemoryUploadObject();
      const tools = createStateTools(upload);

      await tools.mkdir?.execute({ path: "/workspace/empty" });
      await tools.rm?.execute({ path: "/workspace/empty" });

      await expect(tools.exists?.execute({ path: "/workspace/empty" })).resolves.toBe(false);
      expect(upload.readyKeys()).toEqual([]);
    });

    test("rm of one file preserves sibling files", async () => {
      const upload = new MemoryUploadObject({
        "generated/deleted.txt": "deleted",
        "generated/preserved.txt": "preserved",
      });
      const tools = createStateTools(upload);

      await tools.rm?.execute({ path: "/workspace/generated/deleted.txt" });

      expect(upload.requests).toEqual(["DELETE /api/upload/files/by-key"]);
      expect(upload.readyKeys()).toEqual(["generated/preserved.txt"]);
      await expect(
        tools.readFile?.execute({ path: "/workspace/generated/preserved.txt" }),
      ).resolves.toBe("preserved");
    });
  });

  describe("copy and move", () => {
    test("file copy preserves binary content", async () => {
      const content = new Uint8Array([0, 255, 1, 128]);
      const tools = createStateTools(new MemoryUploadObject({ "source.bin": content }));

      await tools.cp?.execute({
        src: "/workspace/source.bin",
        dest: "/workspace/copied.bin",
      });

      await expect(
        tools.readFileBytes?.execute({ path: "/workspace/copied.bin" }),
      ).resolves.toEqual(content);
      await expect(
        tools.readFileBytes?.execute({ path: "/workspace/source.bin" }),
      ).resolves.toEqual(content);
    });

    test("copying a directory throws EISDIR and preserves the source", async () => {
      const upload = new MemoryUploadObject({
        "source/nested/file.txt": "preserved",
      });
      const tools = createStateTools(upload);

      await expect(
        tools.cp?.execute({
          src: "/workspace/source",
          dest: "/workspace/copied",
        }),
      ).rejects.toThrow("EISDIR");

      expect(upload.readyKeys()).toEqual(["source/nested/file.txt"]);
      await expect(
        tools.readFile?.execute({ path: "/workspace/source/nested/file.txt" }),
      ).resolves.toBe("preserved");
    });

    test("moving a file removes its source", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "source.txt": "moved" }));

      await tools.mv?.execute({
        src: "/workspace/source.txt",
        dest: "/workspace/moved.txt",
      });

      await expect(tools.exists?.execute({ path: "/workspace/source.txt" })).resolves.toBe(false);
      await expect(tools.readFile?.execute({ path: "/workspace/moved.txt" })).resolves.toBe(
        "moved",
      );
    });

    test("moving a file is a no-op when source and destination are identical", async () => {
      const upload = new MemoryUploadObject({ "source.txt": "preserved" });
      const tools = createStateTools(upload);

      await tools.mv?.execute({
        src: "/workspace/source.txt",
        dest: "/workspace/source.txt",
      });

      await expect(tools.readFile?.execute({ path: "/workspace/source.txt" })).resolves.toBe(
        "preserved",
      );
      expect(upload.readyKeys()).toEqual(["source.txt"]);
    });

    test("moving a file preserves a concurrent source update", async () => {
      const upload = new MemoryUploadObject({ "source.txt": "initial" });
      const tools = createStateTools(upload);
      upload.beforeNextWrite(() => {
        upload.replaceFile("source.txt", "concurrent");
      });

      await expect(
        tools.mv?.execute({
          src: "/workspace/source.txt",
          dest: "/workspace/moved.txt",
        }),
      ).rejects.toThrow("FILE_PRECONDITION_FAILED");

      await expect(tools.readFile?.execute({ path: "/workspace/source.txt" })).resolves.toBe(
        "concurrent",
      );
      await expect(tools.exists?.execute({ path: "/workspace/moved.txt" })).resolves.toBe(false);
    });

    test("moving a file preserves a concurrent destination update", async () => {
      const upload = new MemoryUploadObject({
        "source.txt": "source",
        "moved.txt": "destination",
      });
      const tools = createStateTools(upload);
      upload.beforeNextWrite(() => {
        upload.replaceFile("moved.txt", "concurrent");
      });

      await expect(
        tools.mv?.execute({
          src: "/workspace/source.txt",
          dest: "/workspace/moved.txt",
        }),
      ).rejects.toThrow("FILE_PRECONDITION_FAILED");

      await expect(tools.readFile?.execute({ path: "/workspace/source.txt" })).resolves.toBe(
        "source",
      );
      await expect(tools.readFile?.execute({ path: "/workspace/moved.txt" })).resolves.toBe(
        "concurrent",
      );
    });

    test("moving a directory throws EISDIR and preserves every source descendant", async () => {
      const upload = new MemoryUploadObject({
        "source/first.txt": "first",
        "source/nested/second.txt": "second",
      });
      const tools = createStateTools(upload);

      await expect(
        tools.mv?.execute({
          src: "/workspace/source",
          dest: "/workspace/moved",
        }),
      ).rejects.toThrow("EISDIR");

      expect(upload.readyKeys()).toEqual(["source/first.txt", "source/nested/second.txt"]);
    });

    test("cross-mount copy and move throw EROFS", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "source.txt": "source" }), {
        "static.txt": "static",
      });

      await expect(
        tools.cp?.execute({
          src: "/workspace/source.txt",
          dest: "/static/copied.txt",
        }),
      ).rejects.toThrow("EROFS");
      await expect(
        tools.mv?.execute({
          src: "/static/static.txt",
          dest: "/workspace/moved.txt",
        }),
      ).rejects.toThrow("EROFS");
    });

    test("copy and move throw ENOENT for a missing source", async () => {
      const tools = createStateTools(new MemoryUploadObject());

      await expect(
        tools.cp?.execute({
          src: "/workspace/missing.txt",
          dest: "/workspace/copied.txt",
        }),
      ).rejects.toThrow("ENOENT");
      await expect(
        tools.mv?.execute({
          src: "/workspace/missing.txt",
          dest: "/workspace/moved.txt",
        }),
      ).rejects.toThrow("ENOENT");
    });
  });

  describe("mount boundaries", () => {
    test("routes workspace reads exclusively through Upload", async () => {
      const upload = new MemoryUploadObject({ "shared.txt": "workspace" });
      const tools = createStateTools(upload, { "shared.txt": "static" });

      await expect(tools.readFile?.execute({ path: "/workspace/shared.txt" })).resolves.toBe(
        "workspace",
      );
      expect(upload.requests).toEqual(["GET /api/upload/files/by-key/content"]);
    });

    test("routes static reads exclusively through the static collection", async () => {
      const upload = new MemoryUploadObject({ "shared.txt": "workspace" });
      const tools = createStateTools(upload, { "shared.txt": "static" });

      await expect(tools.readFile?.execute({ path: "/static/shared.txt" })).resolves.toBe("static");
      expect(upload.requests).toEqual([]);
    });

    test("lists both mounts at the state root", async () => {
      const tools = createStateTools(new MemoryUploadObject());

      await expect(tools.readdir?.execute({ path: "/" })).resolves.toEqual(["static", "workspace"]);
    });

    test("rejects writes from workspace into static", async () => {
      const upload = new MemoryUploadObject({ "source.txt": "source" });
      const tools = createStateTools(upload, { "target.txt": "static" });

      await expect(
        tools.writeFile?.execute({
          path: "/static/target.txt",
          content: "changed",
        }),
      ).rejects.toThrow("EROFS");
      await expect(tools.readFile?.execute({ path: "/static/target.txt" })).resolves.toBe("static");
    });

    test("rejects copies from workspace into static", async () => {
      const upload = new MemoryUploadObject({ "source.txt": "source" });
      const tools = createStateTools(upload, { "target.txt": "static" });

      await expect(
        tools.cp?.execute({
          src: "/workspace/source.txt",
          dest: "/static/target.txt",
        }),
      ).rejects.toThrow("EROFS");
    });

    test("rejects copies from static into workspace", async () => {
      const upload = new MemoryUploadObject({ "target.txt": "workspace" });
      const tools = createStateTools(upload, { "source.txt": "static" });

      await expect(
        tools.cp?.execute({
          src: "/static/source.txt",
          dest: "/workspace/target.txt",
        }),
      ).rejects.toThrow("EROFS");
    });

    test("rejects moves from workspace into static", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "source.txt": "source" }), {
        "target.txt": "static",
      });

      await expect(
        tools.mv?.execute({
          src: "/workspace/source.txt",
          dest: "/static/target.txt",
        }),
      ).rejects.toThrow("EROFS");
    });

    test("rejects moves from static into workspace", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "target.txt": "workspace" }), {
        "source.txt": "static",
      });

      await expect(
        tools.mv?.execute({
          src: "/static/source.txt",
          dest: "/workspace/target.txt",
        }),
      ).rejects.toThrow("EROFS");
    });

    test("rejects operations between static paths as read-only mutations", async () => {
      const tools = createStateTools(new MemoryUploadObject(), {
        "source.txt": "source",
        "target.txt": "target",
      });

      await expect(
        tools.cp?.execute({
          src: "/static/source.txt",
          dest: "/static/target.txt",
        }),
      ).rejects.toThrow("EROFS");
      await expect(
        tools.mv?.execute({
          src: "/static/source.txt",
          dest: "/static/target.txt",
        }),
      ).rejects.toThrow("EROFS");
      await expect(tools.rm?.execute({ path: "/static/source.txt" })).rejects.toThrow("EROFS");
    });

    test("does not mutate either mount when a cross-mount operation fails", async () => {
      const upload = new MemoryUploadObject({
        "source.txt": "workspace source",
        "target.txt": "workspace target",
      });
      const tools = createStateTools(upload, {
        "source.txt": "static source",
        "target.txt": "static target",
      });

      await expect(
        tools.mv?.execute({
          src: "/workspace/source.txt",
          dest: "/static/target.txt",
        }),
      ).rejects.toThrow("EROFS");
      await expect(
        tools.cp?.execute({
          src: "/static/source.txt",
          dest: "/workspace/target.txt",
        }),
      ).rejects.toThrow("EROFS");

      await expect(tools.readFile?.execute({ path: "/workspace/source.txt" })).resolves.toBe(
        "workspace source",
      );
      await expect(tools.readFile?.execute({ path: "/workspace/target.txt" })).resolves.toBe(
        "workspace target",
      );
      await expect(tools.readFile?.execute({ path: "/static/source.txt" })).resolves.toBe(
        "static source",
      );
      await expect(tools.readFile?.execute({ path: "/static/target.txt" })).resolves.toBe(
        "static target",
      );
    });

    test("glob can return matches from both mounts without path collisions", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "shared.txt": "workspace" }), {
        "shared.txt": "static",
      });

      await expect(tools.glob?.execute({ pattern: "**/shared.txt" })).resolves.toEqual([
        "/static/shared.txt",
        "/workspace/shared.txt",
      ]);
    });

    test("searchFiles returns each mount separately", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "shared.txt": "needle workspace" }), {
        "shared.txt": "needle static",
      });

      await expect(
        tools.searchFiles?.execute({
          pattern: "**/shared.txt",
          query: "needle",
        }),
      ).resolves.toMatchObject({
        upload: {
          results: [{ path: "/workspace/shared.txt" }],
          hasMore: false,
        },
        static: { results: [{ path: "/static/shared.txt" }], hasMore: false },
      });
    });

    test("searchFiles returns an independent cursor for each mount", async () => {
      const tools = createStateTools(
        new MemoryUploadObject(
          Object.fromEntries(
            Array.from({ length: 2 }, (_, index) => [`upload-${index}.txt`, "needle"]),
          ),
        ),
        { "static.txt": "needle needle" },
      );

      const firstPage = (await tools.searchFiles?.execute({
        pattern: "**/*.txt",
        query: "needle",
        options: {
          upload: { maxMatches: 1 },
          static: { maxMatches: 1 },
        },
      })) as
        | {
            upload: { cursor?: string; hasMore: boolean };
            static: { cursor?: string; hasMore: boolean };
          }
        | undefined;
      assert(firstPage);

      expect(firstPage.upload).toMatchObject({
        hasMore: true,
        cursor: expect.any(String),
      });
      expect(firstPage.static).toMatchObject({
        hasMore: true,
        cursor: expect.any(String),
      });

      await expect(
        tools.searchFiles?.execute({
          pattern: "**/*.txt",
          query: "needle",
          options: {
            upload: { maxMatches: 1, cursor: firstPage.upload.cursor },
            static: { maxMatches: 1, cursor: firstPage.static.cursor },
          },
        }),
      ).resolves.toMatchObject({
        upload: {
          results: [{ path: expect.stringMatching(/^\/workspace\/upload-/) }],
          hasMore: false,
        },
        static: { results: [{ path: "/static/static.txt" }], hasMore: false },
      });
    });

    test("searchFiles treats empty options as the default search across both mounts", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "upload.txt": "needle" }), {
        "static.txt": "needle",
      });

      await expect(
        tools.searchFiles?.execute({
          pattern: "**/*.txt",
          query: "needle",
          options: {},
        }),
      ).resolves.toMatchObject({
        upload: { results: [{ path: "/workspace/upload.txt" }] },
        static: { results: [{ path: "/static/static.txt" }] },
      });
    });

    test("searchFiles can request only one mount", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "upload.txt": "needle" }), {
        "static.txt": "needle",
      });

      await expect(
        tools.searchFiles?.execute({
          pattern: "**/*.txt",
          query: "needle",
          options: { static: {} },
        }),
      ).resolves.toEqual({
        upload: { results: [], hasMore: false },
        static: {
          results: [{ path: "/static/static.txt", matches: [expect.any(Object)] }],
          hasMore: false,
        },
      });
    });

    test.each([
      ["/workspace/**/*.txt", "/workspace/upload.txt", "upload"],
      ["/static/**/*.txt", "/static/static.txt", "static"],
    ] as const)(
      "searchFiles restricts absolute pattern %s to its mount",
      async (pattern, path, mount) => {
        const tools = createStateTools(new MemoryUploadObject({ "upload.txt": "needle" }), {
          "static.txt": "needle",
        });
        const page = (await tools.searchFiles?.execute({
          pattern,
          query: "needle",
        })) as SearchFilesPage;

        expect(page[mount].results).toEqual([{ path, matches: [expect.any(Object)] }]);
        expect(page[mount === "upload" ? "static" : "upload"]).toEqual({
          results: [],
          hasMore: false,
        });
      },
    );

    test("searchFiles can continue one mount after the other is exhausted", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "upload.txt": "needle" }), {
        "static.txt": "needle needle needle",
      });
      const firstPage = (await tools.searchFiles?.execute({
        pattern: "**/*.txt",
        query: "needle",
        options: { upload: { maxMatches: 1 }, static: { maxMatches: 1 } },
      })) as SearchFilesPage;

      expect(firstPage.upload).toMatchObject({ hasMore: false });
      expect(firstPage.static).toMatchObject({
        hasMore: true,
        cursor: expect.any(String),
      });

      const secondPage = (await tools.searchFiles?.execute({
        pattern: "**/*.txt",
        query: "needle",
        options: { static: { maxMatches: 1, cursor: firstPage.static.cursor } },
      })) as SearchFilesPage;
      expect(secondPage.upload).toEqual({ results: [], hasMore: false });
      expect(secondPage.static).toMatchObject({
        hasMore: true,
        cursor: expect.any(String),
      });

      const thirdPage = (await tools.searchFiles?.execute({
        pattern: "**/*.txt",
        query: "needle",
        options: {
          static: { maxMatches: 1, cursor: secondPage.static.cursor },
        },
      })) as SearchFilesPage;
      expect(thirdPage.upload).toEqual({ results: [], hasMore: false });
      expect(thirdPage.static).toMatchObject({ hasMore: false });
      expect(
        [
          ...firstPage.static.results,
          ...secondPage.static.results,
          ...thirdPage.static.results,
        ].flatMap((result) => result.matches),
      ).toHaveLength(3);
    });

    test.each([
      ["an empty query", "", 50],
      ["a zero match limit", "needle", 0],
      ["a negative match limit", "needle", -1],
    ] as const)("searchFiles returns empty pages for %s", async (_label, query, maxMatches) => {
      const tools = createStateTools(new MemoryUploadObject({ "upload.txt": "needle" }), {
        "static.txt": "needle",
      });

      await expect(
        tools.searchFiles?.execute({
          pattern: "**/*.txt",
          query,
          options: { upload: { maxMatches }, static: { maxMatches } },
        }),
      ).resolves.toEqual({
        upload: { results: [], hasMore: false },
        static: { results: [], hasMore: false },
      });
    });

    test("searchFiles rejects invalid cursors from either mount", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "upload.txt": "needle" }), {
        "static.txt": "needle",
      });

      await expect(
        tools.searchFiles?.execute({
          pattern: "**/*.txt",
          query: "needle",
          options: { upload: { cursor: "invalid" } },
        }),
      ).rejects.toThrow("Invalid Upload file search cursor.");
      await expect(
        tools.searchFiles?.execute({
          pattern: "**/*.txt",
          query: "needle",
          options: { static: { cursor: "invalid" } },
        }),
      ).rejects.toThrow("Invalid static file search cursor.");
    });

    test("searchFiles applies maxMatches independently to each mount", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "upload.txt": "needle" }), {
        "static.txt": "needle needle",
      });
      const page = (await tools.searchFiles?.execute({
        pattern: "**/*.txt",
        query: "needle",
        options: { upload: { maxMatches: 1 }, static: { maxMatches: 1 } },
      })) as SearchFilesPage;

      expect(
        [page.upload, page.static]
          .flatMap((mount) => mount.results)
          .flatMap((result) => result.matches),
      ).toHaveLength(2);
    });

    test.each([
      ["query", { pattern: "**/*.txt", query: "different", caseSensitive: false }],
      ["pattern", { pattern: "**/*.md", query: "needle", caseSensitive: false }],
      ["options", { pattern: "**/*.txt", query: "needle", caseSensitive: true }],
    ] as const)(
      "searchFiles rejects a static cursor reused with changed %s",
      async (_label, changed) => {
        const tools = createStateTools(new MemoryUploadObject(), {
          "static.txt": "needle needle",
        });
        const firstPage = (await tools.searchFiles?.execute({
          pattern: "**/*.txt",
          query: "needle",
          options: { static: { maxMatches: 1, caseSensitive: false } },
        })) as SearchFilesPage;
        expect(firstPage.static.cursor).toEqual(expect.any(String));

        await expect(
          tools.searchFiles?.execute({
            pattern: changed.pattern,
            query: changed.query,
            options: {
              static: {
                maxMatches: 1,
                caseSensitive: changed.caseSensitive,
                cursor: firstPage.static.cursor,
              },
            },
          }),
        ).rejects.toThrow("Invalid static file search cursor.");
      },
    );

    test.each([
      ["query", { pattern: "**/*.txt", query: "different", caseSensitive: false }],
      ["pattern", { pattern: "**/*.md", query: "needle", caseSensitive: false }],
      ["options", { pattern: "**/*.txt", query: "needle", caseSensitive: true }],
    ] as const)(
      "searchFiles rejects an Upload cursor reused with changed %s",
      async (_label, changed) => {
        const tools = createStateTools(
          new MemoryUploadObject(
            Object.fromEntries(
              Array.from({ length: 101 }, (_, index) => [`upload-${index}.txt`, "needle"]),
            ),
          ),
        );
        const firstPage = (await tools.searchFiles?.execute({
          pattern: "**/*.txt",
          query: "needle",
          options: { upload: { caseSensitive: false } },
        })) as SearchFilesPage;
        expect(firstPage.upload.cursor).toEqual(expect.any(String));

        await expect(
          tools.searchFiles?.execute({
            pattern: changed.pattern,
            query: changed.query,
            options: {
              upload: {
                caseSensitive: changed.caseSensitive,
                cursor: firstPage.upload.cursor,
              },
            },
          }),
        ).rejects.toThrow("Invalid Upload file search cursor.");
      },
    );

    test("the same relative path can exist independently in both mounts", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "shared.txt": "workspace" }), {
        "shared.txt": "static",
      });

      await tools.writeFile?.execute({
        path: "/workspace/shared.txt",
        content: "changed",
      });

      await expect(tools.readFile?.execute({ path: "/workspace/shared.txt" })).resolves.toBe(
        "changed",
      );
      await expect(tools.readFile?.execute({ path: "/static/shared.txt" })).resolves.toBe("static");
    });
  });

  describe("path resolution", () => {
    test("resolves relative paths beneath the workspace mount", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "notes.txt": "workspace" }));

      await expect(tools.readFile?.execute({ path: "notes.txt" })).resolves.toBe("workspace");
      await expect(tools.realpath?.execute({ path: "notes.txt" })).resolves.toBe(
        "/workspace/notes.txt",
      );
    });

    test("normalizes dot and dot-dot path segments", async () => {
      const tools = createStateTools(
        new MemoryUploadObject({ "projects/notes.txt": "normalized" }),
      );

      await expect(
        tools.readFile?.execute({
          path: "/workspace/./projects/generated/../notes.txt",
        }),
      ).resolves.toBe("normalized");
    });

    test("rejects paths that escape the supported mounts", async () => {
      const tools = createStateTools(new MemoryUploadObject());

      await expect(tools.exists?.execute({ path: "/outside/file.txt" })).rejects.toThrow(
        "outside '/workspace' and '/static'",
      );
    });

    test("does not treat workspace-prefixed sibling names as the workspace mount", async () => {
      const tools = createStateTools(new MemoryUploadObject());

      await expect(tools.exists?.execute({ path: "/workspace-other/file.txt" })).rejects.toThrow(
        "outside '/workspace' and '/static'",
      );
    });

    test("normalizes trailing slashes", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "directory/file.txt": "content" }));

      await expect(tools.realpath?.execute({ path: "/workspace/directory/" })).resolves.toBe(
        "/workspace/directory",
      );
      await expect(tools.readdir?.execute({ path: "/workspace/directory/" })).resolves.toEqual([
        "file.txt",
      ]);
    });

    test("resolvePath supports absolute and relative bases", async () => {
      const tools = createStateTools(new MemoryUploadObject());

      await expect(
        tools.resolvePath?.execute({
          base: "projects/app",
          path: "../config.json",
        }),
      ).resolves.toBe("/workspace/projects/config.json");
      await expect(
        tools.resolvePath?.execute({
          base: "/static/docs",
          path: "../SYSTEM.md",
        }),
      ).resolves.toBe("/static/SYSTEM.md");
    });
  });

  describe("glob", () => {
    test("supports single-star patterns", async () => {
      const tools = createStateTools(
        new MemoryUploadObject({
          "root.txt": "root",
          "nested/file.txt": "nested",
        }),
      );

      await expect(tools.glob?.execute({ pattern: "/workspace/*.txt" })).resolves.toEqual([
        "/workspace/root.txt",
      ]);
    });

    test("supports globstar patterns", async () => {
      const tools = createStateTools(
        new MemoryUploadObject({
          "root.txt": "root",
          "nested/file.txt": "nested",
        }),
      );

      await expect(tools.glob?.execute({ pattern: "/workspace/**/*.txt" })).resolves.toEqual([
        "/workspace/nested/file.txt",
        "/workspace/root.txt",
      ]);
    });

    test("supports question-mark patterns", async () => {
      const tools = createStateTools(
        new MemoryUploadObject({ "file-1.txt": "one", "file-10.txt": "ten" }),
      );

      await expect(tools.glob?.execute({ pattern: "/workspace/file-?.txt" })).resolves.toEqual([
        "/workspace/file-1.txt",
      ]);
    });

    test("supports relative patterns beneath workspace", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "notes/file.txt": "workspace" }), {
        "notes/file.txt": "static",
      });

      await expect(tools.glob?.execute({ pattern: "notes/*.txt" })).resolves.toEqual([
        "/workspace/notes/file.txt",
      ]);
    });

    test("supports workspace-only patterns", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "shared.txt": "workspace" }), {
        "shared.txt": "static",
      });

      await expect(tools.glob?.execute({ pattern: "/workspace/**/*.txt" })).resolves.toEqual([
        "/workspace/shared.txt",
      ]);
    });

    test("supports static-only patterns", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "shared.txt": "workspace" }), {
        "shared.txt": "static",
      });

      await expect(tools.glob?.execute({ pattern: "/static/**/*.txt" })).resolves.toEqual([
        "/static/shared.txt",
      ]);
    });

    test("supports exact mount patterns", async () => {
      const tools = createStateTools(new MemoryUploadObject());

      await expect(tools.glob?.execute({ pattern: "/workspace" })).resolves.toEqual(["/workspace"]);
      await expect(tools.glob?.execute({ pattern: "/static" })).resolves.toEqual(["/static"]);
    });

    test("returns an empty array when no paths match", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "file.txt": "content" }));

      await expect(
        tools.glob?.execute({ pattern: "/**/*.state-backend-no-match" }),
      ).resolves.toEqual([]);
    });

    test("sorts matching paths deterministically", async () => {
      const tools = createStateTools(
        new MemoryUploadObject({ "z.txt": "z", "a.txt": "a", "m.txt": "m" }),
      );

      await expect(tools.glob?.execute({ pattern: "/workspace/*.txt" })).resolves.toEqual([
        "/workspace/a.txt",
        "/workspace/m.txt",
        "/workspace/z.txt",
      ]);
    });

    test("uses prefix-scoped Upload pagination for patterns with a static prefix", async () => {
      const matchingFiles = Object.fromEntries(
        Array.from({ length: 501 }, (_, index) => [
          `projects/generated/file-${index}.txt`,
          String(index),
        ]),
      );
      const upload = new MemoryUploadObject({
        ...matchingFiles,
        "outside/unrelated.txt": "unrelated",
      });
      const tools = createStateTools(upload);

      const paths = (await tools.glob?.execute({
        pattern: "/workspace/projects/**/*.txt",
      })) as string[];

      expect(paths).toHaveLength(501);
      expect(upload.listGlobs).toEqual(["projects/**/*.txt", "projects/**/*.txt"]);
      assert(countUploadTreeRequests(upload) === 2);
    });

    test("workspace-only patterns do not load the static tree", async () => {
      let staticResolutionCount = 0;
      const upload = new MemoryUploadObject({ "file.txt": "workspace" });
      const tools = createCodemodeStateRuntime(
        createTestStateBackend({
          upload,
          staticFiles: { "file.txt": "static" },
          onResolveStaticFiles: () => {
            staticResolutionCount += 1;
          },
        }),
      ).tools;
      assert(tools);

      await expect(tools.glob?.execute({ pattern: "/workspace/**/*.txt" })).resolves.toEqual([
        "/workspace/file.txt",
      ]);
      assert(staticResolutionCount === 0);
    });
  });

  describe("JSON", () => {
    test("writes JSON with configured indentation", async () => {
      const tools = createStateTools(new MemoryUploadObject());

      await tools.writeJson?.execute({
        path: "/workspace/config.json",
        value: { enabled: true, nested: { count: 2 } },
        options: { spaces: 2 },
      });

      await expect(tools.readFile?.execute({ path: "/workspace/config.json" })).resolves.toBe(
        '{\n  "enabled": true,\n  "nested": {\n    "count": 2\n  }\n}',
      );
    });

    test("throws when reading invalid JSON", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "invalid.json": "{invalid" }));

      await expect(tools.readJson?.execute({ path: "/workspace/invalid.json" })).rejects.toThrow();
    });

    test("rejects unserializable top-level JSON values", async () => {
      const tools = createStateTools(new MemoryUploadObject());

      await expect(
        tools.writeJson?.execute({
          path: "/workspace/invalid.json",
          value: undefined,
        }),
      ).rejects.toThrow();
    });

    test("throws EROFS when writing JSON to static paths", async () => {
      const tools = createStateTools(new MemoryUploadObject(), {
        "config.json": "{}",
      });

      await expect(
        tools.writeJson?.execute({
          path: "/static/config.json",
          value: { changed: true },
        }),
      ).rejects.toThrow("EROFS");
      await expect(tools.readFile?.execute({ path: "/static/config.json" })).resolves.toBe("{}");
    });
  });

  describe("hashing", () => {
    test("hashes file content with md5", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "file.txt": "hello" }));

      await expect(
        tools.hashFile?.execute({
          path: "/workspace/file.txt",
          algorithm: "md5",
        }),
      ).resolves.toBe("5d41402abc4b2a76b9719d911017c592");
    });

    test("hashes file content with sha1", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "file.txt": "hello" }));

      await expect(
        tools.hashFile?.execute({
          path: "/workspace/file.txt",
          algorithm: "sha1",
        }),
      ).resolves.toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
    });

    test("hashes file content with sha256", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "file.txt": "hello" }));

      await expect(
        tools.hashFile?.execute({
          path: "/workspace/file.txt",
          algorithm: "sha256",
        }),
      ).resolves.toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    });

    test("hashes binary file content", async () => {
      const tools = createStateTools(
        new MemoryUploadObject({
          "file.bin": new Uint8Array([0, 255, 1, 128]),
        }),
      );

      await expect(
        tools.hashFile?.execute({
          path: "/workspace/file.bin",
          algorithm: "sha256",
        }),
      ).resolves.toBe("edc81f7e4ee358fb91e94bd9bd74079c3dcba36f40f2c8a36e7ae0567afecc8f");
    });

    test("hashing a missing file throws ENOENT", async () => {
      const tools = createStateTools(new MemoryUploadObject());

      await expect(
        tools.hashFile?.execute({
          path: "/workspace/missing.txt",
          algorithm: "sha256",
        }),
      ).rejects.toThrow("ENOENT");
    });

    test("hashing a directory throws EISDIR", async () => {
      const tools = createStateTools(new MemoryUploadObject({ "directory/file.txt": "content" }));

      await expect(
        tools.hashFile?.execute({
          path: "/workspace/directory",
          algorithm: "sha256",
        }),
      ).rejects.toThrow("EISDIR");
    });
  });

  describe("symlinks", () => {
    test("symlink throws ENOTSUP", async () => {
      const backend = createTestStateBackend();

      expect(() => backend.symlink("/workspace/target.txt", "/workspace/link.txt")).toThrow(
        "ENOTSUP",
      );
    });

    test("readlink throws ENOTSUP", async () => {
      const backend = createTestStateBackend();

      expect(() => backend.readlink("/workspace/link.txt")).toThrow("ENOTSUP");
    });
  });
});

type SearchFilesPage = {
  upload: SearchMountPage;
  static: SearchMountPage;
};

type SearchMountPage = {
  results: Array<{ path: string; matches: unknown[] }>;
  cursor?: string;
  hasMore: boolean;
};

const searchAllFiles = async (
  tools: ReturnType<typeof createStateTools>,
  input: {
    pattern: string;
    query: string;
    options?: {
      caseSensitive?: boolean;
      wholeWord?: boolean;
      contextBefore?: number;
      contextAfter?: number;
      maxMatches?: number;
    };
  },
) => {
  const results = [];
  type MountSearchOptions = NonNullable<typeof input.options> & {
    cursor?: string;
  };
  let options: {
    upload?: MountSearchOptions;
    static?: MountSearchOptions;
  } = {
    upload: { ...input.options },
    static: { ...input.options },
  };

  do {
    const page = (await tools.searchFiles?.execute({
      pattern: input.pattern,
      query: input.query,
      options,
    })) as
      | {
          upload: {
            results: Array<{ path: string; matches: unknown[] }>;
            cursor?: string;
            hasMore: boolean;
          };
          static: {
            results: Array<{ path: string; matches: unknown[] }>;
            cursor?: string;
            hasMore: boolean;
          };
        }
      | undefined;
    assert(page);
    results.push(...page.upload.results, ...page.static.results);
    options = {
      ...(page.upload.cursor ? { upload: { ...input.options, cursor: page.upload.cursor } } : {}),
      ...(page.static.cursor ? { static: { ...input.options, cursor: page.static.cursor } } : {}),
    };
  } while (options.upload || options.static);

  return results.sort((left, right) => left.path.localeCompare(right.path));
};

const countUploadTreeRequests = (upload: MemoryUploadObject): number =>
  upload.requests.filter((request) => request === "GET /api/upload/files").length;

const createStateTools = (
  upload: MemoryUploadObject,
  staticFiles: Record<string, string | Uint8Array> = {},
) => {
  const tools = createCodemodeStateRuntime(createTestStateBackend({ upload, staticFiles })).tools;
  assert(tools);
  return tools;
};
