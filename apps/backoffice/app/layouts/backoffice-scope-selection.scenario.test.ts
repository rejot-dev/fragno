import { assert, expect, test, vi } from "vitest";

import { z } from "zod";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

// Observes project lookups so the scenario can count them per request.
vi.mock("@/routes/backoffice/automations/data.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/routes/backoffice/automations/data.server")>();
  return { ...actual, lookupAutomationProject: vi.fn(actual.lookupAutomationProject) };
});

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { lookupAutomationProject } from "@/routes/backoffice/automations/data.server";
import { loader as computersScopeLoader } from "@/routes/backoffice/computers/scope-layout";
import { loader as dashboardLoader } from "@/routes/backoffice/dashboard/dashboard";
import { loader as filesScopeLoader } from "@/routes/backoffice/files/scope-layout";
import { loader as integrationsScopeLoader } from "@/routes/backoffice/integrations/scope-layout";
import { loader as myListingsLoader } from "@/routes/backoffice/marketplace/my-listings";
import { loader as marketplaceScopeLoader } from "@/routes/backoffice/marketplace/scope-layout";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { establishBackofficeAuthenticatedRequest } from "./backoffice-authenticated-request.server";
import { establishBackofficeShellRequest } from "./backoffice-shell-request.server";

const origin = "https://backoffice.example";

type Vars = {
  adaCookie: string;
  graceCookie: string;
  orgId: string;
  adaId: string;
  graceId: string;
  launch: { id: string; slug: string };
  archived: { id: string; slug: string };
};
type Ctx = BackofficeScenarioContext<Vars>;

type SectionLoader = (args: never) => Promise<unknown>;

/** Each section page and the loaders React Router matches for it, outermost first. */
const pages = {
  integrations: { section: "integrations", leaf: "", loaders: [integrationsScopeLoader] },
  files: { section: "files", leaf: "", loaders: [filesScopeLoader] },
  computers: { section: "computers", leaf: "", loaders: [computersScopeLoader] },
  marketplace: { section: "marketplace", leaf: "", loaders: [marketplaceScopeLoader] },
  "my listings": {
    section: "marketplace",
    leaf: "/my-listings",
    loaders: [marketplaceScopeLoader, myListingsLoader],
  },
  dashboard: { section: "dashboard", leaf: "", loaders: [dashboardLoader] },
} satisfies Record<string, { section: string; leaf: string; loaders: SectionLoader[] }>;
type PageName = keyof typeof pages;

/**
 * Opens a page the way React Router does on the server: both Backoffice middlewares, then the
 * matched loaders in parallel within one request. A response thrown before the loaders replaces
 * the whole Backoffice layout; one thrown by a loader renders in the section, inside the shell.
 */
async function openPage(
  ctx: Ctx,
  pageName: PageName,
  scope: { kind: string; id: string; cookie: string },
) {
  const page = pages[pageName];
  const url = new URL(
    `${origin}/backoffice/${page.section}/${scope.kind}/${encodeURIComponent(scope.id)}${page.leaf}`,
  );
  const request = new Request(url, { headers: { cookie: scope.cookie } });
  const args = {
    request,
    url,
    params: { scopeKind: scope.kind, scopeId: scope.id },
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
  };
  const lookupsBefore = vi.mocked(lookupAutomationProject).mock.calls.length;
  let loaded: PromiseSettledResult<unknown>[] = [];
  try {
    await establishBackofficeAuthenticatedRequest(args, () =>
      establishBackofficeShellRequest(args, async () => {
        loaded = await Promise.allSettled(
          page.loaders.map((loader: SectionLoader) => loader(args as never)),
        );
        return new Response(null);
      }),
    );
  } catch (error) {
    assert(error instanceof Response, String(error));
    return { renders: "without-shell", status: error.status } as const;
  }
  const projectLookups = vi.mocked(lookupAutomationProject).mock.calls.length - lookupsBefore;
  const failure = loaded.find((result) => result.status === "rejected");
  if (failure) {
    assert(failure.reason instanceof Response, String(failure.reason));
    return { renders: "in-section", status: failure.reason.status, projectLookups } as const;
  }
  const [layout] = loaded;
  assert(layout?.status === "fulfilled");
  const { selectedScope } = z.object({ selectedScope: z.unknown() }).parse(layout.value);
  return { renders: "page", selectedScope, projectLookups } as const;
}

async function authRequest(ctx: Ctx, cookie: string, pathname: string, body?: unknown) {
  return await ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${origin}/api/auth${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin,
        cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function sessionUserId(ctx: Ctx, cookie: string) {
  const session = await authRequest(ctx, cookie, "/get-session");
  return z.object({ user: z.object({ id: z.string() }) }).parse(await session.json()).user.id;
}

/** Adds the Backoffice access token, whose claims carry the user's role, to a session cookie. */
async function withAccessToken(ctx: Ctx, cookie: string, organizationId: string | null) {
  const issued = await authRequest(
    ctx,
    cookie,
    "/backoffice-token",
    organizationId
      ? { selection: "required", organizationId }
      : { selection: "preferred", organizationId: null },
  );
  assert(issued.ok, await issued.clone().text());
  const accessToken = /fragno-backoffice\.access_token=([^;]+)/u.exec(
    issued.headers.get("set-cookie") ?? "",
  )?.[1];
  assert(accessToken);
  return `${cookie}; fragno-backoffice.access_token=${accessToken}`;
}

async function createProject(ctx: Ctx, name: string) {
  const response = await ctx.runtime.objects.automations.forOrg(ctx.vars.orgId).http.fetch(
    new Request(`${origin}/api/automations/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, createdByUserId: ctx.vars.adaId }),
    }),
  );
  assert(response.ok, await response.clone().text());
  return z.object({ id: z.string(), slug: z.string() }).parse(await response.json());
}

test("each section page selects the route's own scope, or reports a 404 inside the shell", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario<Vars>({
      name: "Backoffice route scope selection",
      objects: allLocalObjects,
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false" },
      vars: () => ({
        adaCookie: "",
        graceCookie: "",
        orgId: "",
        adaId: "",
        graceId: "",
        launch: { id: "", slug: "" },
        archived: { id: "", slug: "" },
      }),
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "ada@acme.test", captureSessionCookieAs: "adaCookie" }),
        when.auth.signUp({ email: "grace@admin.test", captureSessionCookieAs: "graceCookie" }),
        when.auth.createOrganization({
          cookie: ({ vars }) => vars.adaCookie,
          name: "Acme",
          slug: "acme",
          captureOrganizationIdAs: "orgId",
        }),
        then.assert(
          "Ada works in Acme with two projects, and Grace administers Backoffice",
          async (ctx) => {
            ctx.vars.adaId = await sessionUserId(ctx, ctx.vars.adaCookie);
            ctx.vars.graceId = await sessionUserId(ctx, ctx.vars.graceCookie);
            await ctx.runtime.objects.auth.singleton().commands.applyScenarioFixture({
              users: [
                {
                  id: ctx.vars.graceId,
                  email: "grace@admin.test",
                  role: "admin",
                  status: "active",
                },
              ],
            });
            ctx.vars.adaCookie = await withAccessToken(ctx, ctx.vars.adaCookie, ctx.vars.orgId);
            ctx.vars.graceCookie = await withAccessToken(ctx, ctx.vars.graceCookie, null);

            ctx.vars.launch = await createProject(ctx, "Launch");
            ctx.vars.archived = await createProject(ctx, "Retired");
            const archived = await ctx.runtime.objects.automations
              .forOrg(ctx.vars.orgId)
              .http.fetch(
                new Request(`${origin}/api/automations/projects/${ctx.vars.archived.id}`, {
                  method: "DELETE",
                }),
              );
            assert(archived.ok, await archived.clone().text());
          },
        ),
        then.assert("every section opens Ada's scopes with their labels", async (ctx) => {
          const acme = { id: ctx.vars.orgId, slug: "acme" };
          const ada = (kind: string, id: string) => ({ kind, id, cookie: ctx.vars.adaCookie });
          for (const pageName of Object.keys(pages) as PageName[]) {
            expect(await openPage(ctx, pageName, ada("org", "acme")), pageName).toEqual({
              renders: "page",
              selectedScope: { kind: "org", organization: acme, label: "Acme" },
              projectLookups: 0,
            });
            // The shell looks the project up by slug once, for the layout and the leaf alike.
            expect(
              await openPage(ctx, pageName, ada("project", `acme:${ctx.vars.launch.slug}`)),
              pageName,
            ).toEqual({
              renders: "page",
              selectedScope: {
                kind: "project",
                organization: acme,
                project: ctx.vars.launch,
                label: "Launch",
              },
              projectLookups: 1,
            });
            expect(await openPage(ctx, pageName, ada("user", ctx.vars.adaId)), pageName).toEqual({
              renders: "page",
              selectedScope: { kind: "user", userId: ctx.vars.adaId, label: "ada@acme.test" },
              projectLookups: 0,
            });
          }
        }),
        then.assert("scopes that do not resolve are 404s inside the shell", async (ctx) => {
          const ada = (kind: string, id: string) => ({ kind, id, cookie: ctx.vars.adaCookie });
          for (const pageName of Object.keys(pages) as PageName[]) {
            for (const scope of [
              ada("project", `acme:${ctx.vars.archived.slug}`),
              // Page URLs name projects by slug, not ID.
              ada("project", `acme:${ctx.vars.launch.id}`),
              ada("project", "acme:missing-project"),
              ada("org", "unknown-org"),
              ada("unknown-kind", "acme"),
              ada("user", ctx.vars.graceId),
            ]) {
              expect(await openPage(ctx, pageName, scope), `${pageName} ${scope.id}`).toMatchObject(
                { renders: "in-section", status: 404 },
              );
            }
          }
        }),
        then.assert(
          "System scope opens for Grace where its section has one, and is hidden from Ada",
          async (ctx) => {
            const grace = { kind: "system", id: "system", cookie: ctx.vars.graceCookie };
            for (const pageName of ["marketplace", "files", "integrations"] as const) {
              expect(await openPage(ctx, pageName, grace), pageName).toEqual({
                renders: "page",
                selectedScope: { kind: "system", label: "System" },
                projectLookups: 0,
              });
            }
            // Personal and organization listings have no System owner.
            expect(await openPage(ctx, "my listings", grace)).toMatchObject({
              renders: "in-section",
              status: 404,
            });
            expect(
              await openPage(ctx, "files", {
                kind: "system",
                id: "system",
                cookie: ctx.vars.adaCookie,
              }),
            ).toMatchObject({ renders: "in-section", status: 404 });
          },
        ),
        then.assert(
          "signed-out visitors are sent to sign in before any section runs",
          async (ctx) => {
            expect(await openPage(ctx, "files", { kind: "org", id: "acme", cookie: "" })).toEqual({
              renders: "without-shell",
              status: 302,
            });
          },
        ),
      ],
    }),
  );
});
