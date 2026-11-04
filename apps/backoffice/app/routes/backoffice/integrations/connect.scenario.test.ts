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
import { loader as publicConnectorLoader } from "../../api/project-connector";
import { action as connectAction, loader as connectLoader } from "./connect";
import { loader as sourceLoader } from "./connect-source";

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

type Vars = { session: string; cookie: string; userId: string; gmailLink: string };
type Ctx = BackofficeScenarioContext<Vars>;

const connectPage = (ctx: Ctx) => `/backoffice/integrations/user/${ctx.vars.userId}/connect`;

/**
 * The route arguments React Router passes for one request to the user's Connect page, or with
 * `source` to the source opened in it.
 */
function connectRequest(
  ctx: Ctx,
  { source, search }: { source: string | null; search: string },
  form?: Record<string, string>,
) {
  // Browsers submit forms to React Router's data endpoint, not the page itself.
  const page = `${connectPage(ctx)}${source === null ? "" : `/${source}`}${form ? ".data" : ""}`;
  const url = new URL(`${page}${search}`, ORIGIN);
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
  behindBackofficeLayout(connectLoader)(connectRequest(ctx, { source: null, search }));

/**
 * Opens a source from a link into it, such as a catalog card's or a provider's return. The browser
 * loads the Connect page and the open source together, so both loaders read the link.
 */
async function openSource(ctx: Ctx, link: string) {
  const url = new URL(link, ORIGIN);
  const source = url.pathname.slice(`${connectPage(ctx)}/`.length);
  const request = connectRequest(ctx, { source, search: url.search });
  const args = {
    ...request,
    pattern: `${request.pattern}/:source`,
    params: { ...request.params, source },
  };
  await behindBackofficeLayout(connectLoader)(args);
  return behindBackofficeLayout(sourceLoader)(args);
}

async function submitConnect(ctx: Ctx, form: Record<string, string>) {
  try {
    return {
      returned: await behindBackofficeLayout(connectAction)(
        connectRequest(ctx, { source: null, search: "" }, form),
      ),
    };
  } catch (thrown) {
    assert(thrown instanceof Response, String(thrown));
    return { redirectsTo: thrown.headers.get("location") };
  }
}

/** Follows a provider's return to the Connector's public callback, signed in, as the browser would. */
async function followConnectorReturn(ctx: Ctx, returnUri: string): Promise<string | null> {
  const url = new URL(returnUri);
  const request = new Request(url, { headers: { cookie: ctx.vars.cookie } });
  const [, , , scopeSegment, ...rest] = url.pathname.split("/");
  assert(scopeSegment);
  const response = await publicConnectorLoader({
    request,
    url,
    pattern: "/api/connector/:scopeSegment/*",
    params: { scopeSegment: decodeURIComponent(scopeSegment), "*": rest.join("/") },
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
  });
  assert(response instanceof Response && response.status === 302);
  return response.headers.get("location");
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
    vars: () => ({ session: "", cookie: "", userId: "", gmailLink: "" }),
    steps: ({ when, then }) => [
      when.auth.signUp({ email: "ada@example.test", captureSessionCookieAs: "session" }),
      then.assert("Ada signs in to her own scope", async (ctx) => {
        ctx.vars.userId = await sessionUserId(ctx, ctx.vars.session);
        ctx.vars.cookie = await withBackofficeAccessToken(ctx, ctx.vars.session, null);
      }),
      then.assert("the catalog presents Gmail as the Connector's catalog does", async (ctx) => {
        const page = await openConnect(ctx, "");
        expect(page.services.find((service) => service.id === "gmail")).toMatchObject({
          label: "Gmail",
          // The catalog's description leads; agents read on for how to add accounts.
          description: expect.stringMatching(
            /^Email conversations, labels, drafts, and mailbox management\. Targets /,
          ),
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
          // Gmail's card links to it under the address it signs in at.
          const catalog = await openConnect(ctx, "");
          const [target] = catalog.services.find((service) => service.id === "gmail")!.setupTargets;
          assert(target);
          const search = new URLSearchParams({ target: target.connectionId });
          const chosen = await openSource(ctx, `${connectPage(ctx)}/gmail?${search}`);
          assert(chosen.method.kind === "authorization");
          assert(chosen.method.progress.status === "needs-input");

          // Connecting goes straight to the provider's sign-in, in the same tab.
          const started = await submitConnect(ctx, {
            intent: "start",
            connectionId: chosen.method.connectionId,
          });
          const authorizationUrl = "redirectsTo" in started ? started.redirectsTo : null;
          assert(authorizationUrl);
          const requestId = new URL(authorizationUrl).pathname.split("/").at(-1);
          assert(requestId);
          gateway.authorize(requestId, "gmail-account");
        },
      ),
      then.assert("the provider's return opens Gmail again in the catalog", async (ctx) => {
        const returnUri = gateway.links.at(-1)?.returnUri;
        assert(returnUri);
        assert(/\/oauth\/callback\/connect\/n_[^/]+$/.test(new URL(returnUri).pathname));
        const landing = await followConnectorReturn(ctx, returnUri);
        assert(landing);
        const { pathname, search } = new URL(landing);
        assert(pathname === connectPage(ctx));
        // The return names the connection, and Gmail opens again in the catalog.
        const resumed = await openConnect(ctx, search).then(
          () => null,
          (thrown: unknown) => (thrown instanceof Response ? thrown.headers.get("location") : null),
        );
        assert(resumed);
        assert(resumed.startsWith(`${connectPage(ctx)}/gmail?target=`));
        ctx.vars.gmailLink = resumed;
      }),
      then.assert("the page notices consent and lists Gmail as connected", async (ctx) => {
        // Gmail now opens on its account, with nothing left to sign in to.
        const connected = await openSource(ctx, ctx.vars.gmailLink);
        assert(connected.method.kind === "connected");
        const catalog = await openConnect(ctx, "");
        assert(catalog.services.find((service) => service.id === "gmail")?.connected);
      }),
      then.assert(
        "creating a workflow asks the main agent to clarify it, on its own page",
        async (ctx) => {
          const connected = await openSource(ctx, ctx.vars.gmailLink);
          assert(connected.method.kind === "connected");
          const { connectionId } = connected.method;

          expect(
            await submitConnect(ctx, {
              intent: "create-workflow",
              connectionId,
              timeZone: "Europe/Amsterdam",
            }),
          ).toEqual({
            redirectsTo: `/backoffice/agents/user/${ctx.vars.userId}/agents/assistant`,
          });
          const [prompt] = await userMessages(ctx);
          assert(prompt);
          expect(prompt).toContain(
            `I just connected Gmail (connection ${connectionId}) and want to build a workflow with it.`,
          );
          expect(prompt).toContain("ask me what it should do and how often it should run");
          expect(prompt).toContain("My time zone is Europe/Amsterdam.");
        },
      ),
    ],
  }));
});
