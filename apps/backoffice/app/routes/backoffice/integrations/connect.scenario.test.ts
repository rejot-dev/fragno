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

import type { ConversationView } from "@earendil-works/pi-durable";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { createBackofficeServiceExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import type { BackofficeScenarioContext } from "@/fragno/automation/scenario";
import { runProjectConnectorScenario } from "@/fragno/runtime-tools/families/project-connector-scenario.test-utils";
import {
  behindBackofficeLayout,
  sessionUserId,
  withBackofficeAccessToken,
} from "@/layouts/backoffice-layout.test-support";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { createScriptedPiAgentDependencies } from "../../../../workers/pi-durable-scenario.test-support";
import { PiObject } from "../../../../workers/pi-object";
import { action as connectAction, loader as connectLoader } from "./connect";

const ORIGIN = "https://backoffice.example";

const objects = {
  ...allLocalObjects,
  PI: ({ state, runtime, openPiSessionStore, piAgentIdFromConfig, nowEpochMs }) => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage([fauxText("On it.")])]);
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

type Vars = { session: string; cookie: string; userId: string };
type Ctx = BackofficeScenarioContext<Vars>;

/** The route arguments React Router passes for one request to the user's Connect page. */
function connectRequest(ctx: Ctx, search: string, form?: Record<string, string>) {
  const url = new URL(`/backoffice/integrations/user/${ctx.vars.userId}/connect${search}`, ORIGIN);
  const request = new Request(url, {
    method: form ? "POST" : "GET",
    headers: { cookie: ctx.vars.cookie, origin: ORIGIN },
    body: form ? new URLSearchParams(form) : undefined,
  });
  return {
    request,
    url,
    pattern: "/backoffice/integrations/:scopeKind/:scopeId/connect",
    params: { scopeKind: "user", scopeId: ctx.vars.userId },
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
  };
}

const openConnect = (ctx: Ctx, search: string) =>
  behindBackofficeLayout(connectLoader)(connectRequest(ctx, search));

async function submitConnect(ctx: Ctx, form: Record<string, string>) {
  try {
    return { returned: await behindBackofficeLayout(connectAction)(connectRequest(ctx, "", form)) };
  } catch (thrown) {
    assert(thrown instanceof Response, String(thrown));
    return { redirectsTo: thrown.headers.get("location") };
  }
}

/** What the person has said to the scope's main agent. */
async function userMessages(ctx: Ctx): Promise<string[]> {
  const scope: BackofficeContextScope = {
    kind: "user",
    userId: ctx.vars.userId,
    jurisdiction: null,
  };
  const response = await ctx.runtime.objects.piManager
    .for(scope)
    .http.fetchAuthorized(new Request(`${ORIGIN}/api/pi-manager/agents/assistant/view`), {
      execution: createBackofficeServiceExecution({
        scope,
        service: { type: "automation", id: "connect-scenario" },
      }),
    });
  assert.equal(response.status, 200, await response.clone().text());
  const view = await response.json<ConversationView>();
  return view.entries
    .flatMap((entry) => entry.model ?? [])
    .flatMap((message) =>
      message.role !== "user"
        ? []
        : typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    );
}

test("Connect signs a person in to a Connector app and hands a scheduled workflow to their agent", async () => {
  await runProjectConnectorScenario<Vars>((gateway) => ({
    name: "Connect wizard",
    objects,
    env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false" },
    vars: () => ({ session: "", cookie: "", userId: "" }),
    steps: ({ when, then }) => [
      when.auth.signUp({ email: "ada@example.test", captureSessionCookieAs: "session" }),
      then.assert("Ada signs in to her own scope", async (ctx) => {
        ctx.vars.userId = await sessionUserId(ctx, ctx.vars.session);
        ctx.vars.cookie = await withBackofficeAccessToken(ctx, ctx.vars.session, null);
      }),
      then.assert("the catalog presents Gmail as the Connector's catalog does", async (ctx) => {
        const page = await openConnect(ctx, "");
        assert(page.step.kind === "choose");
        expect(page.services.find((service) => service.id === "gmail")).toMatchObject({
          label: "Gmail",
          description: "Email conversations, labels, drafts, and mailbox management",
          iconUrl: "https://static.example/logo/Gmail.svg",
          // Communication is Gmail's primary category, which Telegram shares.
          categories: [{ id: "communication" }, { id: "productivity" }],
          connected: false,
        });
        expect(page.services.find((service) => service.id === "telegram")).toMatchObject({
          iconUrl: null,
          categories: [{ id: "communication" }],
        });
      }),
      then.assert(
        "choosing Gmail offers to sign in, and connecting waits for consent",
        async (ctx) => {
          const chosen = await openConnect(ctx, "?source=gmail");
          assert(chosen.step.kind === "connect" && chosen.step.method.kind === "authorization");
          assert(chosen.step.method.progress.status === "needs-input");

          expect(await submitConnect(ctx, { intent: "start", source: "gmail" })).toEqual({
            returned: { error: null },
          });
          const waiting = await openConnect(ctx, "?source=gmail");
          assert(waiting.step.kind === "connect" && waiting.step.method.kind === "authorization");
          const progress = waiting.step.method.progress;
          assert(progress.status === "needs-authorization");

          const requestId = new URL(progress.authorizationUrl).pathname.split("/").at(-1);
          assert(requestId);
          gateway.authorize(requestId, "gmail-account");
        },
      ),
      then.assert("the page notices consent and lists Gmail as connected", async (ctx) => {
        const connected = await openConnect(ctx, "?source=gmail");
        assert(connected.step.kind === "connect" && connected.step.method.kind === "authorization");
        assert(connected.step.method.progress.status === "ready");
        const catalog = await openConnect(ctx, "");
        assert(catalog.services.find((service) => service.id === "gmail")?.connected);
      }),
      then.assert("a daily workflow request reaches the main agent", async (ctx) => {
        const automate = await openConnect(ctx, "?source=gmail&step=automate");
        assert(automate.step.kind === "automate");
        const { connectionId } = automate.step;

        expect(
          await submitConnect(ctx, {
            intent: "automate",
            source: "gmail",
            schedule: "daily",
            time: "08:30",
            timeZone: "Europe/Amsterdam",
            goal: "Summarize my unread email.",
          }),
        ).toEqual({
          redirectsTo: `/backoffice/integrations/user/${ctx.vars.userId}/connect?agent=opened`,
        });
        const [prompt] = await userMessages(ctx);
        assert(prompt);
        expect(prompt).toContain(`I just connected Gmail (connection ${connectionId}).`);
        expect(prompt).toContain(
          "When: on a schedule, every day at 08:30 (time zone Europe/Amsterdam).",
        );
        expect(prompt).toContain("What it should do: Summarize my unread email.");
      }),
    ],
  }));
});
