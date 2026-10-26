import { assert, expect, test, vi } from "vitest";

import { z } from "zod";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import {
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { loader as dashboardLoader } from "@/routes/backoffice/dashboard/dashboard";
import { loader as organizationLayoutLoader } from "@/routes/backoffice/organization-layout";
import { loader as organizationMembersLoader } from "@/routes/backoffice/organization-members";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { establishBackofficeAuthenticatedRequest } from "./backoffice-authenticated-request.server";
import {
  createAutomationProject,
  sessionUserId,
  withBackofficeAccessToken,
} from "./backoffice-layout.test-support";
import { establishBackofficeShellRequest } from "./backoffice-shell-request.server";

const origin = "https://backoffice.example";

type Vars = {
  adaCookie: string;
  bobCookie: string;
  cleoCookie: string;
  adaId: string;
  bobId: string;
  cleoId: string;
  agencyId: string;
  clientId: string;
  books: { id: string; slug: string };
};
type Ctx = BackofficeScenarioContext<Vars>;

/**
 * Loads a Backoffice page as React Router does on the server: both Backoffice middlewares, then
 * the page's loader. A response thrown before the loader replaces the whole layout.
 */
async function load(
  ctx: Ctx,
  input: {
    path: string;
    params: Record<string, string>;
    loader: (args: never) => Promise<unknown>;
    cookie: string;
  },
) {
  const url = new URL(`${origin}${input.path}`);
  const request = new Request(url, { headers: { cookie: input.cookie } });
  const args = {
    request,
    url,
    params: input.params,
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
  };
  // Assigned inside the middleware chain, which TypeScript cannot follow.
  let loaded = null as PromiseSettledResult<unknown> | null;
  try {
    await establishBackofficeAuthenticatedRequest(args, () =>
      establishBackofficeShellRequest(args, async () => {
        [loaded] = await Promise.allSettled([input.loader(args as never)]);
        return new Response(null);
      }),
    );
  } catch (error) {
    assert(error instanceof Response, String(error));
    return { status: error.status } as const;
  }
  assert(loaded);
  if (loaded.status === "rejected") {
    assert(loaded.reason instanceof Response, String(loaded.reason));
    return { status: loaded.reason.status } as const;
  }
  return { status: 200, data: loaded.value } as const;
}

/** The dashboard of a scope, named as its URL names it: `org` with a slug, `user` with an id. */
async function openDashboard(ctx: Ctx, cookie: string, scope: { kind: string; id: string }) {
  const opened = await load(ctx, {
    path: `/backoffice/dashboard/${scope.kind}/${encodeURIComponent(scope.id)}`,
    params: { scopeKind: scope.kind, scopeId: scope.id },
    loader: dashboardLoader,
    cookie,
  });
  if (opened.status !== 200) {
    return opened.status;
  }
  return z.object({ selectedScope: z.object({ label: z.string() }) }).parse(opened.data)
    .selectedScope.label;
}

/** Whether Auth issues the user a credential in the organization, as switching to it does. */
async function issuesCredential(ctx: Ctx, cookie: string, organizationId: string) {
  const response = await ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${origin}/api/auth/backoffice-token`, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify({ selection: "required", organizationId }),
    }),
  );
  return response.ok;
}

/**
 * What deferred work, such as a workflow run, may do for the user in the organization: it carries no
 * credential, so Auth's current state decides.
 */
async function deferredPermissions(ctx: Ctx, userId: string, organizationId: string) {
  const execution = createBackofficeUserExecution({
    scope: { kind: "org", orgId: organizationId, jurisdiction: null },
    userId,
  });
  assert(execution.actors.principal);
  const permissions = await ctx.runtime.services.authorityResolver.resolvePrincipalPermissions({
    principal: execution.actors.principal,
    execution,
  });
  return permissions.map(({ namespace, permission }) => `${namespace}.${permission}`);
}

async function runSystemCommand(ctx: Ctx, command: string) {
  const { bash } = await createInteractiveBashHost({
    context: createCodemodeRouteBackedRuntimeContext({
      emitter: { kind: "caller" },
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      execution: createBackofficeSystemExecution({ kind: "system" }),
    }),
  });
  const result = await bash.exec(command);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout;
}

/** Who acts in the organization, as its settings pages show the user. */
async function organizationRelations(ctx: Ctx, cookie: string, orgSlug: string) {
  const opened = await load(ctx, {
    path: `/backoffice/organizations/${orgSlug}`,
    params: { orgSlug },
    loader: organizationLayoutLoader,
    cookie,
  });
  assert(opened.status === 200, `Opening ${orgSlug}'s settings answered ${opened.status}.`);
  return z
    .object({
      relations: z.object({
        memberCount: z.number(),
        managingOrganization: z.object({ slug: z.string() }).nullable(),
        managedOrganizations: z.array(z.object({ slug: z.string(), memberCount: z.number() })),
      }),
    })
    .parse(opened.data).relations;
}

test("an agency's members act in the organizations it manages until management ends", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario<Vars>({
      name: "Backoffice managed organizations",
      objects: allLocalObjects,
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false" },
      vars: () => ({
        adaCookie: "",
        bobCookie: "",
        cleoCookie: "",
        adaId: "",
        bobId: "",
        cleoId: "",
        agencyId: "",
        clientId: "",
        books: { id: "", slug: "" },
      }),
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "ada@agency.test", captureSessionCookieAs: "adaCookie" }),
        when.auth.signUp({ email: "bob@agency.test", captureSessionCookieAs: "bobCookie" }),
        when.auth.signUp({ email: "cleo@client.test", captureSessionCookieAs: "cleoCookie" }),
        when.auth.createOrganization({
          cookie: ({ vars }) => vars.adaCookie,
          name: "Agency",
          slug: "agency",
          captureOrganizationIdAs: "agencyId",
        }),
        when.auth.createOrganization({
          cookie: ({ vars }) => vars.cleoCookie,
          name: "Client",
          slug: "client",
          captureOrganizationIdAs: "clientId",
        }),
        then.assert(
          "Ada owns the Agency, where Bob is a member, and Cleo owns the Client",
          async (ctx) => {
            ctx.vars.adaId = await sessionUserId(ctx, ctx.vars.adaCookie);
            ctx.vars.bobId = await sessionUserId(ctx, ctx.vars.bobCookie);
            ctx.vars.cleoId = await sessionUserId(ctx, ctx.vars.cleoCookie);
            await ctx.runtime.objects.auth.singleton().commands.applyScenarioFixture({
              members: [
                { organizationId: ctx.vars.agencyId, userId: ctx.vars.bobId, roles: ["member"] },
              ],
            });
            ctx.vars.books = await createAutomationProject(ctx, {
              orgId: ctx.vars.clientId,
              name: "Books",
              createdByUserId: ctx.vars.cleoId,
            });
            assert(!(await issuesCredential(ctx, ctx.vars.adaCookie, ctx.vars.clientId)));
          },
        ),
        then.assert("a system administrator makes the Agency manage the Client", async (ctx) => {
          await runSystemCommand(ctx, "admin.org.manager.set --org client --manager agency");
          expect(await runSystemCommand(ctx, "admin.org.get --org client")).toContain(
            "Managed by: Agency (agency)",
          );
        }),
        then.assert(
          "Ada acts in the Client as an admin, in its projects and in Cleo's personal scope",
          async (ctx) => {
            const me = await ctx.runtime.objects.auth
              .singleton()
              .commands.getBackofficeMe({ userId: ctx.vars.adaId, activeOrganizationId: null });
            expect(
              me?.organizations.map(({ organization, roles, through }) => ({
                slug: organization.slug,
                roles,
                through,
              })),
            ).toEqual([
              { slug: "agency", roles: ["owner"], through: { kind: "membership" } },
              {
                slug: "client",
                roles: ["admin"],
                through: {
                  kind: "managing-organization",
                  organization: { id: ctx.vars.agencyId, name: "Agency", slug: "agency" },
                },
              },
            ]);

            ctx.vars.adaCookie = await withBackofficeAccessToken(
              ctx,
              ctx.vars.adaCookie,
              ctx.vars.clientId,
            );
            assert(
              (await openDashboard(ctx, ctx.vars.adaCookie, { kind: "org", id: "client" })) ===
                "Client",
            );
            assert(
              (await openDashboard(ctx, ctx.vars.adaCookie, {
                kind: "project",
                id: `org:client:${ctx.vars.books.slug}`,
              })) === "Books",
            );
            assert(
              (await openDashboard(ctx, ctx.vars.adaCookie, {
                kind: "user",
                id: ctx.vars.cleoId,
              })) === "cleo@client.test",
            );

            // The Client's members page is where Ada finds the personal scopes she may open.
            const members = await load(ctx, {
              path: "/backoffice/organizations/client/members",
              params: { orgSlug: "client" },
              loader: organizationMembersLoader,
              cookie: ctx.vars.adaCookie,
            });
            assert(members.status === 200);
            expect(
              z
                .object({ members: z.array(z.object({ user: z.object({ email: z.string() }) })) })
                .parse(members.data)
                .members.map(({ user }) => user.email),
            ).toEqual(["cleo@client.test"]);

            expect(await deferredPermissions(ctx, ctx.vars.adaId, ctx.vars.clientId)).toEqual(
              expect.arrayContaining(["projects.create", "org.read", "org.manage"]),
            );
            // What org.get answers her in the Client: only its own owners own it.
            const membership = await ctx.runtime.objects.auth
              .singleton()
              .commands.getOrganizationMembership({
                organizationId: ctx.vars.clientId,
                userId: ctx.vars.adaId,
              });
            expect(membership?.roles).toEqual(["admin"]);

            // Her settings pages list the Agency's client, and the Client says who manages it.
            const [adaSession] = ctx.vars.adaCookie.split("; fragno-backoffice.access_token=");
            const adaInAgency = await withBackofficeAccessToken(
              ctx,
              adaSession!,
              ctx.vars.agencyId,
            );
            expect(await organizationRelations(ctx, adaInAgency, "agency")).toEqual({
              memberCount: 2,
              managingOrganization: null,
              managedOrganizations: [expect.objectContaining({ slug: "client", memberCount: 1 })],
            });
            expect(await organizationRelations(ctx, ctx.vars.adaCookie, "client")).toEqual({
              memberCount: 1,
              managingOrganization: { slug: "agency" },
              managedOrganizations: [],
            });
            // Cleo's workspace says whose it is and which organization lets Ada in.
            expect(
              await ctx.runtime.objects.auth.singleton().commands.findAdministeredMember({
                administratorId: ctx.vars.adaId,
                memberId: ctx.vars.cleoId,
              }),
            ).toEqual({
              userId: ctx.vars.cleoId,
              jurisdiction: null,
              name: expect.any(String),
              email: "cleo@client.test",
              organization: { id: ctx.vars.clientId, name: "Client", slug: "client" },
            });
          },
        ),
        then.assert(
          "Bob acts in the Client as a member, which reaches no one's personal scope",
          async (ctx) => {
            ctx.vars.bobCookie = await withBackofficeAccessToken(
              ctx,
              ctx.vars.bobCookie,
              ctx.vars.clientId,
            );
            assert(
              (await openDashboard(ctx, ctx.vars.bobCookie, { kind: "org", id: "client" })) ===
                "Client",
            );
            assert(
              (await openDashboard(ctx, ctx.vars.bobCookie, {
                kind: "user",
                id: ctx.vars.cleoId,
              })) === 404,
            );

            const permissions = await deferredPermissions(ctx, ctx.vars.bobId, ctx.vars.clientId);
            expect(permissions).toEqual(expect.arrayContaining(["projects.create", "org.read"]));
            expect(permissions).not.toContain("org.manage");
          },
        ),
        then.assert(
          "managing goes one way: the Client's members stay out of the Agency",
          async (ctx) => {
            ctx.vars.cleoCookie = await withBackofficeAccessToken(
              ctx,
              ctx.vars.cleoCookie,
              ctx.vars.clientId,
            );
            assert(!(await issuesCredential(ctx, ctx.vars.cleoCookie, ctx.vars.agencyId)));
            assert(
              (await openDashboard(ctx, ctx.vars.cleoCookie, {
                kind: "user",
                id: ctx.vars.adaId,
              })) === 404,
            );
            // Her members page lists the Client's own members: the Agency's are not among them.
            const members = await load(ctx, {
              path: "/backoffice/organizations/client/members",
              params: { orgSlug: "client" },
              loader: organizationMembersLoader,
              cookie: ctx.vars.cleoCookie,
            });
            expect(members).toMatchObject({
              status: 200,
              data: {
                members: [{ userId: ctx.vars.cleoId, roles: ["owner"] }],
                page: 1,
                total: 1,
                totalPages: 1,
              },
            });
            // She sees who manages the Client, though its people are not her members.
            expect(
              (await organizationRelations(ctx, ctx.vars.cleoCookie, "client"))
                .managingOrganization,
            ).toEqual({ slug: "agency" });
          },
        ),
        then.assert("ending management takes the Client away from Ada", async (ctx) => {
          await runSystemCommand(ctx, "admin.org.manager.clear --org client");
          assert(!(await issuesCredential(ctx, ctx.vars.adaCookie, ctx.vars.clientId)));
          // Her credential for the Client is unexpired, but pages follow the organizations she
          // acts in now: they send her to get a credential in one she still does.
          assert(
            (await openDashboard(ctx, ctx.vars.adaCookie, { kind: "org", id: "client" })) === 302,
          );
          const [session] = ctx.vars.adaCookie.split("; fragno-backoffice.access_token=");
          ctx.vars.adaCookie = await withBackofficeAccessToken(ctx, session!, null);
          assert(
            (await openDashboard(ctx, ctx.vars.adaCookie, { kind: "org", id: "client" })) === 404,
          );
          assert(
            (await openDashboard(ctx, ctx.vars.adaCookie, {
              kind: "user",
              id: ctx.vars.cleoId,
            })) === 404,
          );
          expect(await deferredPermissions(ctx, ctx.vars.adaId, ctx.vars.clientId)).toEqual([]);
        }),
        then.assert(
          "an agency with more clients than one page of Auth rows lists every one",
          async (ctx) => {
            const auth = ctx.runtime.objects.auth.singleton().commands;
            const clients = Array.from({ length: 101 }, (_, index) => ({
              id: `client-${index}`,
              name: `Client ${index}`,
              slug: `client-${index}`,
              ownerUserId: ctx.vars.cleoId,
              ownerRoles: ["owner"],
            }));
            await auth.applyScenarioFixture({ organizations: clients });
            for (const client of clients) {
              await auth.setOrganizationManager({
                organizationId: client.id,
                managingOrganizationId: ctx.vars.agencyId,
              });
            }

            const me = await auth.getBackofficeMe({
              userId: ctx.vars.adaId,
              activeOrganizationId: null,
            });
            expect(me?.organizations).toHaveLength(102);
            expect(await auth.listAccountOrganizations({ userId: ctx.vars.adaId })).toHaveLength(
              102,
            );
            // Every page loads her organizations first.
            assert(
              (await openDashboard(ctx, ctx.vars.adaCookie, { kind: "org", id: "agency" })) ===
                "Agency",
            );
          },
        ),
      ],
    }),
  );
});
