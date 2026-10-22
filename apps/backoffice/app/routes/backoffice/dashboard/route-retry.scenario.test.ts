import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import type { AutomationEventDetail } from "@fragno-dev/backoffice-api/v0/events";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { behindBackofficeLayout } from "@/layouts/backoffice-layout.test-support";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { InMemoryApiObject } from "../../../../workers/api.do";
import { InMemoryAuthObject } from "../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../../workers/forms.do";
import { InMemoryOtpObject } from "../../../../workers/otp.do";
import { InMemoryTelegramObject } from "../../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../../workers/upload.do";
import { action as eventsAction } from "./events";

const ORIGIN = "https://backoffice.example";

const scenarioObjects = {
  MCP: null,
  OTP: (input) => new InMemoryOtpObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  API: (input) => new InMemoryApiObject(input),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
} satisfies LocalBackofficeObjects;

type RouteRetryVars = {
  adaSession: string;
  adaCookie: string;
  orgId: string;
};

type Ctx = BackofficeScenarioContext<RouteRetryVars>;

const EVENTS_PAGE = "/backoffice/dashboard/org/ada/events";
const EVENT_ID = "check-1";

/** Builds the route arguments React Router passes for one signed-in browser form post. */
function formPost(ctx: Ctx, cookie: string, path: string, form: Record<string, string>) {
  const url = new URL(path, ORIGIN);
  const [, , , scopeKind, scopeId] = url.pathname.split("/").map(decodeURIComponent);
  assert(scopeKind && scopeId, `Expected a scoped page path, got ${path}`);
  const request = new Request(url, {
    method: "POST",
    headers: { cookie, origin: ORIGIN },
    body: new URLSearchParams(form),
  });
  return {
    request,
    url,
    pattern: path,
    params: { scopeKind, scopeId },
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
  };
}

function authRequest(ctx: Ctx, pathname: string, cookie: string, body?: unknown) {
  return ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${ORIGIN}/api/auth${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie,
        origin: ORIGIN,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

/** Signs a session in to Backoffice, as the browser does before loading any page. */
async function backofficeCookie(ctx: Ctx, session: string): Promise<string> {
  const exchange = await authRequest(ctx, "/backoffice-token", session, {
    selection: "preferred",
  });
  assert(exchange.ok, await exchange.clone().text());
  return [
    session,
    ...exchange.headers.getSetCookie().map((header) => header.split(";", 1)[0]),
  ].join("; ");
}

function automations(ctx: Ctx, path: string, init?: RequestInit) {
  return ctx.runtime.objects.automations
    .forOrg(ctx.vars.orgId)
    .http.fetch(new Request(`${ORIGIN}/api/automations${path}`, init));
}

async function forwardRoute(ctx: Ctx) {
  const response = await automations(ctx, `/events/${EVENT_ID}`);
  assert(response.ok, await response.clone().text());
  const { routing } = (await response.json()) as AutomationEventDetail;
  assert(routing.status === "matched");
  return routing.routes.find((route) => route.routeId === "forward");
}

test("an owner retries a route that failed for good from the events page", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Retry a failed route from the events page",
      // The retried route fails again, because it still forwards outside the organization.
      options: { allowFailedDurableHooks: true },
      vars: () => ({ adaSession: "", adaCookie: "", orgId: "" }),
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "ada@example.test", captureSessionCookieAs: "adaSession" }),
        when.auth.createOrganization({
          cookie: ({ vars }) => vars.adaSession,
          name: "Ada",
          slug: "ada",
          captureOrganizationIdAs: "orgId",
        }),
        then.assert("a route of Ada's organization fails for good on an event", async (ctx) => {
          ctx.vars.adaCookie = await backofficeCookie(ctx, ctx.vars.adaSession);
          const context = createRouteBackedRuntimeContext({
            emitter: { kind: "caller" },
            runtime: ctx.runtime.services,
            kernel: new BackofficeKernel(ctx.runtime.services),
            execution: createBackofficeSystemExecution({ kind: "org", orgId: ctx.vars.orgId }),
          });
          assert(context.stateBackend);
          const { bash } = await createInteractiveBashHost({
            context: { ...context, stateBackend: context.stateBackend },
          });
          const route = {
            id: "forward",
            name: "Forward to another organization",
            trigger: { kind: "event", source: "custom", eventType: "check.requested" },
            action: { kind: "forward_event", targetScope: { kind: "org", orgIdTemplate: "org-2" } },
          };
          const created = await bash.exec(`router.create --json '${JSON.stringify(route)}'`);
          expect(created.exitCode, created.stderr).toBe(0);
          await ctx.runtime.objects.automations.forOrg(ctx.vars.orgId).commands.ingestEvent({
            id: EVENT_ID,
            scopeRestriction: null,
            scope: { kind: "org", orgId: ctx.vars.orgId },
            source: "custom",
            eventType: "check.requested",
            occurredAt: "2026-01-01T00:00:00.000Z",
            payload: {},
            actors: { initiator: AUTOMATION_SYSTEM_INITIATOR, principal: null, delegation: [] },
            subject: { orgId: ctx.vars.orgId },
            causation: { kind: "origin" },
          });
          await ctx.drain();
          expect(await forwardRoute(ctx)).toMatchObject({ status: "failed", failedAttempts: 1 });
        }),
        then.assert("Ada retries it, and it runs again from a fresh count", async (ctx) => {
          const retry = (routeId: string) =>
            behindBackofficeLayout(eventsAction)(
              formPost(ctx, ctx.vars.adaCookie, EVENTS_PAGE, {
                intent: "retry-route",
                eventId: EVENT_ID,
                routeId,
              }),
            );
          expect(await retry("forward")).toEqual({ ok: true });
          expect(await forwardRoute(ctx)).toMatchObject({ status: "pending" });
          expect(await retry("forward")).toEqual({
            ok: false,
            message: "Only a route that failed for good can be retried.",
          });

          await ctx.drain();
          expect(await forwardRoute(ctx)).toMatchObject({ status: "failed", failedAttempts: 1 });
          expect(await retry("unknown")).toEqual({
            ok: false,
            message: "Automation event has no route dispatch to retry for this route.",
          });
        }),
      ],
    }),
  );
});
