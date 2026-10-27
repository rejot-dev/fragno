import { afterAll, beforeAll, beforeEach, describe, expect, it, assert } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { uploadFragmentDefinition } from "../definition";
import { uploadSchema } from "../schema";
import { MAX_SEARCH_LINE_TEXT_LENGTH } from "../text-index";
import { uploadRoutes } from "./index";

const createSearchTestBuild = () =>
  buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withDbRoundtripGuard(true)
    .withFragment(
      "upload",
      instantiate(uploadFragmentDefinition)
        .withConfig({ maxFileBytes: 1024 * 1024, textIndex: { enabled: true } })
        .withRoutes(uploadRoutes),
    )
    .build();

describe("text index search", () => {
  const provider = "database";
  let build!: Awaited<ReturnType<typeof createSearchTestBuild>>;

  beforeAll(async () => {
    build = await createSearchTestBuild();
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
        provider,
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
        provider,
        glob: input.glob,
        keywords: [input.query],
      },
    });
    assert(response.type === "json");
    return response.data.candidates.map((candidate) => candidate.key);
  };

  it("stores POST /files content in the upload database", async () => {
    const { fragment, db } = build.fragments.upload;
    const form = new FormData();
    form.set("provider", provider);
    form.set("fileKey", "reports/q1.txt");
    form.set("file", new File(["database bytes"], "q1.txt", { type: "text/plain" }));

    const uploadResponse = await fragment.callRoute("POST", "/files", { body: form });
    assert(uploadResponse.type === "json");
    assert(uploadResponse.data.status === "ready");

    const contentResponse = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { provider, key: "reports/q1.txt" },
    });
    assert(contentResponse.status === 200);
    assert(contentResponse.headers.get("Content-Type") === "text/plain");
    assert((await contentResponse.text()) === "database bytes");

    const fileUow = db
      .createUnitOfWork("read-file")
      .forSchema(uploadSchema)
      .findFirst("file", (b) =>
        b.whereIndex("idx_file_provider_key", (eb) =>
          eb.and(eb("provider", "=", provider), eb("key", "=", "reports/q1.txt")),
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
      form.set("provider", provider);
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
        provider,
        glob: "/workspace/**/*.ts",
        keywords: ["createWorkflow"],
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
            "byteLength": 103,
            "count": 2,
            "key": "workspace/src/workflows.ts",
            "positions": [
              51,
              86,
            ],
          },
        ],
        "excludedTerms": [],
        "hasMoreCandidates": false,
        "provider": "database",
      }
    `);

    const hydrateResponse = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider,
        candidateKeys: searchResponse.data.candidates.map((candidate) => candidate.key),
        keywords: ["createWorkflow"],
        excludedTerms: [],
        maxBytes: 1024 * 1024,
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
        "consumedCandidates": 1,
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
            "lineText": "export const createWorkflow = () => workflow();",
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
            "lineText": "createWorkflow();",
            "path": "workspace/src/workflows.ts",
            "startOffset": 86,
            "text": "createWorkflow",
          },
        ],
        "scannedBytes": 103,
        "scannedFiles": 1,
        "skippedCandidates": [],
        "truncated": false,
      }
    `);
  });

  it("falls back to document candidates for literal queries without index terms", async () => {
    const { fragment } = build.fragments.upload;
    const content = "export const transform = (value) => value => value;";
    const form = new FormData();
    form.set("provider", provider);
    form.set("fileKey", "workspace/src/operator.ts");
    form.set("file", new File([content], "operator.ts", { type: "application/typescript" }));
    const uploadResponse = await fragment.callRoute("POST", "/files", { body: form });
    assert(uploadResponse.type === "json");
    await drainDurableHooks(fragment);

    const candidateResponse = await fragment.callRoute("POST", "/files/search", {
      body: {
        provider,
        glob: "/workspace/**/*.ts",
        keywords: ["=>"],
      },
    });

    assert(candidateResponse.type === "json");
    expect(candidateResponse.data.candidates).toEqual([
      {
        key: "workspace/src/operator.ts",
        positions: [],
        count: 0,
        byteLength: new TextEncoder().encode(content).byteLength,
      },
    ]);

    const hydrateResponse = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider,
        candidateKeys: candidateResponse.data.candidates.map((candidate) => candidate.key),
        keywords: ["=>"],
        excludedTerms: [],
        maxBytes: 1024 * 1024,
      },
    });

    assert(hydrateResponse.type === "json");
    expect(hydrateResponse.data.matches).toMatchObject([
      {
        path: "workspace/src/operator.ts",
        line: 1,
        text: "=>",
        lineText: "export const transform = (value) => value => value;",
      },
      {
        path: "workspace/src/operator.ts",
        line: 1,
        text: "=>",
        lineText: "export const transform = (value) => value => value;",
      },
    ]);
    expect(hydrateResponse.data).toMatchObject({
      scannedFiles: 1,
      scannedBytes: Buffer.byteLength(content),
      consumedCandidates: 1,
      truncated: false,
    });
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
    form.set("provider", provider);
    form.set("fileKey", fileKey);
    form.set(
      "file",
      new File(["stableSearchToken"], "replaced-document.txt", { type: "text/plain" }),
    );
    const initial = await fragment.callRoute("POST", "/files", { body: form });
    assert(initial.type === "json");
    const initialSnapshot = await fragment.callRoute("GET", "/files/by-key", {
      query: { provider, key: fileKey },
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

  it("scans the next candidate when an earlier one was replaced before reindexing", async () => {
    const { fragment } = build.fragments.upload;
    const writeFiles = async (files: Record<string, string>) => {
      const response = await fragment.callRoute("POST", "/files/apply-edits", {
        body: {
          provider,
          edits: Object.entries(files).map(([fileKey, content]) => ({
            kind: "write" as const,
            fileKey,
            content,
          })),
        },
      });
      assert(response.type === "json");
    };
    await writeFiles({ "notes/first.txt": "needle", "notes/second.txt": "needle" });
    await drainDurableHooks(fragment);
    // Deletes the content the first file's index document names, until its reindexing runs.
    await writeFiles({ "notes/first.txt": "needle, rewritten" });

    const hydrated = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider,
        candidateKeys: ["notes/first.txt", "notes/second.txt"],
        keywords: ["needle"],
        excludedTerms: [],
        maxBytes: 6,
      },
    });

    assert(hydrated.type === "json");
    expect(hydrated.data).toMatchObject({
      matches: [{ path: "notes/second.txt", text: "needle" }],
      skippedCandidates: [{ key: "notes/first.txt", reason: "not_found" }],
      consumedCandidates: 2,
      truncated: false,
    });
  });

  it("limits text search candidate files before downloading file contents", async () => {
    const { fragment } = build.fragments.upload;

    for (const fileKey of ["workspace/src/a.ts", "workspace/src/b.ts", "workspace/src/c.ts"]) {
      const form = new FormData();
      form.set("provider", provider);
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
        provider,
        glob: "workspace/**/*.ts",
        keywords: ["createWorkflow"],
        maxCandidateFiles: 2,
      },
    });

    assert(searchResponse.type === "json");
    expect(searchResponse.data).toMatchInlineSnapshot(`
      {
        "candidateFiles": 2,
        "candidates": [
          {
            "byteLength": 52,
            "count": 1,
            "key": "workspace/src/a.ts",
            "positions": [
              13,
            ],
          },
          {
            "byteLength": 52,
            "count": 1,
            "key": "workspace/src/b.ts",
            "positions": [
              13,
            ],
          },
        ],
        "cursor": {
          "indexCursor": "eyJ2IjoxLCJpbmRleE5hbWUiOiJpZHhfZmlsZV90ZXh0X3Rlcm1fcHJvdmlkZXJfdGVybV9rZXkiLCJvcmRlckRpcmVjdGlvbiI6ImFzYyIsInBhZ2VTaXplIjoyLCJpbmRleFZhbHVlcyI6eyJwcm92aWRlciI6ImRhdGFiYXNlIiwidGVybSI6ImNyZWF0ZXdvcmtmbG93Iiwia2V5Ijoid29ya3NwYWNlL3NyYy9iLnRzIn19",
          "pass": 0,
        },
        "excludedTerms": [],
        "hasMoreCandidates": true,
        "provider": "database",
      }
    `);

    const cursor = searchResponse.data.cursor;
    assert(cursor);

    const nextSearchResponse = await fragment.callRoute("POST", "/files/search", {
      body: {
        provider,
        glob: "workspace/**/*.ts",
        keywords: ["createWorkflow"],
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
            "byteLength": 52,
            "count": 1,
            "key": "workspace/src/c.ts",
            "positions": [
              13,
            ],
          },
        ],
        "excludedTerms": [],
        "hasMoreCandidates": false,
        "provider": "database",
      }
    `);

    const hydrateResponse = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider,
        candidateKeys: searchResponse.data.candidates.map((candidate) => candidate.key),
        keywords: ["createWorkflow"],
        excludedTerms: [],
        maxBytes: 1024 * 1024,
      },
    });

    assert(hydrateResponse.type === "json");
    expect(hydrateResponse.data).toMatchInlineSnapshot(`
      {
        "consumedCandidates": 2,
        "matches": [
          {
            "column": 14,
            "contextAfter": [],
            "contextBefore": [],
            "endOffset": 27,
            "line": 1,
            "lineText": "export const createWorkflow = 'workspace/src/a.ts';",
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
            "lineText": "export const createWorkflow = 'workspace/src/b.ts';",
            "path": "workspace/src/b.ts",
            "startOffset": 13,
            "text": "createWorkflow",
          },
        ],
        "scannedBytes": 104,
        "scannedFiles": 2,
        "skippedCandidates": [],
        "truncated": false,
      }
    `);

    const nextHydrateResponse = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider,
        candidateKeys: nextSearchResponse.data.candidates.map((candidate) => candidate.key),
        keywords: ["createWorkflow"],
        excludedTerms: [],
        maxBytes: 1024 * 1024,
      },
    });

    assert(nextHydrateResponse.type === "json");
    expect(nextHydrateResponse.data).toMatchInlineSnapshot(`
      {
        "consumedCandidates": 1,
        "matches": [
          {
            "column": 14,
            "contextAfter": [],
            "contextBefore": [],
            "endOffset": 27,
            "line": 1,
            "lineText": "export const createWorkflow = 'workspace/src/c.ts';",
            "path": "workspace/src/c.ts",
            "startOffset": 13,
            "text": "createWorkflow",
          },
        ],
        "scannedBytes": 52,
        "scannedFiles": 1,
        "skippedCandidates": [],
        "truncated": false,
      }
    `);
  });

  it("matches any keyword through one index pass per keyword without repeating files", async () => {
    const { fragment } = build.fragments.upload;
    const files = {
      "workspace/src/a.ts": "export const alpha = beta;\n",
      "workspace/src/b.ts": "export const beta = 1;\n",
      "workspace/src/c.ts": "export const alpha = 2;\n",
    };
    for (const [fileKey, content] of Object.entries(files)) {
      const form = new FormData();
      form.set("provider", provider);
      form.set("fileKey", fileKey);
      form.set(
        "file",
        new File([content], fileKey.split("/").at(-1)!, { type: "application/typescript" }),
      );
      const uploadResponse = await fragment.callRoute("POST", "/files", { body: form });
      assert(uploadResponse.type === "json");
    }
    await drainDurableHooks(fragment);

    const keywords = ["alpha", "beta"];
    const matches: string[] = [];
    let cursor: { pass: number; indexCursor?: string } | undefined;
    do {
      const candidatePage = await fragment.callRoute("POST", "/files/search", {
        body: { provider, glob: "workspace/**/*.ts", keywords, cursor },
      });
      assert(candidatePage.type === "json");
      const hydrated = await fragment.callRoute("POST", "/files/search/hydrate", {
        body: {
          provider,
          candidateKeys: candidatePage.data.candidates.map((candidate) => candidate.key),
          keywords,
          excludedTerms: candidatePage.data.excludedTerms,
          maxBytes: 1024 * 1024,
        },
      });
      assert(hydrated.type === "json");
      matches.push(...hydrated.data.matches.map((match) => `${match.path}:${match.text}`));
      cursor = candidatePage.data.cursor;
    } while (cursor);

    expect(matches).toEqual([
      "workspace/src/a.ts:alpha",
      "workspace/src/a.ts:beta",
      "workspace/src/c.ts:alpha",
      "workspace/src/b.ts:beta",
    ]);
  });

  it("resumes hydration from a character offset within one file", async () => {
    const { fragment } = build.fragments.upload;
    const fileKey = "workspace/src/repeated.txt";
    const content = "needle needle needle needle needle";
    const form = new FormData();
    form.set("provider", provider);
    form.set("fileKey", fileKey);
    form.set("file", new File([content], "repeated.txt", { type: "text/plain" }));
    const uploadResponse = await fragment.callRoute("POST", "/files", { body: form });
    assert(uploadResponse.type === "json");
    await drainDurableHooks(fragment);

    const firstPage = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider,
        candidateKeys: [fileKey],
        keywords: ["needle"],
        excludedTerms: [],
        options: { maxMatches: 2 },
        maxBytes: 1024 * 1024,
      },
    });

    assert(firstPage.type === "json");
    expect(firstPage.data.matches.map((match) => match.startOffset)).toEqual([0, 7]);
    expect(firstPage.data).toMatchObject({
      consumedCandidates: 0,
      nextSearchOffset: 14,
      truncated: { reason: "max_matches" },
    });

    const secondPage = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider,
        candidateKeys: [fileKey],
        keywords: ["needle"],
        excludedTerms: [],
        options: { maxMatches: 2 },
        searchOffset: firstPage.data.nextSearchOffset,
        maxBytes: 1024 * 1024,
      },
    });

    assert(secondPage.type === "json");
    expect(secondPage.data.matches.map((match) => match.startOffset)).toEqual([14, 21]);
    expect(secondPage.data).toMatchObject({
      consumedCandidates: 0,
      nextSearchOffset: 28,
      truncated: { reason: "max_matches" },
    });
  });

  it("continues from a resumed file into the next candidate", async () => {
    const { fragment } = build.fragments.upload;
    const files = [
      { key: "workspace/src/resumed-a.txt", content: "needle needle" },
      { key: "workspace/src/resumed-b.txt", content: "needle" },
    ];

    for (const file of files) {
      const form = new FormData();
      form.set("provider", provider);
      form.set("fileKey", file.key);
      form.set("file", new File([file.content], file.key, { type: "text/plain" }));
      const uploadResponse = await fragment.callRoute("POST", "/files", { body: form });
      assert(uploadResponse.type === "json");
    }
    await drainDurableHooks(fragment);

    const hydrateResponse = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider,
        candidateKeys: files.map((file) => file.key),
        keywords: ["needle"],
        excludedTerms: [],
        options: { maxMatches: 2 },
        searchOffset: 7,
        maxBytes: 1024 * 1024,
      },
    });

    assert(hydrateResponse.type === "json");
    expect(
      hydrateResponse.data.matches.map((match) => ({
        path: match.path,
        startOffset: match.startOffset,
      })),
    ).toEqual([
      { path: files[0]?.key, startOffset: 7 },
      { path: files[1]?.key, startOffset: 0 },
    ]);
    expect(hydrateResponse.data).toMatchObject({
      consumedCandidates: 2,
      truncated: false,
    });
    expect(hydrateResponse.data.nextSearchOffset).toBeUndefined();
  });

  it("applies a continuation offset to the current file revision", async () => {
    const { fragment } = build.fragments.upload;
    const fileKey = "workspace/src/replaced-between-pages.txt";
    const uploadFile = async (content: string) => {
      const form = new FormData();
      form.set("provider", provider);
      form.set("fileKey", fileKey);
      form.set("file", new File([content], "replaced-between-pages.txt", { type: "text/plain" }));
      const response = await fragment.callRoute("POST", "/files", { body: form });
      assert(response.type === "json");
      await drainDurableHooks(fragment);
    };

    await uploadFile("needle needle needle");
    const firstPage = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider,
        candidateKeys: [fileKey],
        keywords: ["needle"],
        excludedTerms: [],
        options: { maxMatches: 1 },
        maxBytes: 1024 * 1024,
      },
    });
    assert(firstPage.type === "json");
    assert(firstPage.data.nextSearchOffset === 7);

    await uploadFile("prefix needle needle");
    const nextPage = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider,
        candidateKeys: [fileKey],
        keywords: ["needle"],
        excludedTerms: [],
        options: { maxMatches: 1 },
        searchOffset: firstPage.data.nextSearchOffset,
        maxBytes: 1024 * 1024,
      },
    });

    assert(nextPage.type === "json");
    expect(nextPage.data.matches.map((match) => match.startOffset)).toEqual([7]);
    assert(nextPage.data.nextSearchOffset === 14);
  });

  it("bounds repeated source lines in hydrated search responses", async () => {
    const { fragment } = build.fragments.upload;
    const fileKey = "workspace/src/large-line.txt";
    const content = `${"a".repeat(10_000)}${" needle".repeat(500)}${"b".repeat(10_000)}`;
    const form = new FormData();
    form.set("provider", provider);
    form.set("fileKey", fileKey);
    form.set("file", new File([content], "large-line.txt", { type: "text/plain" }));
    const uploadResponse = await fragment.callRoute("POST", "/files", { body: form });
    assert(uploadResponse.type === "json");
    await drainDurableHooks(fragment);

    const hydrateResponse = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider,
        candidateKeys: [fileKey],
        keywords: ["needle"],
        excludedTerms: [],
        options: { maxMatches: 100 },
        maxBytes: 1024 * 1024,
      },
    });

    assert(hydrateResponse.type === "json");
    expect(hydrateResponse.data.matches).toHaveLength(100);
    assert(
      hydrateResponse.data.matches.every(
        (match) =>
          match.lineText.length <= MAX_SEARCH_LINE_TEXT_LENGTH && match.lineText.includes("needle"),
      ),
    );
    expect(JSON.stringify(hydrateResponse.data).length).toBeLessThan(1_500_000);
  });

  it("hydrates only explicit candidates within the byte budget", async () => {
    const { fragment } = build.fragments.upload;
    const files = [
      {
        key: "workspace/src/a.ts",
        content: "export const createWorkflow = 'a';\n",
      },
      {
        key: "workspace/src/b.ts",
        content: "export const createWorkflow = 'b';\n",
      },
      {
        key: "workspace/src/c.ts",
        content: "export const createWorkflow = 'c';\n",
      },
    ];

    for (const file of files) {
      const form = new FormData();
      form.set("provider", provider);
      form.set("fileKey", file.key);
      form.set(
        "file",
        new File([file.content], file.key.split("/").at(-1)!, {
          type: "application/typescript",
        }),
      );
      const uploadResponse = await fragment.callRoute("POST", "/files", { body: form });
      assert(uploadResponse.type === "json");
    }

    await drainDurableHooks(fragment);

    const firstPage = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider,
        candidateKeys: [files[0]!.key, files[2]!.key],
        keywords: ["createWorkflow"],
        excludedTerms: [],
        maxBytes: Buffer.byteLength(files[0]!.content),
      },
    });

    assert(firstPage.type === "json");
    expect(firstPage.data.matches.map((match) => match.path)).toEqual([files[0]!.key]);
    expect(firstPage.data).toMatchObject({
      scannedFiles: 1,
      consumedCandidates: 1,
      skippedCandidates: [],
      nextSearchOffset: 0,
      truncated: { reason: "max_bytes" },
    });

    const remainingPage = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider,
        candidateKeys: [files[2]!.key],
        keywords: ["createWorkflow"],
        excludedTerms: [],
        maxBytes: Buffer.byteLength(files[2]!.content),
      },
    });

    assert(remainingPage.type === "json");
    expect(remainingPage.data.matches.map((match) => match.path)).toEqual([files[2]!.key]);
  });

  it("skips a candidate larger than the complete byte budget", async () => {
    const { fragment } = build.fragments.upload;
    const fileKey = "workspace/src/large.ts";
    const content = "export const createWorkflow = 'larger than the budget';\n";
    const form = new FormData();
    form.set("provider", provider);
    form.set("fileKey", fileKey);
    form.set("file", new File([content], "large.ts", { type: "application/typescript" }));
    const uploadResponse = await fragment.callRoute("POST", "/files", { body: form });
    assert(uploadResponse.type === "json");
    await drainDurableHooks(fragment);

    const hydrateResponse = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider,
        candidateKeys: [fileKey],
        keywords: ["createWorkflow"],
        excludedTerms: [],
        maxBytes: Buffer.byteLength(content) - 1,
      },
    });

    assert(hydrateResponse.type === "json");
    expect(hydrateResponse.data).toEqual({
      matches: [],
      scannedFiles: 0,
      scannedBytes: 0,
      consumedCandidates: 1,
      skippedCandidates: [{ key: fileKey, reason: "too_large" }],
      truncated: false,
    });
  });

  it("replaces stale text index terms when a file is re-uploaded", async () => {
    const { fragment } = build.fragments.upload;
    const uploadTextFile = async (content: string) => {
      const form = new FormData();
      form.set("provider", provider);
      form.set("fileKey", "workspace/src/stale.ts");
      form.set("file", new File([content], "stale.ts", { type: "application/typescript" }));
      const response = await fragment.callRoute("POST", "/files", { body: form });
      assert(response.type === "json");
    };

    await uploadTextFile("export const createWorkflow = () => {};\n");
    await drainDurableHooks(fragment);

    const before = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider,
        candidateKeys: ["workspace/src/stale.ts"],
        keywords: ["createWorkflow"],
        excludedTerms: [],
        maxBytes: 1024 * 1024,
      },
    });
    assert(before.type === "json");
    expect(before.data).toMatchInlineSnapshot(`
      {
        "consumedCandidates": 1,
        "matches": [
          {
            "column": 14,
            "contextAfter": [],
            "contextBefore": [],
            "endOffset": 27,
            "line": 1,
            "lineText": "export const createWorkflow = () => {};",
            "path": "workspace/src/stale.ts",
            "startOffset": 13,
            "text": "createWorkflow",
          },
        ],
        "scannedBytes": 40,
        "scannedFiles": 1,
        "skippedCandidates": [],
        "truncated": false,
      }
    `);

    await uploadTextFile("export const createUser = () => {};\n");
    await drainDurableHooks(fragment);

    const after = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider,
        candidateKeys: ["workspace/src/stale.ts"],
        keywords: ["createWorkflow"],
        excludedTerms: [],
        maxBytes: 1024 * 1024,
      },
    });
    assert(after.type === "json");
    expect(after.data).toMatchInlineSnapshot(`
      {
        "consumedCandidates": 1,
        "matches": [],
        "scannedBytes": 36,
        "scannedFiles": 1,
        "skippedCandidates": [],
        "truncated": false,
      }
    `);
  });

  it("clears the text index when a file is replaced by non-indexable content", async () => {
    const { fragment } = build.fragments.upload;
    const uploadFile = async (content: string, contentType: string) => {
      const form = new FormData();
      form.set("provider", provider);
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
        provider,
        candidateKeys: ["workspace/src/replaced.ts"],
        keywords: ["createWorkflow"],
        excludedTerms: [],
        maxBytes: 1024 * 1024,
      },
    });

    assert(searchResponse.type === "json");
    expect(searchResponse.data).toEqual({
      matches: [],
      scannedFiles: 0,
      scannedBytes: 0,
      consumedCandidates: 1,
      skippedCandidates: [{ key: "workspace/src/replaced.ts", reason: "not_found" }],
      truncated: false,
    });
  });

  it("clears the text index idempotently when a file is deleted", async () => {
    const { fragment, db } = build.fragments.upload;
    const form = new FormData();
    form.set("provider", provider);
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
          eb.and(eb("provider", "=", provider), eb("key", "=", "workspace/src/deleted.ts")),
        ),
      );
    await fileUow.executeRetrieve();
    const fileBeforeDelete = (await fileUow.retrievalPhase)[0];
    assert(fileBeforeDelete?.objectKey);

    const deleteResponse = await fragment.callRoute("DELETE", "/files/by-key", {
      query: { provider, key: "workspace/src/deleted.ts" },
    });
    assert(deleteResponse.type === "json");
    await drainDurableHooks(fragment);

    const searchResponse = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        provider,
        candidateKeys: ["workspace/src/deleted.ts"],
        keywords: ["createWorkflow"],
        excludedTerms: [],
        maxBytes: 1024 * 1024,
      },
    });

    assert(searchResponse.type === "json");
    expect(searchResponse.data).toEqual({
      matches: [],
      scannedFiles: 0,
      scannedBytes: 0,
      consumedCandidates: 1,
      skippedCandidates: [{ key: "workspace/src/deleted.ts", reason: "not_found" }],
      truncated: false,
    });

    await fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(uploadSchema).triggerHook("onFileDeleted", {
            provider,
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
        provider,
        candidateKeys: ["workspace/src/deleted.ts"],
        keywords: ["createWorkflow"],
        excludedTerms: [],
        maxBytes: 1024 * 1024,
      },
    });

    assert(repeatedSearchResponse.type === "json");
    expect(repeatedSearchResponse.data).toEqual({
      matches: [],
      scannedFiles: 0,
      scannedBytes: 0,
      consumedCandidates: 1,
      skippedCandidates: [{ key: "workspace/src/deleted.ts", reason: "not_found" }],
      truncated: false,
    });
  });
});
