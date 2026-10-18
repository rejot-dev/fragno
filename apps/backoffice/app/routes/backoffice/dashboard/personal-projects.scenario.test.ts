import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import type { RouterContextProvider } from "react-router";
import { z } from "zod";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { behindBackofficeLayout } from "@/layouts/backoffice-layout.test-support";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { InMemoryApiObject } from "../../../../workers/api.do";
import { InMemoryAuthObject } from "../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../../workers/forms.do";
import { InMemoryOtpObject } from "../../../../workers/otp.do";
import { InMemoryTelegramObject } from "../../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../../workers/upload.do";
import { action as dashboardAction } from "./dashboard";

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

type PersonalProjectsVars = {
  adaSession: string;
  adaOrgId: string;
  adaCookie: string;
  adaId: string;
  beaSession: string;
  beaCookie: string;
  projectUrl: string;
};

type Ctx = BackofficeScenarioContext<PersonalProjectsVars>;

/** Builds the route arguments React Router passes for one signed-in browser request. */
function routeRequest(ctx: Ctx, cookie: string, path: string, form?: Record<string, string>) {
  const url = new URL(path, ORIGIN);
  const [, , , scopeKind, scopeId] = url.pathname.split("/").map(decodeURIComponent);
  assert(scopeKind && scopeId, `Expected a scoped page path, got ${path}`);
  const request = new Request(url, {
    method: form ? "POST" : "GET",
    headers: { cookie, origin: ORIGIN },
    body: form ? new URLSearchParams(form) : undefined,
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

/** The page scope of a request the shell let through. */
function openPage(ctx: Ctx, cookie: string, path: string) {
  return behindBackofficeLayout(async ({ context }: { context: Readonly<RouterContextProvider> }) =>
    requireScopeSelection(context),
  )(routeRequest(ctx, cookie, path));
}

async function rejection(promise: Promise<unknown>): Promise<Response> {
  const thrown = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  assert(thrown instanceof Response, `Expected a thrown Response, got ${String(thrown)}`);
  return thrown;
}

test("a user keeps projects in their personal workspace that nobody else can open", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Personal projects",
      vars: () => ({
        adaSession: "",
        adaOrgId: "",
        adaCookie: "",
        adaId: "",
        beaSession: "",
        beaCookie: "",
        projectUrl: "",
      }),
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "ada@example.test", captureSessionCookieAs: "adaSession" }),
        when.auth.createOrganization({
          cookie: ({ vars }) => vars.adaSession,
          name: "Ada",
          slug: "ada",
          captureOrganizationIdAs: "adaOrgId",
        }),
        when.auth.signUp({ email: "bea@example.test", captureSessionCookieAs: "beaSession" }),
        then.assert("Ada and Bea, a system administrator, sign in to Backoffice", async (ctx) => {
          const granted = await ctx.runtime.objects.auth
            .singleton()
            .commands.grantBackofficeAdminByEmail({ email: "bea@example.test" });
          assert(granted.status === "granted");
          const session = await authRequest(ctx, "/get-session", ctx.vars.adaSession);
          ctx.vars.adaId = z
            .object({ user: z.object({ id: z.string() }) })
            .parse(await session.json()).user.id;
          ctx.vars.adaCookie = await backofficeCookie(ctx, ctx.vars.adaSession);
          ctx.vars.beaCookie = await backofficeCookie(ctx, ctx.vars.beaSession);
        }),
        then.assert("Ada creates a project from her personal dashboard", async (ctx) => {
          const response = await behindBackofficeLayout(dashboardAction)(
            routeRequest(ctx, ctx.vars.adaCookie, `/backoffice/dashboard/user/${ctx.vars.adaId}`, {
              intent: "create-project",
              name: "Ledger",
            }),
          );
          assert(response instanceof Response);
          ctx.vars.projectUrl = `/backoffice/dashboard/project/user:${ctx.vars.adaId}:ledger`;
          expect(response.headers.get("location")).toBe(ctx.vars.projectUrl);
        }),
        then.assert("Ada opens the project by its slug", async (ctx) => {
          expect(await openPage(ctx, ctx.vars.adaCookie, ctx.vars.projectUrl)).toEqual({
            kind: "project",
            owner: { kind: "user", userId: ctx.vars.adaId },
            project: { id: expect.any(String), slug: "ledger" },
            label: "Ledger",
          });
        }),
        then.assert("the project does not belong to Ada's organization", async (ctx) => {
          const response = await rejection(
            openPage(ctx, ctx.vars.adaCookie, "/backoffice/dashboard/project/org:ada:ledger"),
          );
          assert(response.status === 404);
        }),
        then.assert("a system administrator cannot open Ada's project", async (ctx) => {
          const response = await rejection(openPage(ctx, ctx.vars.beaCookie, ctx.vars.projectUrl));
          assert(response.status === 404);
        }),
      ],
    }),
  );
});
