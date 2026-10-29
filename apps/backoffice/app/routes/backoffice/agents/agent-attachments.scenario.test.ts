import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { STATE_FILE_MAX_BYTES } from "@fragno-dev/backoffice-api/v0/state";
import { createUploadHelpers } from "@fragno-dev/upload/helpers";

import type { ConversationView } from "@earendil-works/pi-durable";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { createBackofficeServiceExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";
import {
  type BackofficeScenarioContext,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "@/fragno/automation/scenario";
import { createFakeR2, requestFromOutside } from "@/fragno/blobs-r2.test-utils";
import { blobsR2BucketsFromEnv } from "@/fragno/blobs-server";
import { piAgentAttachmentsKeyPrefix } from "@/fragno/pi/agent/pi-agent-attachments";
import { behindBackofficeLayout } from "@/layouts/backoffice-layout.test-support";
import {
  action as largeFileUploadsAction,
  type LargeFileUploadResult,
} from "@/routes/api/large-files-uploads";
import {
  action as uploadScopedAction,
  loader as uploadScopedLoader,
} from "@/routes/api/upload-scoped";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { BlobsObject } from "../../../../workers/blobs-object";
import { createScriptedPiAgentDependencies } from "../../../../workers/pi-durable-scenario.test-support";
import { PiObject } from "../../../../workers/pi-object";
import type { PiAgentActionData } from "./agent-conversation";
import { action as agentAction } from "./agent-detail";
import {
  createAssistantUiMessages,
  piConversationMessages,
} from "./session-detail/assistant-runtime";

const ORG_ID = "org-books";
const SCOPE: BackofficeContextScope = { kind: "org", orgId: ORG_ID, jurisdiction: null };
const RECEIPT = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
// One byte more than a workspace file holds, so the composer keeps it as a large file.
const SCAN = new Uint8Array(STATE_FILE_MAX_BYTES + 1);
SCAN.set(new TextEncoder().encode("%PDF-1.7\n"));

const runAgentAction = behindBackofficeLayout(agentAction);

const blobBuckets = blobsR2BucketsFromEnv(
  {
    BLOBS_R2_ENDPOINT: "/cdn-cgi/local/r2/s3",
    BLOBS_R2_BUCKET: "backoffice-blobs",
    BLOBS_R2_ACCESS_KEY_ID: "access-key-1",
    BLOBS_R2_SECRET_ACCESS_KEY: "secret-key-1",
    DOCS_PUBLIC_BASE_URL: "https://backoffice.example/",
  },
  "local",
);
assert(blobBuckets);
const r2 = createFakeR2(blobBuckets);

const objects = {
  ...allLocalObjects,
  BLOBS: (input) =>
    new BlobsObject({ ...input, storage: { buckets: blobBuckets, fetch: r2.fetch } }),
  PI: ({ state, runtime, openPiSessionStore, piAgentIdFromConfig, nowEpochMs }) => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage([fauxText("Booked under meals.")])]);
    const models = createModels();
    models.setProvider(faux.provider);
    return new PiObject({
      state,
      dependencies: createScriptedPiAgentDependencies(models),
      runtime,
      openStorage: openPiSessionStore,
      idFromConfig: piAgentIdFromConfig,
      nowEpochMs,
    });
  },
} satisfies LocalBackofficeObjects;

function routerContext(ctx: BackofficeScenarioContext, request: Request) {
  return createBackofficeRouterContextProvider(request, {
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
}

/** The composer's upload helpers, sending the browser's requests through the scoped proxy. */
function browserUploads(ctx: BackofficeScenarioContext) {
  const mountRoute = `https://backoffice.example/api/upload-scoped/org/${ORG_ID}`;
  return createUploadHelpers({
    buildUrl: (path) => `${mountRoute}${path}`,
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      request.headers.set("cookie", ctx.vars.cookie as string);
      const url = new URL(request.url);
      const args = {
        request,
        url,
        pattern: "/api/upload-scoped/:scopeKind/:scopeId/*",
        params: {
          scopeKind: "org",
          scopeId: ORG_ID,
          "*": url.pathname.slice(new URL(mountRoute).pathname.length + 1),
        },
        context: routerContext(ctx, request),
      };
      return request.method === "GET"
        ? await uploadScopedLoader(args)
        : await uploadScopedAction(args);
    },
  });
}

/** One step of a large file upload, as the composer posts it for a file too large for the workspace. */
async function postLargeFileUploadStep(
  ctx: BackofficeScenarioContext,
  step: Record<string, string>,
): Promise<LargeFileUploadResult> {
  const [scopeKind, scopeId] = backofficeContextScopeRoutePath(SCOPE).split("/") as [
    string,
    string,
  ];
  const url = new URL(
    `https://backoffice.example/api/files-scoped/${scopeKind}/${scopeId}/large-files/uploads`,
  );
  const request = new Request(url, {
    method: "POST",
    headers: { cookie: ctx.vars.cookie as string, origin: url.origin },
    body: new URLSearchParams(step),
  });
  const response = await largeFileUploadsAction({
    request,
    url,
    pattern: "/api/files-scoped/:scopeKind/:scopeId/large-files/uploads",
    params: { scopeKind, scopeId },
    context: routerContext(ctx, request),
  });
  return (await response.json()) as LargeFileUploadResult;
}

/** Uploads a file as the composer does one too large for the workspace: its bytes go to storage. */
async function uploadLargeFile(
  ctx: BackofficeScenarioContext,
  file: { key: string; contentType: string; bytes: Uint8Array<ArrayBuffer> },
) {
  const started = await postLargeFileUploadStep(ctx, {
    intent: "start",
    key: file.key,
    contentType: file.contentType,
  });
  assert(started.ok && started.step === "start", JSON.stringify(started));
  const put = await requestFromOutside(r2, started.upload.url, {
    method: "PUT",
    headers: started.upload.headers,
    body: file.bytes,
  });
  assert(put.ok, `PUT failed with ${put.status}`);
  const completed = await postLargeFileUploadStep(ctx, {
    intent: "complete",
    uploadId: started.upload.uploadId,
  });
  assert(completed.ok, JSON.stringify(completed));
}

/** Posts the agent page's form, as its composer's fetcher does. */
async function postAgent(ctx: BackofficeScenarioContext, fields: Record<string, string>) {
  const url = new URL("https://backoffice.example/backoffice/agents/org/books/agents/assistant");
  const request = new Request(url, {
    method: "POST",
    headers: { cookie: ctx.vars.cookie as string },
    body: new URLSearchParams(fields),
  });
  return (await runAgentAction({
    request,
    url,
    pattern: "/backoffice/agents/:scopeKind/:scopeId/agents/:agentName",
    params: { scopeKind: "org", scopeId: "books", agentName: "assistant" },
    context: routerContext(ctx, request),
  })) as PiAgentActionData;
}

async function readView(ctx: BackofficeScenarioContext) {
  const response = await ctx.runtime.objects.piManager
    .for(SCOPE)
    .http.fetchAuthorized(
      new Request("https://backoffice.example/api/pi-manager/agents/assistant/view"),
      {
        execution: createBackofficeServiceExecution({
          scope: SCOPE,
          service: { type: "automation", id: "attachments-scenario" },
        }),
      },
    );
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json<ConversationView>();
}

test("files attached in the chat reach the agent where they were uploaded and show beside the message", async () => {
  const prefix = piAgentAttachmentsKeyPrefix("assistant");
  const folder = `/workspace/${prefix}`;
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Agent chat attachments",
      objects,
      piAvailableModels: [
        {
          provider: "faux",
          modelId: "faux-1",
          label: "Faux 1",
          contextWindow: 128_000,
          thinkingLevels: ["off"],
        },
      ],
      options: { drain: false },
      setup: ({ given }) => [
        given.organization.exists({ id: ORG_ID, slug: "books", name: "Books" }),
      ],
      steps: ({ when, then }) => [
        when.auth.signUp({
          email: "bookkeeper@example.test",
          captureSessionCookieAs: "sessionCookie",
        }),
        then.assert("sign the bookkeeper in to the organization", async (ctx) => {
          const auth = ctx.runtime.objects.auth.singleton();
          const session = await auth.http.fetch(
            new Request("https://backoffice.example/api/auth/get-session", {
              headers: { cookie: ctx.vars.sessionCookie as string },
            }),
          );
          assert(session.ok);
          const { user } = (await session.json()) as { user: { id: string } };
          await auth.commands.applyScenarioFixture({
            members: [{ organizationId: ORG_ID, userId: user.id, roles: ["owner"] }],
          });
          const exchange = await auth.http.fetch(
            new Request("https://backoffice.example/api/auth/backoffice-token", {
              method: "POST",
              headers: {
                cookie: ctx.vars.sessionCookie as string,
                origin: "https://backoffice.example",
                "content-type": "application/json",
              },
              body: JSON.stringify({ selection: "required", organizationId: ORG_ID }),
            }),
          );
          assert(exchange.ok, await exchange.clone().text());
          ctx.vars.cookie = exchange.headers
            .getSetCookie()
            .map((header) => header.split(";", 1)[0])
            .join("; ");
        }),
        then.assert("the composer uploads a receipt into the agent's folder", async (ctx) => {
          const result = await browserUploads(ctx).createUploadAndTransfer(
            new File([RECEIPT], "receipt.png", { type: "image/png" }),
            { fileKey: `${prefix}first/receipt.png` },
          );
          assert.equal(result.kind, "published");
        }),
        then.assert("a scan too large for the workspace is kept as a large file", async (ctx) => {
          await uploadLargeFile(ctx, {
            key: `${prefix}second/scan.pdf`,
            contentType: "application/pdf",
            bytes: SCAN,
          });
          await uploadLargeFile(ctx, {
            key: `${prefix}third/draft.pdf`,
            contentType: "application/pdf",
            bytes: SCAN,
          });
        }),
        then.assert("a large file removed from the composer is discarded", async (ctx) => {
          await expect(
            postLargeFileUploadStep(ctx, { intent: "discard", key: `${prefix}third/draft.pdf` }),
          ).resolves.toEqual({ ok: true, step: "discard" });
          await expect(
            postAgent(ctx, {
              intent: "start",
              content: "Book this.",
              attachments: JSON.stringify([{ kind: "blob", key: `${prefix}third/draft.pdf` }]),
            }),
          ).resolves.toMatchObject({
            ok: false,
            error: "draft.pdf is no longer among the large files.",
          });
        }),
        then.assert("a message refuses files from outside the conversation", async (ctx) => {
          const elsewhere = await postAgent(ctx, {
            intent: "start",
            content: "Book this.",
            attachments: JSON.stringify([
              { kind: "workspace", path: "/workspace/reports/receipt.png" },
            ]),
          });
          expect(elsewhere).toMatchObject({
            ok: false,
            error: "Attach only files uploaded in this conversation.",
          });
          const otherBlob = await postAgent(ctx, {
            intent: "start",
            content: "Book this.",
            attachments: JSON.stringify([{ kind: "blob", key: "reports/scan.pdf" }]),
          });
          expect(otherBlob).toMatchObject({
            ok: false,
            error: "Attach only files uploaded in this conversation.",
          });
          const missing = await postAgent(ctx, {
            intent: "start",
            content: "Book this.",
            attachments: JSON.stringify([{ kind: "workspace", path: `${folder}gone/receipt.png` }]),
          });
          expect(missing).toMatchObject({
            ok: false,
            error: "receipt.png is no longer in the workspace.",
          });
        }),
        then.assert("the message carries the receipt by path and the scan by key", async (ctx) => {
          const sent = await postAgent(ctx, {
            intent: "start",
            content: "  Book this receipt.  ",
            attachments: JSON.stringify([
              { kind: "workspace", path: `${folder}first/receipt.png` },
              { kind: "blob", key: `${prefix}second/scan.pdf` },
            ]),
          });
          assert(sent.ok, JSON.stringify(sent));
          await ctx.runtime.drain();
          const view = await readView(ctx);
          const [prompt] = view.entries.filter((entry) => entry.kind === "pi.user");
          // The types and sizes are the workspace's and storage's, not the browser's.
          expect(prompt?.model?.[0]?.content).toEqual(
            [
              "Book this receipt.",
              "",
              "<backoffice-attachments>",
              `<file path="${folder}first/receipt.png" type="image/png" size="${RECEIPT.length}"/>`,
              `<blob key="${prefix}second/scan.pdf" type="application/pdf" size="${SCAN.length}"/>`,
              "</backoffice-attachments>",
            ].join("\n"),
          );
          expect(JSON.stringify(view.entries)).toContain("Booked under meals.");

          const { messages, activeContextStartIndex } = piConversationMessages(view.entries, null);
          const transcript = createAssistantUiMessages({
            draftAgentMessage: null,
            messages,
            activeContextStartIndex,
            readyForInput: true,
            statusText: null,
          }).messages;
          expect(transcript.find((message) => message.role === "user")).toMatchObject({
            content: [{ type: "text", text: "Book this receipt." }],
            metadata: {
              custom: {
                kind: "user",
                attachments: [
                  {
                    kind: "workspace",
                    path: `${folder}first/receipt.png`,
                    contentType: "image/png",
                    sizeBytes: RECEIPT.length,
                  },
                  {
                    kind: "blob",
                    key: `${prefix}second/scan.pdf`,
                    contentType: "application/pdf",
                    sizeBytes: SCAN.length,
                  },
                ],
              },
            },
          });
        }),
      ],
    }),
  );
});
