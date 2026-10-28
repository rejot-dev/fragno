import { afterAll, assert, beforeEach, describe, expect, test } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { getInternalFragment } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { blobsFragmentDefinition, type StoredBlob } from "./definition";
import { blobsRoutesFactory } from "./routes";
import { createS3BlobStorage, type S3Signer } from "./storage";

const BUCKET_URL = "https://storage.example/blobs-bucket/";

/**
 * An S3 bucket that accepts requests signed by `signer`: the server's own signed requests, and
 * presigned ones from callers holding a URL.
 */
function createFakeBucket() {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const etags = new Map<string, string>();

  const signer: S3Signer = {
    sign: async ({ url }) => ({ url, headers: { authorization: "signed" } }),
    presign: async ({ url, headers, expiresInSeconds }) => ({
      url: `${url}?X-Amz-Expires=${expiresInSeconds}`,
      headers,
    }),
  };

  // Like Workers' global `fetch`, it refuses to be called as a method of another object.
  const fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
    }
    const request = new Request(input, init);
    const url = new URL(request.url);
    const objectKey = decodeURIComponent(url.pathname.slice(new URL(BUCKET_URL).pathname.length));
    if (!url.searchParams.has("X-Amz-Expires") && !request.headers.has("authorization")) {
      return new Response("AccessDenied", { status: 403 });
    }
    const object = objects.get(objectKey);
    switch (request.method) {
      case "PUT": {
        const bytes = new Uint8Array(await request.arrayBuffer());
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        objects.set(objectKey, bytes);
        etags.set(objectKey, `"${Buffer.from(digest).toString("hex").slice(0, 32)}"`);
        return new Response(null, { status: 200, headers: { etag: etags.get(objectKey)! } });
      }
      case "HEAD":
      case "GET":
        if (!object) {
          return new Response(null, { status: 404 });
        }
        return new Response(request.method === "GET" ? object : null, {
          headers: { "content-length": String(object.byteLength), etag: etags.get(objectKey)! },
        });
      case "DELETE":
        objects.delete(objectKey);
        return new Response(null, { status: 204 });
      default:
        return new Response(null, { status: 405 });
    }
  };

  return { objects, signer, fetch };
}

describe("blobs fragment", async () => {
  const bucket = createFakeBucket();
  // Requests from outside Backoffice, such as a browser following a presigned URL.
  const storageFetch = bucket.fetch;
  const events: Array<{ event: "stored" | "deleted"; blob: StoredBlob }> = [];
  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withDbRoundtripGuard({ maxRoundtrips: 2 })
    .withFragment(
      "blobs",
      instantiate(blobsFragmentDefinition)
        .withConfig({
          storage: createS3BlobStorage({
            endpoint: "https://storage.example",
            bucket: "blobs-bucket",
            pathStyle: true,
            signer: bucket.signer,
            fetch: bucket.fetch,
          }),
          storageKeyPrefix: "scope-1/",
          onBlobStored: async (blob) => {
            events.push({ event: "stored", blob });
          },
          onBlobDeleted: async (blob) => {
            events.push({ event: "deleted", blob });
          },
        })
        .withRoutes([blobsRoutesFactory]),
    )
    .build();
  const { fragment } = fragments.blobs;

  beforeEach(async () => {
    await testContext.resetDatabase();
    bucket.objects.clear();
    events.length = 0;
  });

  afterAll(async () => {
    await testContext.cleanup();
  });

  async function createUpload(key: string) {
    const response = await fragment.callRoute("POST", "/uploads", {
      body: { key, contentType: "audio/wav" },
    });
    assert(response.type === "json");
    return response.data;
  }

  /** Sends the bytes where a caller holding the URL would: straight to storage. */
  async function putBytes(upload: { url: string; headers: Record<string, string> }, text: string) {
    const response = await storageFetch(upload.url, {
      method: "PUT",
      headers: upload.headers,
      body: new TextEncoder().encode(text),
    });
    assert(response.ok);
  }

  async function completeUpload(uploadId: string) {
    return await fragment.callRoute("POST", "/uploads/:uploadId/complete", {
      pathParams: { uploadId },
    });
  }

  /** Moves every scheduled discard to now, as if every upload URL had expired. */
  async function expireUploads() {
    const internalFragment = getInternalFragment(testContext.adapter);
    const hooks = await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [internalFragment.services.hookService.getHooksByNamespace("blobs")] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });
    await internalFragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          for (const hook of hooks) {
            if (hook.hookName === "discardUnfinishedUpload" && hook.status === "pending") {
              forSchema(internalFragment.$internal.deps.schema).update(
                "fragno_hooks",
                hook.id,
                (b) => b.set({ nextRetryAt: new Date(0) }),
              );
            }
          }
        })
        .execute();
    });
  }

  test("stores a blob, replaces it, and deletes it along with its bytes, telling the integrator", async () => {
    const first = await createUpload("recordings/call.wav");
    assert(first.url.startsWith(`${BUCKET_URL}scope-1/recordings/call.wav/`));

    const early = await completeUpload(first.uploadId);
    assert(early.type === "error");
    assert(early.error.code === "UPLOAD_CONTENT_MISSING");

    await putBytes(first, "first take");
    const stored = await completeUpload(first.uploadId);
    assert(stored.type === "json");
    expect(stored.data).toEqual({
      key: "recordings/call.wav",
      sizeBytes: 10,
      contentType: "audio/wav",
      etag: expect.stringMatching(/^[0-9a-f]{32}$/),
    });

    const download = await fragment.callRoute("GET", "/blobs/by-key/download-url", {
      query: { key: "recordings/call.wav" },
    });
    assert(download.type === "json");
    assert((await (await storageFetch(download.data.url)).text()) === "first take");

    const second = await createUpload("recordings/call.wav");
    await putBytes(second, "the second, longer take");
    const replaced = await completeUpload(second.uploadId);
    assert(replaced.type === "json");
    assert(replaced.data.sizeBytes === 23);
    assert(replaced.data.etag !== stored.data.etag);
    await drainDurableHooks(fragment);
    expect([...bucket.objects.values()].map((bytes) => new TextDecoder().decode(bytes))).toEqual([
      "the second, longer take",
    ]);

    // A completed upload is spent.
    const again = await completeUpload(second.uploadId);
    assert(again.type === "error");
    assert(again.error.code === "UPLOAD_NOT_FOUND");

    const deleted = await fragment.callRoute("DELETE", "/blobs/by-key", {
      query: { key: "recordings/call.wav" },
    });
    assert(deleted.type === "json");
    await drainDurableHooks(fragment);
    assert(bucket.objects.size === 0);

    const missing = await fragment.callRoute("GET", "/blobs/by-key", {
      query: { key: "recordings/call.wav" },
    });
    assert(missing.type === "error");
    assert(missing.error.code === "BLOB_NOT_FOUND");

    expect(events).toEqual([
      { event: "stored", blob: stored.data },
      { event: "stored", blob: replaced.data },
      { event: "deleted", blob: replaced.data },
    ]);
  });

  test("lists blobs under a prefix, a page at a time", async () => {
    for (const key of ["recordings/a.wav", "recordings/b.wav", "recordingsx.wav", "notes.txt"]) {
      const upload = await createUpload(key);
      await putBytes(upload, key);
      assert((await completeUpload(upload.uploadId)).type === "json");
    }

    const firstPage = await fragment.callRoute("GET", "/blobs", {
      query: { prefix: "recordings/", pageSize: "1" },
    });
    assert(firstPage.type === "json");
    expect(firstPage.data.blobs.map((blob) => blob.key)).toEqual(["recordings/a.wav"]);
    assert(firstPage.data.cursor);

    const secondPage = await fragment.callRoute("GET", "/blobs", {
      query: { prefix: "recordings/", pageSize: "1", cursor: firstPage.data.cursor },
    });
    assert(secondPage.type === "json");
    expect(secondPage.data.blobs.map((blob) => blob.key)).toEqual(["recordings/b.wav"]);

    const all = await fragment.callRoute("GET", "/blobs", { query: {} });
    assert(all.type === "json");
    expect(all.data.blobs.map((blob) => blob.key)).toEqual([
      "notes.txt",
      "recordings/a.wav",
      "recordings/b.wav",
      "recordingsx.wav",
    ]);
    expect(all.data.cursor).toBeNull();
  });

  test("discards what unfinished and replaced uploads stored once their URLs expire", async () => {
    const abandoned = await createUpload("recordings/call.wav");
    await putBytes(abandoned, "abandoned");
    const replacement = await createUpload("recordings/call.wav");
    await putBytes(replacement, "kept");

    const replaced = await completeUpload(abandoned.uploadId);
    assert(replaced.type === "error");
    assert(replaced.error.code === "UPLOAD_NOT_FOUND");
    assert((await completeUpload(replacement.uploadId)).type === "json");

    const unfinished = await createUpload("recordings/other.wav");
    await putBytes(unfinished, "never completed");

    await expireUploads();
    await drainDurableHooks(fragment);

    expect([...bucket.objects.values()].map((bytes) => new TextDecoder().decode(bytes))).toEqual([
      "kept",
    ]);
    const expired = await completeUpload(unfinished.uploadId);
    assert(expired.type === "error");
    assert(expired.error.code === "UPLOAD_NOT_FOUND");
  });
});
