import { expect, test, vi, assert } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { piAgentObjectName } from "@/fragno/pi/agent/pi-agent-contract";
import { loader as presenceLoader } from "@/routes/backoffice/presence";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { establishBackofficeAuthenticatedRequest } from "./backoffice-authenticated-request.server";
import { sessionUserId, withBackofficeAccessToken } from "./backoffice-layout.test-support";
import { recordBackofficePresence } from "./backoffice-presence.server";
import { establishBackofficeShellRequest } from "./backoffice-shell-request.server";

const origin = "https://backoffice.example";

/** Names of the Pi agent objects the scenario has started. */
const startedPiAgents = new Set<string>();
const scenarioObjects = {
  ...allLocalObjects,
  PI: (input) => {
    startedPiAgents.add(String(input.id.name));
    return allLocalObjects.PI(input);
  },
} satisfies LocalBackofficeObjects;

type Vars = {
  adaCookie: string;
  graceCookie: string;
  orgId: string;
  adaId: string;
  invitationId: string;
};
type Ctx = BackofficeScenarioContext<Vars>;

function requestContext(ctx: Ctx, request: Request, waitUntil: Promise<unknown>[]) {
  return createBackofficeRouterContextProvider(request, {
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntil.push(promise);
      },
    } as unknown as ExecutionContext,
  });
}

/** Opens a page through the Backoffice layout middleware, then lets its best-effort work finish. */
async function openPage(
  ctx: Ctx,
  cookie: string,
  path: string,
  params: { scopeKind: string; scopeId: string },
) {
  const url = new URL(path, origin);
  const request = new Request(url, { headers: { cookie } });
  const waitUntil: Promise<unknown>[] = [];
  const args = { request, url, params, context: requestContext(ctx, request, waitUntil) };
  await establishBackofficeAuthenticatedRequest(args, () =>
    establishBackofficeShellRequest(args, () =>
      recordBackofficePresence(args, async () => new Response(null)),
    ),
  );
  await Promise.all(waitUntil);
}

/** The browser drops the access token cookie when the token expires, keeping only the session. */
function withoutAccessToken(cookie: string) {
  return cookie.replace(/; fragno-backoffice\.access_token=[^;]+/u, "");
}

/** The members a user's top bar shows, read as its presence indicator reads them. */
async function presenceSeenBy(ctx: Ctx, cookie: string) {
  const url = new URL("/backoffice/presence", origin);
  const request = new Request(url, { headers: { cookie } });
  const { members } = await presenceLoader({
    request,
    url,
    params: {},
    context: requestContext(ctx, request, []),
  } as never);
  return members.map(({ email, path }) => ({ email, path }));
}

test("members see who in their organization was recently active, and where", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario<Vars>({
      name: "Backoffice presence",
      objects: scenarioObjects,
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false" },
      vars: () => ({ adaCookie: "", graceCookie: "", orgId: "", adaId: "", invitationId: "" }),
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "ada@acme.test", captureSessionCookieAs: "adaCookie" }),
        when.auth.signUp({ email: "grace@acme.test", captureSessionCookieAs: "graceCookie" }),
        when.auth.createOrganization({
          cookie: ({ vars }) => vars.adaCookie,
          name: "Acme",
          slug: "acme",
          captureOrganizationIdAs: "orgId",
        }),
        when.auth.inviteMember({
          cookie: ({ vars }) => vars.adaCookie,
          organizationId: ({ vars }) => vars.orgId,
          email: "grace@acme.test",
          captureInvitationIdAs: "invitationId",
        }),
        when.auth.acceptInvitation({
          cookie: ({ vars }) => vars.graceCookie,
          invitationId: ({ vars }) => vars.invitationId,
        }),
        then.assert("Ada and Grace work in Acme, where nobody has been around yet", async (ctx) => {
          ctx.vars.adaId = await sessionUserId(ctx, ctx.vars.adaCookie);
          ctx.vars.adaCookie = await withBackofficeAccessToken(
            ctx,
            ctx.vars.adaCookie,
            ctx.vars.orgId,
          );
          ctx.vars.graceCookie = await withBackofficeAccessToken(
            ctx,
            ctx.vars.graceCookie,
            ctx.vars.orgId,
          );
          expect(await presenceSeenBy(ctx, ctx.vars.graceCookie)).toEqual([]);
          assert(
            !ctx.runtime.hasObjectInstance({
              binding: "PI_MANAGER",
              scope: { kind: "org", orgId: ctx.vars.orgId, jurisdiction: null },
            }),
          );
        }),
        then.assert(
          "Ada opens Acme's dashboard, which starts Acme's objects and its assistant",
          async (ctx) => {
            const acme = { kind: "org" as const, orgId: ctx.vars.orgId, jurisdiction: null };
            const assistant = piAgentObjectName({ scope: acme, agentName: "assistant" });
            assert(!startedPiAgents.has(assistant));
            await openPage(ctx, ctx.vars.adaCookie, "/backoffice/dashboard/org/acme", {
              scopeKind: "org",
              scopeId: "acme",
            });
            assert(ctx.runtime.hasObjectInstance({ binding: "PI_MANAGER", scope: acme }));
            assert(startedPiAgents.has(assistant));
          },
        ),
        then.assert(
          "Grace sees Ada on the dashboard, and Ada does not see herself",
          async (ctx) => {
            // Presence outlives its object, which Cloudflare may evict between two page requests.
            await ctx.runtime.restartObject({
              binding: "PRESENCE",
              scope: { kind: "org", orgId: ctx.vars.orgId, jurisdiction: null },
            });
            expect(await presenceSeenBy(ctx, ctx.vars.graceCookie)).toEqual([
              { email: "ada@acme.test", path: "/backoffice/dashboard/org/acme" },
            ]);
            expect(await presenceSeenBy(ctx, ctx.vars.adaCookie)).toEqual([]);
          },
        ),
        then.assert(
          "in her personal files, Ada is around but Grace does not see where",
          async (ctx) => {
            await openPage(ctx, ctx.vars.adaCookie, `/backoffice/files/user/${ctx.vars.adaId}`, {
              scopeKind: "user",
              scopeId: ctx.vars.adaId,
            });
            expect(await presenceSeenBy(ctx, ctx.vars.graceCookie)).toEqual([
              { email: "ada@acme.test", path: null },
            ]);
            assert(
              ctx.runtime.hasObjectInstance({
                binding: "UPLOAD",
                scope: { kind: "user", userId: ctx.vars.adaId, jurisdiction: null },
              }),
            );
          },
        ),
        when.time.advance("5 minutes"),
        then.assert("five quiet minutes later, Ada is no longer around", async (ctx) => {
          expect(await presenceSeenBy(ctx, ctx.vars.graceCookie)).toEqual([]);
        }),
        then.assert(
          "Grace's tab sleeps past her token, so its poll sees nobody until the tab refreshes it",
          async (ctx) => {
            await openPage(ctx, ctx.vars.adaCookie, "/backoffice/dashboard/org/acme", {
              scopeKind: "org",
              scopeId: "acme",
            });
            const graceSession = withoutAccessToken(ctx.vars.graceCookie);
            expect(await presenceSeenBy(ctx, graceSession)).toEqual([]);
            ctx.vars.graceCookie = await withBackofficeAccessToken(
              ctx,
              graceSession,
              ctx.vars.orgId,
            );
            expect(await presenceSeenBy(ctx, ctx.vars.graceCookie)).toEqual([
              { email: "ada@acme.test", path: "/backoffice/dashboard/org/acme" },
            ]);
          },
        ),
      ],
    }),
  );
});
