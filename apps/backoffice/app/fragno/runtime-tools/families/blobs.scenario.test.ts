import { assert, expect, test, vi } from "vitest";

import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import {
  bucketUrl,
  createFakeR2,
  etagOf,
  requestFromOutside,
  type FakeR2,
} from "@/fragno/blobs-r2.test-utils";
import { blobsR2BucketsFromEnv, type BlobsR2Buckets } from "@/fragno/blobs-server";

import { ApiObject } from "../../../../workers/api-object";
import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
import { BillingObject } from "../../../../workers/billing-object";
import { BlobsObject } from "../../../../workers/blobs-object";
import { CodemodeObject } from "../../../../workers/codemode-object";
import { FormsObject } from "../../../../workers/forms-object";
import { UploadObject } from "../../../../workers/upload-object";

const credentials = {
  BLOBS_R2_BUCKET: "backoffice-blobs",
  BLOBS_R2_ACCESS_KEY_ID: "access-key-1",
  BLOBS_R2_SECRET_ACCESS_KEY: "secret-key-1",
};

// A dev server behind a tunnel: Miniflare serves the bucket's S3 API at a path of the hosting URL,
// so blob URLs must name that URL to reach sandboxes and people elsewhere.
const hostingUrl = "https://dev-tunnel.example/";
const localBuckets = blobsR2BucketsFromEnv(
  { ...credentials, BLOBS_R2_ENDPOINT: "/cdn-cgi/local/r2/s3", DOCS_PUBLIC_BASE_URL: hostingUrl },
  "local",
);
assert(localBuckets);
const localBucketUrl = bucketUrl(localBuckets.none);

const deployedBuckets = blobsR2BucketsFromEnv(
  {
    ...credentials,
    BLOBS_R2_ENDPOINT: "https://account-1.r2.cloudflarestorage.com",
    DOCS_PUBLIC_BASE_URL: "https://backoffice.example/",
  },
  "enforced",
);
assert(deployedBuckets);

function scenarioObjects(r2: FakeR2, buckets: BlobsR2Buckets) {
  return {
    API: (input) => new ApiObject(input),
    AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
    AUTOMATIONS: (input) => new AutomationsObject(input),
    BILLING: (input) => new BillingObject(input),
    CODEMODE: (input) => new CodemodeObject(input),
    UPLOAD: (input) => new UploadObject(input),
    BLOBS: (input) => new BlobsObject({ ...input, storage: { buckets, fetch: r2.fetch } }),
    TELEGRAM: null,
    FORMS: (input) => new FormsObject(input),
  } satisfies LocalBackofficeObjects;
}

const acme = { kind: "org", orgId: "acme", jurisdiction: null } as const;
const globex = { kind: "org", orgId: "globex", jurisdiction: null } as const;
const recording = new TextEncoder().encode("RIFF....WAVEfmt a long recording");
const rerecording = new TextEncoder().encode("RIFF....WAVEfmt the call, recorded again");

async function runCodemode(
  ctx: BackofficeScenarioContext,
  scope: BackofficeContextScope,
  code: string,
) {
  const run = await ctx.runCodemode({ scope, code });
  return run.result;
}

/** Sends the bytes where a sandbox's `curl -T` would: straight to storage, not to Backoffice. */
async function putToPresignedUrl(
  r2: FakeR2,
  upload: { url: string; headers: Record<string, string> },
  bytes: Uint8Array<ArrayBuffer>,
) {
  const response = await requestFromOutside(r2, upload.url, {
    method: "PUT",
    headers: upload.headers,
    body: bytes,
  });
  assert(response.ok, `PUT failed with ${response.status}`);
}

test("a scope stores a large file as a blob through presigned URLs, apart from other scopes", async () => {
  const r2 = createFakeR2(localBuckets);
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "blobs through presigned R2 URLs",
      objects: scenarioObjects(r2, localBuckets),
      setup: ({ given }) => [
        given.organization.exists({ id: acme.orgId }),
        given.organization.exists({ id: globex.orgId }),
      ],
      steps: ({ then, runner }) => [
        then.assert(
          "an upload needs no size up front and records what storage holds",
          async (ctx) => {
            const createUpload = async () =>
              (await runCodemode(
                ctx,
                acme,
                `async () => await blobs.createUpload({ key: "calls/monday.wav", contentType: "audio/wav" })`,
              )) as { uploadId: string; key: string; url: string; headers: Record<string, string> };
            const completeUpload = (uploadId: string) =>
              runCodemode(
                ctx,
                acme,
                `async () => await blobs.completeUpload({ uploadId: ${JSON.stringify(uploadId)} })`,
              );

            const abandoned = await createUpload();
            assert(abandoned.key === "calls/monday.wav");
            const url = new URL(abandoned.url);
            // The URL names the hosting URL, and Acme's bytes go under Acme's prefix of the bucket.
            expect(url.origin).toBe(new URL(hostingUrl).origin);
            expect(url.pathname).toMatch(
              new RegExp(`^${new URL(localBucketUrl).pathname}org/acme/calls/monday\\.wav/[^/]+$`),
            );
            assert(url.searchParams.has("X-Amz-Signature"));
            await expect(completeUpload(abandoned.uploadId)).rejects.toThrow("Blobs returned");

            // Asking again for the same key replaces the upload that never received its bytes.
            const upload = await createUpload();
            await expect(completeUpload(abandoned.uploadId)).rejects.toThrow("Blobs returned");
            await putToPresignedUrl(r2, upload, recording);
            await expect(completeUpload(upload.uploadId)).resolves.toEqual({
              key: "calls/monday.wav",
              sizeBytes: recording.byteLength,
              contentType: "audio/wav",
              etag: await etagOf(recording),
            });
          },
        ),
        then.assert("the blob is listed and downloadable in its scope only", async (ctx) => {
          const blob = {
            key: "calls/monday.wav",
            sizeBytes: recording.byteLength,
            contentType: "audio/wav",
            etag: await etagOf(recording),
          };
          await expect(
            runCodemode(
              ctx,
              acme,
              `async () => ({ listed: await blobs.list({ prefix: "calls/" }), got: await blobs.get({ key: "calls/monday.wav" }) })`,
            ),
          ).resolves.toEqual({ listed: { blobs: [blob], cursor: null }, got: blob });

          const download = (await runCodemode(
            ctx,
            acme,
            `async () => await blobs.createDownloadUrl({ key: "calls/monday.wav" })`,
          )) as { url: string };
          const response = await requestFromOutside(r2, download.url);
          expect(new Uint8Array(await response.arrayBuffer())).toEqual(recording);

          await expect(
            runCodemode(
              ctx,
              globex,
              `async () => ({ listed: await blobs.list({}), got: await blobs.get({ key: "calls/monday.wav" }) })`,
            ),
          ).resolves.toEqual({ listed: { blobs: [], cursor: null }, got: null });
        }),
        then.assert("uploading to the same key replaces the blob", async (ctx) => {
          const upload = (await runCodemode(
            ctx,
            acme,
            `async () => await blobs.createUpload({ key: "calls/monday.wav", contentType: "audio/wav" })`,
          )) as { uploadId: string; url: string; headers: Record<string, string> };
          await putToPresignedUrl(r2, upload, rerecording);
          await expect(
            runCodemode(
              ctx,
              acme,
              `async () => await blobs.completeUpload({ uploadId: ${JSON.stringify(upload.uploadId)} })`,
            ),
          ).resolves.toMatchObject({
            sizeBytes: rerecording.byteLength,
            etag: await etagOf(rerecording),
          });
        }),
        runner.drain(),
        then.assert("only the replacement's bytes stay in storage", async (ctx) => {
          const [stored, ...others] = r2.objects.values();
          expect(others).toEqual([]);
          expect(stored?.bytes).toEqual(rerecording);
          const download = (await runCodemode(
            ctx,
            acme,
            `async () => await blobs.createDownloadUrl({ key: "calls/monday.wav" })`,
          )) as { url: string };
          const response = await requestFromOutside(r2, download.url);
          expect(new Uint8Array(await response.arrayBuffer())).toEqual(rerecording);
        }),
        then.assert("deleting the blob forgets it", async (ctx) => {
          await runCodemode(
            ctx,
            acme,
            `async () => await blobs.delete({ key: "calls/monday.wav" })`,
          );
          await expect(
            runCodemode(ctx, acme, `async () => await blobs.get({ key: "calls/monday.wav" })`),
          ).resolves.toBeNull();
        }),
        runner.drain(),
        then.assert("and removes its bytes from storage", () => {
          expect([...r2.objects.keys()]).toEqual([]);
        }),
      ],
    }),
  );
});

test("an organization's blobs stay in its jurisdiction's bucket", async () => {
  const r2 = createFakeR2(deployedBuckets);
  const initech = { kind: "org", orgId: "initech", jurisdiction: "eu" } as const;
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "blobs in jurisdictions",
      objects: scenarioObjects(r2, deployedBuckets),
      setup: ({ given }) => [
        given.organization.exists({ id: acme.orgId }),
        given.organization.exists({ id: initech.orgId }),
      ],
      steps: ({ then }) => [
        then.assert("each blob's bytes go to its organization's bucket", async (ctx) => {
          for (const scope of [acme, initech]) {
            const upload = (await runCodemode(
              ctx,
              scope,
              `async () => await blobs.createUpload({ key: "contracts/2026.pdf" })`,
            )) as { uploadId: string; url: string; headers: Record<string, string> };
            await putToPresignedUrl(r2, upload, recording);
            await runCodemode(
              ctx,
              scope,
              `async () => await blobs.completeUpload({ uploadId: ${JSON.stringify(upload.uploadId)} })`,
            );
          }

          expect([...r2.objects.keys()].map((url) => new URL(url).host)).toEqual([
            "account-1.r2.cloudflarestorage.com",
            "account-1.eu.r2.cloudflarestorage.com",
          ]);
        }),
      ],
    }),
  );
});
