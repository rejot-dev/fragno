import { afterAll, assert, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createDatabaseStorageAdapter } from "@fragno-dev/upload/storage/db";

import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";
import {
  createUploadFragment,
  uploadFragmentDefinition,
  type StorageAdapter,
} from "@fragno-dev/upload";

import { createUploadRouteCaller } from "@/fragno/upload-server";

import { createUploadFileCollection } from "./create-upload-file-collection";

const schemaExtractionStorage: StorageAdapter = {
  name: "database",
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
    expiresAt: new Date("2027-01-01T00:01:00.000Z"),
  }),
  deleteObject: async () => {},
};

const buildUploadTest = () =>
  buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withDbRoundtripGuard({ maxRoundtrips: 2 })
    .withFragmentFactory(
      "upload",
      uploadFragmentDefinition,
      ({ adapter }) =>
        createUploadFragment(
          {
            storage: createDatabaseStorageAdapter({
              databaseAdapter: adapter,
              providerName: "database",
            }),
            textIndex: { enabled: true },
          },
          { databaseAdapter: adapter, mountRoute: "/api/upload" },
        ),
      { config: { storage: schemaExtractionStorage } },
    )
    .build();

type UploadTest = Awaited<ReturnType<typeof buildUploadTest>>;

let uploadTest: UploadTest;

beforeAll(async () => {
  uploadTest = await buildUploadTest();
}, 30_000);

beforeEach(async () => {
  await uploadTest.test.resetDatabase();
});

afterAll(async () => {
  await uploadTest.test.cleanup();
});

describe("Upload file collection", () => {
  test("requires a positive integer metadata page limit", () => {
    const { object } = createUploadObject();

    expect(() => createCollection(object, "workspace/", 0)).toThrow(
      "maxPages must be a positive integer",
    );
    expect(() => createCollection(object, "workspace/", 1.5)).toThrow(
      "maxPages must be a positive integer",
    );
  });

  test("builds a prefixed tree from Upload metadata and streams selected content", async () => {
    const { object, requests } = createUploadObject();
    await uploadFile(object, {
      fileKey: "workspace/reports/q1.txt",
      filename: "Quarter one.txt",
      content: "ready",
      metadata: { report: "q1" },
    });
    await uploadFile(object, {
      fileKey: "workspace/empty/.fragno/dir-marker",
      filename: "dir-marker",
      content: "",
      contentType: "application/x.fragno-directory-marker",
      metadata: { __docsDirectoryMarker: true, owner: "docs" },
    });
    await uploadFile(object, {
      fileKey: "outside.txt",
      content: "outside",
    });
    requests.length = 0;

    const collection = createCollection(object, "workspace");
    const tree = await collection.getTree();

    expect(tree.entries).toEqual([
      {
        kind: "directory",
        path: "empty",
        updatedAt: expect.any(String),
        metadata: { __docsDirectoryMarker: true, owner: "docs" },
      },
      {
        kind: "directory",
        path: "reports",
        updatedAt: null,
        metadata: null,
      },
      {
        kind: "file",
        path: "reports/q1.txt",
        displayName: "Quarter one.txt",
        sizeBytes: 5,
        contentType: "text/plain",
        updatedAt: expect.any(String),
        metadata: { report: "q1" },
      },
    ]);
    expect(requests).toHaveLength(1);
    assert(requests[0]?.pathname === "/api/upload/files");

    const content = await collection.getFile("reports/q1.txt");
    assert(content);
    assert(content.contentType === "text/plain");
    assert(content.sizeBytes === 5);
    assert((await new Response(content.body).text()) === "ready");
    expect(requests).toHaveLength(2);
    assert(requests[1]?.pathname === "/api/upload/files/by-key/content");
    assert(requests[1]?.searchParams.get("key") === "workspace/reports/q1.txt");
  });

  test("searches indexed Upload file contents below the collection prefix", async () => {
    const { object, requests } = createUploadObject();
    await uploadFile(object, {
      fileKey: "workspace/reports/q1.txt",
      content: "Revenue grew in the first quarter.",
    });
    await uploadFile(object, {
      fileKey: "outside.txt",
      content: "Revenue outside the workspace.",
    });
    await drainDurableHooks(uploadTest.fragments.upload.fragment);
    requests.length = 0;

    const matches = await createCollection(object, "workspace").search("revenue");

    expect(requests.map((request) => request.pathname)).toEqual([
      "/api/upload/files/search",
      "/api/upload/files/search/hydrate",
    ]);
    expect(matches).toEqual([
      expect.objectContaining({
        path: "reports/q1.txt",
        line: 1,
        column: 1,
        text: "Revenue",
      }),
    ]);
  });

  test("retrieves a complete Upload tree across metadata pages", async () => {
    const { object, requests } = createUploadObject();

    for (let index = 0; index < 501; index += 1) {
      await uploadFile(object, {
        fileKey: `workspace/generated/file-${index}.txt`,
        content: String(index),
      });
    }
    requests.length = 0;

    await expect(createCollection(object, "workspace/").getTree()).rejects.toThrow(
      "exceeded its 1-page retrieval limit",
    );
    expect(requests).toHaveLength(1);

    requests.length = 0;
    const tree = await createCollection(object, "workspace/", 2).getTree();

    assert(tree.entries.length === 502);
    assert(tree.entries[0]?.kind === "directory");
    assert(tree.entries[0].path === "generated");
    expect(tree.entries.map(({ path }) => path)).toContain("generated/file-500.txt");
    expect(requests).toHaveLength(2);
    assert(requests.every(({ pathname }) => pathname === "/api/upload/files"));
    assert(requests[0]?.searchParams.get("cursor") === null);
    assert(requests[1]?.searchParams.has("cursor"));
  }, 30_000);

  test("rejects an Upload file used as another file's parent directory", async () => {
    const { object } = createUploadObject();
    await uploadFile(object, {
      fileKey: "workspace/docs",
      content: "This is a file",
    });
    await uploadFile(object, {
      fileKey: "workspace/docs/README.md",
      content: "# Nested file",
    });

    await expect(createCollection(object, "workspace/").getTree()).rejects.toThrow();
  });

  test("rejects an Upload directory marker that projects onto a file", async () => {
    const { object } = createUploadObject();
    await uploadFile(object, {
      fileKey: "workspace/empty",
      content: "This is a file",
    });
    await uploadFile(object, {
      fileKey: "workspace/empty/.fragno/dir-marker",
      filename: "dir-marker",
      content: "",
      contentType: "application/x.fragno-directory-marker",
      metadata: { __docsDirectoryMarker: true },
    });

    await expect(createCollection(object, "workspace/").getTree()).rejects.toThrow();
  });

  test("normalizes a prefix before matching Upload records", async () => {
    const { object } = createUploadObject();
    await uploadFile(object, {
      fileKey: "workspace",
      content: "This becomes the root",
    });

    await expect(createCollection(object, "workspace").getTree()).resolves.toEqual({ entries: [] });
  });

  test.each(["../outside.txt", "reports/../outside.txt", "/outside.txt", "reports//q1.txt"])(
    "rejects an out-of-collection content path %s before retrieval",
    async (path) => {
      let retrievalCount = 0;
      const collection = createUploadFileCollection({
        routes: createUnexpectedRouteCaller(),
        provider: "database",
        prefix: "workspace",
        getFileResponse: async () => {
          retrievalCount += 1;
          return null;
        },
      });

      await expect(collection.getFile(path)).rejects.toThrow();
      assert(retrievalCount === 0);
    },
  );

  test("preserves an Upload route error at the file collection boundary", async () => {
    const { object } = createUploadObject({
      listFailure: {
        status: 503,
        code: "STORAGE_ERROR",
        message: "Upload unavailable",
      },
    });

    await expect(createCollection(object, "workspace/").getTree()).rejects.toMatchObject({
      message: "Upload unavailable",
      code: "STORAGE_ERROR",
      status: 503,
    });
  });

  test("preserves the HTTP status when a content error is not JSON", async () => {
    const collection = createContentResponseCollection(
      new Response("Bad gateway", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );

    await expect(collection.getFile("reports/q1.txt")).rejects.toMatchObject({
      name: "UploadFileCollectionError",
      message: "Upload file content request failed with HTTP 502.",
      code: "HTTP_502",
      status: 502,
    });
  });

  test("rejects a successful content response without a stream", async () => {
    const collection = createContentResponseCollection(new Response(null, { status: 200 }));

    await expect(collection.getFile("reports/q1.txt")).rejects.toMatchObject({
      name: "UploadFileCollectionError",
      message: "Upload file content response has no body.",
      code: "UPLOAD_FILE_BODY_MISSING",
      status: 200,
    });
  });
});

function createUploadObject(options?: {
  listFailure?: {
    status: number;
    code: string;
    message: string;
  };
}) {
  const requests: URL[] = [];
  const object = {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      requests.push(url);

      if (
        request.method === "GET" &&
        url.pathname === "/api/upload/files" &&
        options?.listFailure
      ) {
        return Response.json(
          {
            code: options.listFailure.code,
            message: options.listFailure.message,
          },
          { status: options.listFailure.status },
        );
      }

      return uploadTest.fragments.upload.fragment.handler(request);
    },
  };

  return { object, requests };
}

function createCollection(
  object: { fetch(request: Request): Promise<Response> },
  prefix: string,
  maxPages?: number,
) {
  return createUploadFileCollection({
    routes: createUploadRouteCaller(object),
    provider: "database",
    prefix,
    ...(maxPages === undefined ? {} : { maxPages }),
    getFileResponse: ({ provider, fileKey }) => {
      const query = new URLSearchParams({ provider, key: fileKey });
      return object.fetch(
        new Request(`https://upload.test/api/upload/files/by-key/content?${query}`),
      );
    },
  });
}

function createContentResponseCollection(response: Response) {
  return createUploadFileCollection({
    routes: createUnexpectedRouteCaller(),
    provider: "database",
    getFileResponse: async () => response,
  });
}

function createUnexpectedRouteCaller() {
  return createUploadRouteCaller({
    fetch: async () => {
      throw new Error("Upload route retrieval is not expected in this test.");
    },
  });
}

async function uploadFile(
  object: { fetch(request: Request): Promise<Response> },
  input: {
    fileKey: string;
    content: string;
    filename?: string;
    contentType?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const form = new FormData();
  form.set("provider", "database");
  form.set("fileKey", input.fileKey);
  form.set(
    "file",
    new File([input.content], input.filename ?? input.fileKey.split("/").at(-1) ?? "file", {
      type: input.contentType ?? "text/plain",
    }),
  );
  if (input.metadata) {
    form.set("metadata", JSON.stringify(input.metadata));
  }

  const response = await object.fetch(
    new Request("https://upload.test/api/upload/files", { method: "POST", body: form }),
  );
  assert(response.ok);
}
