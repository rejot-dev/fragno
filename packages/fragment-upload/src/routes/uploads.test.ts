import { afterAll, assert, beforeEach, describe, expect, it } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { getInternalFragment } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { uploadFragmentDefinition } from "../definition";
import { uploadSchema } from "../schema";
import { uploadRoutes } from "./index";

const MAX_FILE_BYTES = 64;

describe("upload sessions", async () => {
  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withDbRoundtripGuard(true)
    .withFragment(
      "upload",
      instantiate(uploadFragmentDefinition)
        .withConfig({ maxFileBytes: MAX_FILE_BYTES, textIndex: { enabled: true } })
        .withRoutes(uploadRoutes),
    )
    .build();
  const { fragment } = fragments.upload;

  beforeEach(async () => {
    await testContext.resetDatabase();
  });

  afterAll(async () => {
    await testContext.cleanup();
  });

  async function createUpload(
    fileKey: string,
    content: string,
    options: {
      publicationMode?: "immediate" | "batch";
      replaceActiveUpload?: boolean;
      checksum?: { algo: "sha256"; value: string };
    } = {},
  ) {
    return await fragment.callRoute("POST", "/uploads", {
      body: {
        fileKey,
        filename: fileKey.split("/").at(-1)!,
        sizeBytes: new TextEncoder().encode(content).byteLength,
        contentType: "text/plain",
        ...options,
      },
    });
  }

  async function putContent(uploadId: string, content: string) {
    return await fragment.callRoute("PUT", "/uploads/:uploadId/content", {
      pathParams: { uploadId },
      body: new Blob([content]).stream(),
    });
  }

  async function readFile(fileKey: string) {
    const response = await fragment.callRouteRaw("GET", "/files/by-key/content", {
      query: { key: fileKey },
    });
    return response.status === 200 ? await response.text() : response.status;
  }

  async function listStoredContents() {
    return await fragment.inContext(function () {
      return this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(uploadSchema).find("storage_object", (b) => b.whereIndex("primary")),
        )
        .transformRetrieve(([objects]) =>
          objects.map((object) => new TextDecoder().decode(object.body)).toSorted(),
        )
        .execute();
    });
  }

  /** Makes every scheduled upload timeout due, as if every session had expired. */
  async function expireUploads() {
    const longAgo = new Date(Date.now() - 60_000);
    const internalFragment = getInternalFragment(testContext.adapter);
    const hooks = await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [internalFragment.services.hookService.getHooksByNamespace("upload")] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });
    await fragment.inContext(async function () {
      await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(uploadSchema).find("upload", (b) => b.whereIndex("primary")),
        )
        .mutate(({ forSchema, retrieveResult: [uploads] }) => {
          for (const upload of uploads) {
            forSchema(uploadSchema).update("upload", upload.id, (b) =>
              b.set({ expiresAt: longAgo }),
            );
          }
        })
        .execute();
    });
    await internalFragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          for (const hook of hooks) {
            if (hook.hookName === "onUploadTimeout" && hook.status === "pending") {
              forSchema(internalFragment.$internal.deps.schema).update(
                "fragno_hooks",
                hook.id,
                (b) => b.set({ nextRetryAt: longAgo }),
              );
            }
          }
        })
        .execute();
    });
  }

  it("publishes an upload's content in the transaction that stores it", async () => {
    const created = await createUpload("notes/today.txt", "first draft");
    assert(created.type === "json");
    expect(created.data).toMatchObject({ status: "created", publicationMode: "immediate" });

    const stored = await putContent(created.data.uploadId, "first draft");
    assert(stored.type === "json");
    assert(stored.data.kind === "published");
    expect(stored.data.file).toMatchObject({ fileKey: "notes/today.txt", sizeBytes: 11 });
    assert((await readFile("notes/today.txt")) === "first draft");

    const status = await fragment.callRoute("GET", "/uploads/:uploadId", {
      pathParams: { uploadId: created.data.uploadId },
    });
    assert(status.type === "json");
    expect(status.data).toMatchObject({ status: "completed", bytesUploaded: 11 });

    // A completed session takes no more content.
    const again = await putContent(created.data.uploadId, "first draft");
    assert(again.type === "error");
    assert(again.error.code === "UPLOAD_INVALID_STATE");

    // A second upload replaces the file and the content it published.
    const replacement = await createUpload("notes/today.txt", "final");
    assert(replacement.type === "json");
    assert((await putContent(replacement.data.uploadId, "final")).type === "json");
    assert((await readFile("notes/today.txt")) === "final");
    expect(await listStoredContents()).toEqual(["final"]);

    // The text index reads the published content.
    await drainDurableHooks(fragment);
    const search = await fragment.callRoute("POST", "/files/search", {
      body: { glob: "notes/*", keywords: ["final"] },
    });
    assert(search.type === "json");
    expect(search.data.candidates.map((candidate) => candidate.key)).toEqual(["notes/today.txt"]);
    const hydrated = await fragment.callRoute("POST", "/files/search/hydrate", {
      body: {
        candidateKeys: ["notes/today.txt"],
        keywords: ["final"],
        excludedTerms: [],
        maxBytes: 1024,
      },
    });
    assert(hydrated.type === "json");
    expect(hydrated.data.matches.map((match) => match.lineText)).toEqual(["final"]);
  });

  it("keeps batch content prepared until its commit, and discards it when the batch never commits", async () => {
    const committed = await createUpload("batch/committed.txt", "committed", {
      publicationMode: "batch",
    });
    const aborted = await createUpload("batch/aborted.txt", "aborted", {
      publicationMode: "batch",
    });
    const expired = await createUpload("batch/expired.txt", "expired", {
      publicationMode: "batch",
    });
    assert(committed.type === "json" && aborted.type === "json" && expired.type === "json");
    for (const [upload, content] of [
      [committed, "committed"],
      [aborted, "aborted"],
      [expired, "expired"],
    ] as const) {
      const prepared = await putContent(upload.data.uploadId, content);
      assert(prepared.type === "json");
      assert(prepared.data.kind === "prepared");
    }

    // A retried transfer finds its content already prepared.
    const retried = await putContent(committed.data.uploadId, "committed");
    assert(retried.type === "json");
    assert(retried.data.kind === "prepared");
    const preparedContent = await fragment.callRouteRaw("GET", "/uploads/:uploadId/content", {
      pathParams: { uploadId: committed.data.uploadId },
    });
    assert((await preparedContent.text()) === "committed");
    assert((await readFile("batch/committed.txt")) === 404);

    const commit = await fragment.callRoute("POST", "/files/commit-prepared", {
      body: { entries: [{ kind: "write", uploadId: committed.data.uploadId }] },
    });
    assert(commit.type === "json");
    assert((await readFile("batch/committed.txt")) === "committed");

    const abort = await fragment.callRoute("POST", "/uploads/:uploadId/abort", {
      pathParams: { uploadId: aborted.data.uploadId },
    });
    assert(abort.type === "json");
    expect(await listStoredContents()).toEqual(["committed", "expired"]);

    await expireUploads();
    await drainDurableHooks(fragment);
    expect(await listStoredContents()).toEqual(["committed"]);
    const expiredStatus = await fragment.callRoute("GET", "/uploads/:uploadId", {
      pathParams: { uploadId: expired.data.uploadId },
    });
    assert(expiredStatus.type === "json");
    assert(expiredStatus.data.status === "expired");
    const committedStatus = await fragment.callRoute("GET", "/uploads/:uploadId", {
      pathParams: { uploadId: committed.data.uploadId },
    });
    assert(committedStatus.type === "json");
    assert(committedStatus.data.status === "completed");
  });

  it("lets one unfinished upload per file run, unless a new one replaces it", async () => {
    const checksum = { algo: "sha256" as const, value: "deadbeef" };
    const first = await createUpload("shared/report.txt", "report", { checksum });
    assert(first.type === "json");

    // Retrying the same upload resumes it.
    const resumed = await createUpload("shared/report.txt", "report", { checksum });
    assert(resumed.type === "json");
    expect(resumed.data.uploadId).toBe(first.data.uploadId);

    const conflicting = await createUpload("shared/report.txt", "other report");
    assert(conflicting.type === "error");
    assert(conflicting.error.code === "UPLOAD_ALREADY_ACTIVE");

    const replacing = await createUpload("shared/report.txt", "newest", {
      replaceActiveUpload: true,
    });
    assert(replacing.type === "json");
    const replaced = await putContent(first.data.uploadId, "report");
    assert(replaced.type === "error");
    assert(replaced.error.code === "UPLOAD_INVALID_STATE");
    assert((await putContent(replacing.data.uploadId, "newest")).type === "json");
    assert((await readFile("shared/report.txt")) === "newest");
  });

  it("rejects files larger than the largest file without storing them", async () => {
    const declared = await createUpload("large/declared.txt", "x".repeat(MAX_FILE_BYTES + 1));
    assert(declared.type === "error");
    assert(declared.error.code === "FILE_TOO_LARGE");

    // The session declared a small file, but the request sends more.
    const understated = await createUpload("large/understated.txt", "small");
    assert(understated.type === "json");
    const sent = await putContent(understated.data.uploadId, "x".repeat(MAX_FILE_BYTES + 1));
    assert(sent.type === "error");
    assert(sent.error.code === "FILE_TOO_LARGE");
    expect(await listStoredContents()).toEqual([]);
  });

  it("completes an upload whose content an earlier attempt stored without completing it", async () => {
    const created = await createUpload("legacy/retried.txt", "retried");
    assert(created.type === "json");
    // Uploads stored content in its own transaction before completing, so one could fail between.
    await fragment.inContext(async function () {
      await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(uploadSchema).findFirst("upload", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", created.data.uploadId)),
          ),
        )
        .mutate(({ forSchema, retrieveResult: [upload] }) => {
          forSchema(uploadSchema).create("storage_object", {
            storageKey: upload!.objectKey,
            body: new TextEncoder().encode("partial"),
            contentType: "text/plain",
            sizeBytes: 7n,
          });
        })
        .execute();
    });

    assert((await putContent(created.data.uploadId, "retried")).type === "json");
    assert((await readFile("legacy/retried.txt")) === "retried");
    expect(await listStoredContents()).toEqual(["retried"]);
  });
});
