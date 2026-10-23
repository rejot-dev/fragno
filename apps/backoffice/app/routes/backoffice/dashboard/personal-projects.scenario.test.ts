import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { RouterContextProvider } from "react-router";
import { z } from "zod";

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
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
import type { DashboardCommandResult } from "../dashboard-terminal";
import { action as terminalCommandAction } from "../terminal-command";
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

/** Builds the route arguments React Router passes for one signed-in browser request. */
function routeRequest(
  ctx: BackofficeScenarioContext,
  cookie: string,
  path: string,
  form?: Record<string, string>,
) {
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

function authRequest(
  ctx: BackofficeScenarioContext,
  pathname: string,
  cookie: string,
  body?: unknown,
) {
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
async function backofficeCookie(ctx: BackofficeScenarioContext, session: string): Promise<string> {
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
function openPage(ctx: BackofficeScenarioContext, cookie: string, path: string) {
  return behindBackofficeLayout(async ({ context }: { context: Readonly<RouterContextProvider> }) =>
    requireScopeSelection(context),
  )(routeRequest(ctx, cookie, path));
}

/** Runs a command in the terminal of the scope a terminal page path names. */
async function runTerminal(
  ctx: BackofficeScenarioContext,
  cookie: string,
  path: string,
  command: string,
) {
  return (await behindBackofficeLayout(terminalCommandAction)(
    routeRequest(ctx, cookie, path, { intent: "run-command", cwd: "/", command }),
  )) as DashboardCommandResult;
}

/** The permissions deferred work, such as a workflow, has as the user in the scope. */
async function deferredPermissions(
  ctx: BackofficeScenarioContext,
  userId: string,
  scope: BackofficeContextScope,
) {
  const execution = createBackofficeUserExecution({ scope, userId });
  assert(execution.actors.principal);
  return await ctx.runtime.services.authorityResolver.resolvePrincipalPermissions({
    principal: execution.actors.principal,
    execution,
  });
}

/** The `review.forwarded` events stored in the scope. */
async function forwardedEvents(ctx: BackofficeScenarioContext, scope: BackofficeContextScope) {
  const { events } = await ctx.runtime.objects.automations
    .for(scope)
    .commands.listEventsOfType({ source: "custom", eventType: "review.forwarded", cursor: null });
  return events;
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
    defineBackofficeScenario<PersonalProjectsVars>({
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

type MemberWorkspaceVars = {
  adaSession: string;
  adaCookie: string;
  adaId: string;
  beaSession: string;
  beaCookie: string;
  beaId: string;
  cyCookie: string;
  cyId: string;
  acmeId: string;
  invitationId: string;
};

test("an organization's owners and admins work in its members' personal workspaces", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario<MemberWorkspaceVars>({
      objects: scenarioObjects,
      name: "Member workspaces",
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false" },
      vars: () => ({
        adaSession: "",
        adaCookie: "",
        adaId: "",
        beaSession: "",
        beaCookie: "",
        beaId: "",
        cyCookie: "",
        cyId: "",
        acmeId: "",
        invitationId: "",
      }),
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "ada@example.test", captureSessionCookieAs: "adaSession" }),
        when.auth.signUp({ email: "bea@example.test", captureSessionCookieAs: "beaSession" }),
        when.auth.signUp({ email: "cy@example.test", captureSessionCookieAs: "cyCookie" }),
        when.auth.createOrganization({
          cookie: ({ vars }) => vars.adaSession,
          name: "Acme",
          slug: "acme",
          captureOrganizationIdAs: "acmeId",
        }),
        when.auth.inviteMember({
          cookie: ({ vars }) => vars.adaSession,
          organizationId: ({ vars }) => vars.acmeId,
          email: "bea@example.test",
          captureInvitationIdAs: "invitationId",
        }),
        when.auth.acceptInvitation({
          cookie: ({ vars }) => vars.beaSession,
          invitationId: ({ vars }) => vars.invitationId,
        }),
        then.assert("Ada owns Acme, Bea is its member, and Cy is neither", async (ctx) => {
          for (const [session, id] of [
            [ctx.vars.adaSession, "adaId"],
            [ctx.vars.beaSession, "beaId"],
            [ctx.vars.cyCookie, "cyId"],
          ] as const) {
            const response = await authRequest(ctx, "/get-session", session);
            ctx.vars[id] = z
              .object({ user: z.object({ id: z.string() }) })
              .parse(await response.json()).user.id;
          }
          ctx.vars.adaCookie = await backofficeCookie(ctx, ctx.vars.adaSession);
          ctx.vars.beaCookie = await backofficeCookie(ctx, ctx.vars.beaSession);
          ctx.vars.cyCookie = await backofficeCookie(ctx, ctx.vars.cyCookie);
        }),
        then.assert("Ada opens Bea's personal dashboard, named for Bea", async (ctx) => {
          expect(
            await openPage(ctx, ctx.vars.adaCookie, `/backoffice/dashboard/user/${ctx.vars.beaId}`),
          ).toEqual({
            kind: "user",
            userId: ctx.vars.beaId,
            label: "bea@example.test",
          });
        }),
        then.assert("Ada creates a project in Bea's personal workspace", async (ctx) => {
          const response = await behindBackofficeLayout(dashboardAction)(
            routeRequest(ctx, ctx.vars.adaCookie, `/backoffice/dashboard/user/${ctx.vars.beaId}`, {
              intent: "create-project",
              name: "Taxes",
            }),
          );
          assert(response instanceof Response);
          expect(response.headers.get("location")).toBe(
            `/backoffice/dashboard/project/user:${ctx.vars.beaId}:taxes`,
          );
        }),
        then.assert("Bea finds the project in her own workspace", async (ctx) => {
          expect(
            await openPage(
              ctx,
              ctx.vars.beaCookie,
              `/backoffice/dashboard/project/user:${ctx.vars.beaId}:taxes`,
            ),
          ).toMatchObject({ kind: "project", project: { slug: "taxes" }, label: "Taxes" });
        }),
        then.assert("Ada's terminal in Bea's workspace lists Bea's projects", async (ctx) => {
          const result = await runTerminal(
            ctx,
            ctx.vars.adaCookie,
            `/backoffice/terminal/user/${ctx.vars.beaId}`,
            "projects.list --format json",
          );
          assert.isTrue(result.ok, result.output);
          const { projects } = z
            .object({ projects: z.array(z.object({ slug: z.string() })) })
            .parse(JSON.parse(result.output));
          expect(projects.map(({ slug }) => slug)).toEqual(["taxes"]);
        }),
        then.assert(
          "a member cannot open their administrator's personal workspace",
          async (ctx) => {
            const response = await rejection(
              openPage(ctx, ctx.vars.beaCookie, `/backoffice/dashboard/user/${ctx.vars.adaId}`),
            );
            assert(response.status === 404);
          },
        ),
        then.assert("someone outside Acme cannot open Bea's personal workspace", async (ctx) => {
          const response = await rejection(
            openPage(
              ctx,
              ctx.vars.cyCookie,
              `/backoffice/dashboard/project/user:${ctx.vars.beaId}:taxes`,
            ),
          );
          assert(response.status === 404);
        }),
        then.assert("Ada's deferred work in Bea's workspace acts as Bea would", async (ctx) => {
          expect(
            await deferredPermissions(ctx, ctx.vars.adaId, {
              kind: "user",
              userId: ctx.vars.beaId,
            }),
          ).toContainEqual(BACKOFFICE_PERMISSION.projects.create);
        }),
        then.assert(
          "Bea forwards events from Acme into her own workspace, but not into Cy's",
          async (ctx) => {
            const exchange = await authRequest(ctx, "/backoffice-token", ctx.vars.beaSession, {
              selection: "required",
              organizationId: ctx.vars.acmeId,
            });
            assert(exchange.ok, await exchange.clone().text());
            const acmeCookie = [
              ctx.vars.beaSession,
              ...exchange.headers.getSetCookie().map((header) => header.split(";", 1)[0]),
            ].join("; ");
            const fire = (userId: string) =>
              runTerminal(
                ctx,
                acmeCookie,
                "/backoffice/terminal/org/acme",
                `events.fire --source custom --event-type review.forwarded --target-scope-json '${JSON.stringify({ kind: "user", userId })}' --format json`,
              );
            const own = await fire(ctx.vars.beaId);
            assert.isTrue(own.ok, own.output);
            const foreign = await fire(ctx.vars.cyId);
            assert.isFalse(foreign.ok, foreign.output);
            expect(
              await forwardedEvents(ctx, { kind: "user", userId: ctx.vars.beaId }),
            ).toHaveLength(1);
            expect(await forwardedEvents(ctx, { kind: "user", userId: ctx.vars.cyId })).toEqual([]);
          },
        ),
        then.assert("Ada forwards events from Bea's workspace into Bea's project", async (ctx) => {
          const project = await openPage(
            ctx,
            ctx.vars.adaCookie,
            `/backoffice/dashboard/project/user:${ctx.vars.beaId}:taxes`,
          );
          assert(project.kind === "project");
          const projectScope = {
            kind: "project" as const,
            owner: { kind: "user" as const, userId: ctx.vars.beaId },
            projectId: project.project.id,
          };
          const result = await runTerminal(
            ctx,
            ctx.vars.adaCookie,
            `/backoffice/terminal/user/${ctx.vars.beaId}`,
            `events.fire --source custom --event-type review.forwarded --target-scope-json '${JSON.stringify(projectScope)}' --format json`,
          );
          assert.isTrue(result.ok, result.output);
          expect(await forwardedEvents(ctx, projectScope)).toHaveLength(1);
        }),
        when.auth.removeMember({
          orgId: ({ vars }) => vars.acmeId,
          userId: ({ vars }) => vars.beaId,
        }),
        then.assert(
          "once Bea leaves Acme, Ada can no longer open, change, or work in her workspace",
          async (ctx) => {
            expect(
              await deferredPermissions(ctx, ctx.vars.adaId, {
                kind: "user",
                userId: ctx.vars.beaId,
              }),
            ).toEqual([]);
            const opened = await rejection(
              openPage(ctx, ctx.vars.adaCookie, `/backoffice/dashboard/user/${ctx.vars.beaId}`),
            );
            assert(opened.status === 404);
            const created = await rejection(
              behindBackofficeLayout(dashboardAction)(
                routeRequest(
                  ctx,
                  ctx.vars.adaCookie,
                  `/backoffice/dashboard/user/${ctx.vars.beaId}`,
                  { intent: "create-project", name: "Audit" },
                ),
              ),
            );
            assert(created.status === 404);
            const listed = await rejection(
              runTerminal(
                ctx,
                ctx.vars.adaCookie,
                `/backoffice/terminal/user/${ctx.vars.beaId}`,
                "projects.list",
              ),
            );
            assert(listed.status === 404);
          },
        ),
      ],
    }),
  );
});
