import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createFakeR2, etagOf, requestFromOutside } from "@/fragno/blobs-r2.test-utils";
import { blobsR2BucketsFromEnv } from "@/fragno/blobs-server";
import {
  behindBackofficeLayout,
  withBackofficeAccessToken,
} from "@/layouts/backoffice-layout.test-support";
import {
  action as uploadsAction,
  type LargeFileUploadResult,
} from "@/routes/api/large-files-uploads";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { ApiObject } from "../../../../workers/api-object";
import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
import { BlobsObject } from "../../../../workers/blobs-object";
import { FormsObject } from "../../../../workers/forms-object";
import { OtpObject } from "../../../../workers/otp-object";
import { UploadObject } from "../../../../workers/upload-object";
import { action as deleteAction, loader as largeFilesLoader } from "./large-files";
import { loader as downloadLoader } from "./large-files-download";

const listLargeFiles = behindBackofficeLayout(largeFilesLoader);
const deleteLargeFile = behindBackofficeLayout(deleteAction);
const downloadLargeFile = behindBackofficeLayout(downloadLoader);

const ORIGIN = "https://backoffice.example";
const buckets = blobsR2BucketsFromEnv(
  {
    BLOBS_R2_ENDPOINT: "/cdn-cgi/local/r2/s3",
    BLOBS_R2_BUCKET: "backoffice-blobs",
    BLOBS_R2_ACCESS_KEY_ID: "access-key-1",
    BLOBS_R2_SECRET_ACCESS_KEY: "secret-key-1",
    DOCS_PUBLIC_BASE_URL: ORIGIN,
  },
  "local",
);
assert(buckets);
const r2 = createFakeR2(buckets);

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  BLOBS: (input) => new BlobsObject({ ...input, storage: { buckets, fetch: r2.fetch } }),
  FORMS: (input) => new FormsObject(input),
  OTP: (input) => new OtpObject(input),
  TELEGRAM: null,
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

type LargeFilesScenarioVars = { sessionCookie: string; orgId: string; cookie: string };

const ada = { scopeKind: "org", scopeId: "ada" };
const largeFilesUrl = "/backoffice/files/org/ada/large-files";
const recording = new TextEncoder().encode("RIFF....WAVEfmt the board meeting");

/** Builds the route arguments React Router passes for one browser request. */
function routeRequest(
  ctx: BackofficeScenarioContext<LargeFilesScenarioVars>,
  path: string,
  {
    form,
    params = ada,
    cookie = ctx.vars.cookie,
  }: {
    form?: Record<string, string>;
    params?: { scopeKind: string; scopeId: string };
    cookie?: string;
  } = {},
) {
  const url = new URL(path, ORIGIN);
  const request = new Request(url, {
    method: form ? "POST" : "GET",
    headers: { cookie, origin: ORIGIN },
    body: form ? new URLSearchParams(form) : undefined,
  });
  return {
    request,
    url,
    pattern: path,
    params,
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
  };
}

/** The upload steps are an API route, which names the scope by its id rather than its slug. */
function uploadStepResponse(
  ctx: BackofficeScenarioContext<LargeFilesScenarioVars>,
  step: Record<string, string>,
  cookie = ctx.vars.cookie,
) {
  const scopePath = backofficeContextScopeRoutePath({
    kind: "org",
    orgId: ctx.vars.orgId,
    jurisdiction: null,
  });
  const [scopeKind, scopeId] = scopePath.split("/") as [string, string];
  return uploadsAction(
    routeRequest(ctx, `/api/files-scoped/${scopePath}/large-files/uploads`, {
      form: step,
      params: { scopeKind, scopeId },
      cookie,
    }),
  );
}

async function postUploadStep(
  ctx: BackofficeScenarioContext<LargeFilesScenarioVars>,
  step: Record<string, string>,
) {
  const response = await uploadStepResponse(ctx, step);
  return { status: response.status, result: (await response.json()) as LargeFileUploadResult };
}

/** Starts an upload and PUTs its bytes where the browser would: straight to storage. */
async function uploadFile(
  ctx: BackofficeScenarioContext<LargeFilesScenarioVars>,
  file: { key: string; contentType: string; bytes: Uint8Array<ArrayBuffer> },
) {
  const started = await postUploadStep(ctx, {
    intent: "start",
    key: file.key,
    contentType: file.contentType,
  });
  assert(started.result.ok && started.result.step === "start", JSON.stringify(started));
  const put = await requestFromOutside(r2, started.result.upload.url, {
    method: "PUT",
    headers: started.result.upload.headers,
    body: file.bytes,
  });
  assert(put.ok, `PUT failed with ${put.status}`);
  return started.result.upload.uploadId;
}

/** Follows the page's download link to the storage URL it redirects to. */
async function downloadLocation(
  ctx: BackofficeScenarioContext<LargeFilesScenarioVars>,
  key: string,
) {
  const response = await downloadLargeFile(
    routeRequest(ctx, `${largeFilesUrl}/download?${new URLSearchParams({ key })}`),
  );
  assert(response.status === 302);
  const location = response.headers.get("location");
  assert(location, "The download did not redirect.");
  assert(location.startsWith(`${ORIGIN}/cdn-cgi/local/r2/s3/`));
  return location;
}

async function listed(ctx: BackofficeScenarioContext<LargeFilesScenarioVars>, search = "") {
  const page = await listLargeFiles(routeRequest(ctx, `${largeFilesUrl}${search}`));
  assert(page.status === "available");
  return page;
}

async function rejection(promise: Promise<unknown>): Promise<Response> {
  const thrown = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  assert(thrown instanceof Response, `Expected a thrown Response, got ${String(thrown)}`);
  return thrown;
}

test("a person uploads, downloads, opens, and deletes large files from the Large files page", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Large files page",
      vars: () => ({ sessionCookie: "", orgId: "", cookie: "" }),
      setup: () => [],
      steps: ({ when, then, runner }) => [
        when.auth.signUp({ email: "ada@example.test", captureSessionCookieAs: "sessionCookie" }),
        when.auth.createOrganization({
          cookie: ({ vars }) => vars.sessionCookie,
          name: "Ada",
          slug: "ada",
          captureOrganizationIdAs: "orgId",
        }),
        then.assert("sign in to Backoffice for Ada", async (ctx) => {
          ctx.vars.cookie = await withBackofficeAccessToken(
            ctx,
            ctx.vars.sessionCookie,
            ctx.vars.orgId,
          );
        }),
        then.assert("the owner sees no large files yet, and may upload", async (ctx) => {
          expect(await listed(ctx)).toMatchObject({ files: [], error: null, canModify: true });
        }),
        then.assert(
          "the browser PUTs the bytes to storage between starting and completing",
          async (ctx) => {
            const uploadId = await uploadFile(ctx, {
              key: "recordings/board-meeting.wav",
              contentType: "audio/wav",
              bytes: recording,
            });
            await expect(postUploadStep(ctx, { intent: "complete", uploadId })).resolves.toEqual({
              status: 200,
              result: { ok: true, step: "complete" },
            });
          },
        ),
        then.assert(
          "a step without a current credential is refused, not redirected",
          async (ctx) => {
            // The page refreshes its credential on a 401 and sends the step again.
            const refused = await uploadStepResponse(
              ctx,
              { intent: "start", key: "recordings/late.wav", contentType: "audio/wav" },
              ctx.vars.sessionCookie,
            );
            assert(refused.status === 401);
          },
        ),
        then.assert("completion keeps a storage outage a server error", async (ctx) => {
          const uploadId = await uploadFile(ctx, {
            key: "recordings/outage.wav",
            contentType: "audio/wav",
            bytes: recording,
          });
          r2.setReachable(false);
          try {
            await expect(postUploadStep(ctx, { intent: "complete", uploadId })).resolves.toEqual({
              status: 502,
              result: { ok: false, error: "Storage error" },
            });
          } finally {
            r2.setReachable(true);
          }
          await expect(postUploadStep(ctx, { intent: "complete", uploadId })).resolves.toEqual({
            status: 200,
            result: { ok: true, step: "complete" },
          });
        }),
        then.assert("the files are listed by key prefix, case and all", async (ctx) => {
          expect((await listed(ctx)).files.map(({ key }) => key)).toEqual([
            "recordings/board-meeting.wav",
            "recordings/outage.wav",
          ]);
          expect((await listed(ctx, "?prefix=recordings%2Fb")).files).toEqual([
            {
              key: "recordings/board-meeting.wav",
              sizeBytes: recording.byteLength,
              contentType: "audio/wav",
              etag: await etagOf(recording),
            },
          ]);
          expect((await listed(ctx, "?prefix=Recordings%2F")).files).toEqual([]);
        }),
        then.assert(
          "downloading goes straight to storage, at a URL ending in the file's name",
          async (ctx) => {
            const location = await downloadLocation(ctx, "recordings/board-meeting.wav");
            // Browsers name a saved file after the URL's last segment.
            assert(new URL(location).pathname.endsWith("/board-meeting.wav"));
            const saved = await requestFromOutside(r2, location);
            expect(new Uint8Array(await saved.arrayBuffer())).toEqual(recording);
          },
        ),
        then.assert("downloading a file that is not there is a 404", async (ctx) => {
          const missing = await rejection(
            downloadLargeFile(
              routeRequest(ctx, `${largeFilesUrl}/download?key=recordings%2Fnone.wav`),
            ),
          );
          assert(missing.status === 404);
        }),
        then.assert("deleting the files unlists them", async (ctx) => {
          for (const key of ["recordings/board-meeting.wav", "recordings/outage.wav"]) {
            await expect(
              deleteLargeFile(routeRequest(ctx, largeFilesUrl, { form: { key } })),
            ).resolves.toEqual({ error: null });
          }
          expect((await listed(ctx)).files).toEqual([]);
        }),
        runner.drain(),
        then.assert("and removes their bytes from storage", () => {
          expect([...r2.objects.keys()]).toEqual([]);
        }),
      ],
    }),
  );
});
