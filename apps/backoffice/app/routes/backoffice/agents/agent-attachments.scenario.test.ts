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
import { createUploadHelpers } from "@fragno-dev/upload/helpers";

import type { ConversationView } from "@earendil-works/pi-durable";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { createBackofficeServiceExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  type BackofficeScenarioContext,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "@/fragno/automation/scenario";
import { piAgentAttachmentsFolder } from "@/fragno/pi/agent/pi-agent-attachments";
import { behindBackofficeLayout } from "@/layouts/backoffice-layout.test-support";
import {
  action as uploadScopedAction,
  loader as uploadScopedLoader,
} from "@/routes/api/upload-scoped";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { createScriptedPiAgentDependencies } from "../../../../workers/pi-durable-scenario.test-support";
import { PiObject } from "../../../../workers/pi-object";
import type { PiAgentActionData } from "./agent-conversation";
import { action as agentAction } from "./agent-detail";
import {
  createAssistantUiMessages,
  piConversationMessages,
} from "./session-detail/assistant-runtime";

const ORG_ID = "org-books";
const SCOPE: BackofficeContextScope = { kind: "org", orgId: ORG_ID };
const RECEIPT = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

const runAgentAction = behindBackofficeLayout(agentAction);

const objects = {
  ...allLocalObjects,
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

test("files attached in the chat reach the agent by path and show beside the message", async () => {
  const folder = piAgentAttachmentsFolder("assistant");
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
            { fileKey: `${folder.slice("/workspace/".length)}first/receipt.png` },
          );
          assert.equal(result.kind, "published");
        }),
        then.assert("a message refuses files from outside the conversation", async (ctx) => {
          const elsewhere = await postAgent(ctx, {
            intent: "start",
            content: "Book this.",
            attachments: JSON.stringify(["/workspace/reports/receipt.png"]),
          });
          expect(elsewhere).toMatchObject({
            ok: false,
            error: "Attach only files uploaded in this conversation.",
          });
          const missing = await postAgent(ctx, {
            intent: "start",
            content: "Book this.",
            attachments: JSON.stringify([`${folder}gone/receipt.png`]),
          });
          expect(missing).toMatchObject({
            ok: false,
            error: "receipt.png is no longer in the workspace.",
          });
        }),
        then.assert("the message carries the receipt by path", async (ctx) => {
          const sent = await postAgent(ctx, {
            intent: "start",
            content: "  Book this receipt.  ",
            attachments: JSON.stringify([`${folder}first/receipt.png`]),
          });
          assert(sent.ok, JSON.stringify(sent));
          await ctx.runtime.drain();
          const view = await readView(ctx);
          const [prompt] = view.entries.filter((entry) => entry.kind === "pi.user");
          // The type and size are the workspace's, not the browser's.
          expect(prompt?.model?.[0]?.content).toEqual(
            [
              "Book this receipt.",
              "",
              "<backoffice-attachments>",
              `<file path="${folder}first/receipt.png" type="image/png" size="${RECEIPT.length}"/>`,
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
                    path: `${folder}first/receipt.png`,
                    contentType: "image/png",
                    sizeBytes: RECEIPT.length,
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
