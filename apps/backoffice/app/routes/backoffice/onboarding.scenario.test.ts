import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { RouterContextProvider } from "react-router";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { behindBackofficeLayout } from "@/layouts/backoffice-layout.test-support";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { ApiObject } from "../../../workers/api-object";
import { AppInstallationsObject } from "../../../workers/app-installations-object";
import { AppsObject } from "../../../workers/apps-object";
import { AuthObject } from "../../../workers/auth-object";
import { AutomationsObject } from "../../../workers/automations-object";
import { FormsObject } from "../../../workers/forms-object";
import { OtpObject } from "../../../workers/otp-object";
import { UploadObject } from "../../../workers/upload-object";
import { loader as installLoader } from "./app-install";
import { action as onboardingAction, loader as onboardingLoader } from "./onboarding";
import { buildBackofficeOnboardingPath } from "./onboarding-path";
import { action as clientsAction } from "./organization-clients";

const ORIGIN = "https://backoffice.example";
const ONBOARDING = "/backoffice/onboarding";

const scenarioObjects = {
  // Creating an organization starts its workspace, which these serve.
  API: (input) => new ApiObject(input),
  FORMS: (input) => new FormsObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  OTP: (input) => new OtpObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

// As in local development: accounts sign in without verifying their email.
const env = { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_INVITATIONS_ENABLED: "false" };

/** The route arguments React Router passes for one signed-in browser request. */
function routeRequest(
  ctx: BackofficeScenarioContext,
  cookie: string,
  path: string,
  params: Record<string, string>,
  form?: URLSearchParams,
) {
  const url = new URL(path, ORIGIN);
  const request = new Request(url, {
    method: form ? "POST" : "GET",
    headers: { cookie, origin: ORIGIN },
    body: form,
  });
  return {
    request,
    url,
    params,
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
  };
}

/** Where a request is sent instead of answered, whether its handler returns or throws that. */
async function redirection(handled: Promise<unknown>) {
  let response: unknown;
  try {
    response = await handled;
  } catch (error) {
    response = error;
  }
  assert(response instanceof Response && response.status === 302, `Expected a redirect.`);
  return { location: response.headers.get("location") };
}

/** Signs a session in to Backoffice, as the browser does before loading any page. */
async function backofficeCookie(ctx: BackofficeScenarioContext, session: string) {
  const exchange = await ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${ORIGIN}/api/auth/backoffice-token`, {
      method: "POST",
      headers: { cookie: session, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ selection: "preferred" }),
    }),
  );
  assert(exchange.ok, await exchange.clone().text());
  return withCookies(
    session,
    exchange.headers.getSetCookie().map((header) => header.split(";", 1)[0]),
  );
}

/** The cookie header after a response sets cookies, each replacing the one of its name. */
function withCookies(cookie: string, cookies: readonly string[]) {
  const named = new Map(
    [...cookie.split("; "), ...cookies].map((entry) => [entry.split("=", 1)[0], entry] as const),
  );
  return [...named.values()].join("; ");
}

/**
 * The scope a dashboard page opens, following the shell's redirects that reissue the browser's
 * token, as a browser does. The cookie the page opened with is returned for later requests.
 */
async function openDashboard(
  ctx: BackofficeScenarioContext,
  cookie: string,
  scope: { scopeKind: string; scopeId: string },
) {
  const path = `/backoffice/dashboard/${scope.scopeKind}/${encodeURIComponent(scope.scopeId)}`;
  const open = behindBackofficeLayout(
    async ({ context }: { context: Readonly<RouterContextProvider> }) =>
      requireScopeSelection(context),
  );
  let current = cookie;
  for (let reissued = 0; reissued < 3; reissued += 1) {
    try {
      return { selection: await open(routeRequest(ctx, current, path, scope)), cookie: current };
    } catch (error) {
      // Only a reissued token returns to the page; anything else sends the browser elsewhere.
      if (!(error instanceof Response) || error.headers.get("location") !== path) {
        throw error;
      }
      current = withCookies(
        current,
        error.headers.getSetCookie().map((header) => header.split(";", 1)[0]),
      );
    }
  }
  throw new Error(`The shell kept reissuing the token for ${path}.`);
}

/** Opens onboarding at `path`, which may name where it returns to once complete. */
async function openOnboarding(ctx: BackofficeScenarioContext, cookie: string, path: string) {
  return await onboardingLoader(routeRequest(ctx, cookie, path, {}) as never);
}

/**
 * Answers the question the onboarding page at `path` asks, which it shows only once the workflow
 * asks it, then lets the workflow take the answer. The page reloads before the workflow takes it,
 * and shows setup under way until then.
 */
async function answerOnboarding(
  ctx: BackofficeScenarioContext,
  cookie: string,
  path: string,
  answer: Record<string, string | readonly string[]>,
) {
  expect(await openOnboarding(ctx, cookie, path)).toMatchObject({
    state: { status: "asking", prompt: { question: answer.question } },
  });
  const form = new URLSearchParams();
  for (const [name, value] of Object.entries(answer)) {
    for (const entry of typeof value === "string" ? [value] : value) {
      form.append(name, entry);
    }
  }
  const sent = await redirection(
    onboardingAction(routeRequest(ctx, cookie, path, {}, form) as never),
  );
  assert(sent.location === path);
  expect(await openOnboarding(ctx, cookie, path)).toMatchObject({
    state: { status: "setting-up" },
  });
  await ctx.drain();
}

async function authUser(ctx: BackofficeScenarioContext, cookie: string) {
  const session = await ctx.runtime.objects.auth
    .singleton()
    .http.fetch(new Request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie } }));
  const { user } = (await session.json()) as { user: { id: string } };
  const me = await ctx.runtime.objects.auth
    .singleton()
    .commands.getBackofficeMe({ userId: user.id, activeOrganizationId: null });
  assert(me);
  return me;
}

test("someone using Backoffice on their own chooses where their workspace is kept", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Personal onboarding",
      env,
      vars: () => ({ session: "", cookie: "", userId: "", otherSession: "" }),
      steps: ({ when, then }) => [
        when.auth.signUp({
          email: "ada@example.test",
          onboarding: "pending",
          captureSessionCookieAs: "session",
        }),
        then.assert("Backoffice opens onboarding in place of the dashboard", async (ctx) => {
          ctx.vars.cookie = await backofficeCookie(ctx, ctx.vars.session);
          ctx.vars.userId = (await authUser(ctx, ctx.vars.cookie)).user.id;
          const dashboard = await redirection(
            openDashboard(ctx, ctx.vars.cookie, { scopeKind: "user", scopeId: ctx.vars.userId }),
          );
          assert(dashboard.location === "/backoffice/onboarding");
          // Opening onboarding starts its workflow, which asks once it runs.
          expect(await openOnboarding(ctx, ctx.vars.cookie, ONBOARDING)).toMatchObject({
            state: { status: "setting-up" },
          });
          await ctx.drain();
          expect(await openOnboarding(ctx, ctx.vars.cookie, ONBOARDING)).toEqual({
            state: { status: "asking", prompt: { question: "usage" } },
            email: "ada@example.test",
            memberOf: [],
          });
        }),
        then.assert("they use it on their own, so nothing else is set up", async (ctx) => {
          await answerOnboarding(ctx, ctx.vars.cookie, ONBOARDING, {
            question: "usage",
            usage: "personal",
          });
          expect(await openOnboarding(ctx, ctx.vars.cookie, ONBOARDING)).toMatchObject({
            state: { status: "asking", prompt: { question: "jurisdiction" } },
          });
        }),
        then.assert("they keep their data in the EU", async (ctx) => {
          await answerOnboarding(ctx, ctx.vars.cookie, ONBOARDING, {
            question: "jurisdiction",
            jurisdiction: "eu",
          });
          const me = await authUser(ctx, ctx.vars.cookie);
          expect(me.user).toMatchObject({ jurisdiction: "eu", onboardedAt: expect.any(Date) });
          expect(me.organizations).toEqual([]);
          expect(await redirection(openOnboarding(ctx, ctx.vars.cookie, ONBOARDING))).toMatchObject(
            {
              location: "/backoffice",
            },
          );
        }),
        then.assert("their workspace is the one kept in the EU", async (ctx) => {
          const dashboard = await openDashboard(ctx, ctx.vars.cookie, {
            scopeKind: "user",
            scopeId: ctx.vars.userId,
          });
          expect(dashboard.selection).toEqual({
            kind: "user",
            userId: ctx.vars.userId,
            jurisdiction: "eu",
            label: "ada@example.test",
          });
        }),
        when.auth.signUp({
          email: "alan@example.test",
          onboarding: "pending",
          captureSessionCookieAs: "otherSession",
        }),
        then.assert(
          "someone onboarding after her names their organization after choosing where it is kept",
          async (ctx) => {
            const cookie = await backofficeCookie(ctx, ctx.vars.otherSession);
            await openOnboarding(ctx, cookie, ONBOARDING);
            await ctx.drain();
            await answerOnboarding(ctx, cookie, ONBOARDING, {
              question: "usage",
              usage: "organization",
            });
            await answerOnboarding(ctx, cookie, ONBOARDING, {
              question: "jurisdiction",
              jurisdiction: "us",
            });
            expect(await openOnboarding(ctx, cookie, ONBOARDING)).toMatchObject({
              state: { status: "asking", prompt: { question: "organization-name" } },
            });
            await answerOnboarding(ctx, cookie, ONBOARDING, {
              question: "organization-name",
              name: "Turing Labs",
            });
            const me = await authUser(ctx, cookie);
            expect(me.user).toMatchObject({ jurisdiction: "us", onboardedAt: expect.any(Date) });
            expect(
              me.organizations.map(({ organization, roles }) => ({
                slug: organization.slug,
                jurisdiction: organization.jurisdiction,
                roles,
              })),
            ).toEqual([{ slug: "turing-labs", jurisdiction: "us", roles: ["owner"] }]);
          },
        ),
        then.assert(
          "the organization's own automations, kept in the US, hear that it was created",
          async (ctx) => {
            const cookie = await backofficeCookie(ctx, ctx.vars.otherSession);
            const [{ organization }] = (await authUser(ctx, cookie)).organizations;
            await ctx.drain();
            const created = await ctx.runtime.objects.automations
              .for({ kind: "org", orgId: organization.id, jurisdiction: "us" })
              .commands.listEventsOfType({
                source: "auth",
                eventType: "organization.created",
                cursor: null,
              });
            expect(created.events.map(({ subject }) => subject)).toEqual([
              { scope: { kind: "org", orgId: organization.id, jurisdiction: "us" } },
            ]);
          },
        ),
      ],
    }),
  );
});

test("an agency sets up its clients, all kept where it chose, and adds clients later", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Agency onboarding",
      env,
      vars: () => ({ session: "", cookie: "", agencyId: "" }),
      steps: ({ when, then }) => [
        when.auth.signUp({
          email: "grace@agency.test",
          onboarding: "pending",
          captureSessionCookieAs: "session",
        }),
        then.assert(
          "the agency keeps its data in the US, and onboarding creates the agency once it is named",
          async (ctx) => {
            ctx.vars.cookie = await backofficeCookie(ctx, ctx.vars.session);
            await openOnboarding(ctx, ctx.vars.cookie, ONBOARDING);
            await ctx.drain();
            const asked = async () =>
              (await openOnboarding(ctx, ctx.vars.cookie, ONBOARDING)).state;
            expect(await asked()).toEqual({ status: "asking", prompt: { question: "usage" } });
            await answerOnboarding(ctx, ctx.vars.cookie, ONBOARDING, {
              question: "usage",
              usage: "agency",
            });
            expect(await asked()).toEqual({
              status: "asking",
              prompt: { question: "jurisdiction" },
            });
            await answerOnboarding(ctx, ctx.vars.cookie, ONBOARDING, {
              question: "jurisdiction",
              jurisdiction: "us",
            });
            expect(await asked()).toEqual({
              status: "asking",
              prompt: { question: "agency-name" },
            });
            await answerOnboarding(ctx, ctx.vars.cookie, ONBOARDING, {
              question: "agency-name",
              name: "Hopper & Co",
            });
            expect(await asked()).toEqual({
              status: "asking",
              prompt: { question: "client-name", client: 1 },
            });
            const me = await authUser(ctx, ctx.vars.cookie);
            expect(me.user.onboardedAt).toBeNull();
            expect(
              me.organizations.map(({ organization }) => [
                organization.slug,
                organization.jurisdiction,
              ]),
            ).toEqual([["hopper-co", "us"]]);
          },
        ),
        then.assert(
          "it adds its clients one at a time, each created before it chooses to add another",
          async (ctx) => {
            const asked = async () =>
              (await openOnboarding(ctx, ctx.vars.cookie, ONBOARDING)).state;
            await answerOnboarding(ctx, ctx.vars.cookie, ONBOARDING, {
              question: "client-name",
              name: "Acme",
            });
            expect(await asked()).toEqual({
              status: "asking",
              prompt: { question: "more-clients", clients: ["Acme"] },
            });
            await answerOnboarding(ctx, ctx.vars.cookie, ONBOARDING, {
              question: "more-clients",
              more: "true",
            });
            expect(await asked()).toEqual({
              status: "asking",
              prompt: { question: "client-name", client: 2 },
            });
            // A page left open on the last question would otherwise finish after the next client.
            await redirection(
              onboardingAction(
                routeRequest(
                  ctx,
                  ctx.vars.cookie,
                  ONBOARDING,
                  {},
                  new URLSearchParams({ question: "more-clients", more: "false" }),
                ) as never,
              ),
            );
            await ctx.drain();
            expect(await asked()).toEqual({
              status: "asking",
              prompt: { question: "client-name", client: 2 },
            });
            await answerOnboarding(ctx, ctx.vars.cookie, ONBOARDING, {
              question: "client-name",
              name: "Globex",
            });
            expect(await asked()).toEqual({
              status: "asking",
              prompt: { question: "more-clients", clients: ["Acme", "Globex"] },
            });
            await answerOnboarding(ctx, ctx.vars.cookie, ONBOARDING, {
              question: "more-clients",
              more: "false",
            });
            expect(
              await redirection(openOnboarding(ctx, ctx.vars.cookie, ONBOARDING)),
            ).toMatchObject({
              location: "/backoffice/dashboard/org/hopper-co",
            });
          },
        ),
        then.assert("the agency manages its clients, which it owns", async (ctx) => {
          const me = await authUser(ctx, ctx.vars.cookie);
          expect(
            me.organizations.map(({ organization, roles, through }) => ({
              slug: organization.slug,
              jurisdiction: organization.jurisdiction,
              roles,
              through: through.kind,
            })),
          ).toEqual([
            { slug: "hopper-co", jurisdiction: "us", roles: ["owner"], through: "membership" },
            { slug: "acme", jurisdiction: "us", roles: ["owner"], through: "membership" },
            { slug: "globex", jurisdiction: "us", roles: ["owner"], through: "membership" },
          ]);
          ctx.vars.agencyId = me.organizations[0]!.organization.id;
          const relations = await ctx.runtime.objects.auth
            .singleton()
            .commands.getOrganizationRelations({ organizationId: ctx.vars.agencyId });
          expect(relations.managedOrganizations.map(({ slug }) => slug)).toEqual([
            "acme",
            "globex",
          ]);
          const dashboard = await openDashboard(ctx, ctx.vars.cookie, {
            scopeKind: "org",
            scopeId: "acme",
          });
          ctx.vars.cookie = dashboard.cookie;
          expect(dashboard.selection).toMatchObject({
            kind: "org",
            organization: { slug: "acme", jurisdiction: "us" },
          });
        }),
        then.assert("a client added later is kept where the agency is", async (ctx) => {
          // The agency's pages act in the agency, as its clients page does.
          ctx.vars.cookie = (
            await openDashboard(ctx, ctx.vars.cookie, { scopeKind: "org", scopeId: "hopper-co" })
          ).cookie;
          const added = await redirection(
            behindBackofficeLayout(clientsAction)(
              routeRequest(
                ctx,
                ctx.vars.cookie,
                "/backoffice/organizations/hopper-co/clients",
                { orgSlug: "hopper-co" },
                new URLSearchParams({ name: "Initech" }),
              ) as never,
            ),
          );
          assert(added.location === "/backoffice/dashboard/org/initech");
          const relations = await ctx.runtime.objects.auth
            .singleton()
            .commands.getOrganizationRelations({ organizationId: ctx.vars.agencyId });
          expect(relations.managedOrganizations.map(({ slug }) => slug)).toEqual([
            "acme",
            "globex",
            "initech",
          ]);
          const me = await authUser(ctx, ctx.vars.cookie);
          expect(
            me.organizations.find(({ organization }) => organization.slug === "initech"),
          ).toMatchObject({ organization: { jurisdiction: "us" }, roles: ["owner"] });
        }),
      ],
    }),
  );
});

test("someone invited to an organization is asked only where their own data is kept", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Invited member onboarding",
      env,
      vars: () => ({ ownerSession: "", organizationId: "", invitationId: "", session: "" }),
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "owner@acme.test", captureSessionCookieAs: "ownerSession" }),
        when.auth.createOrganization({
          cookie: ({ vars }) => vars.ownerSession,
          name: "Acme",
          slug: "acme",
          captureOrganizationIdAs: "organizationId",
        }),
        when.auth.inviteMember({
          cookie: ({ vars }) => vars.ownerSession,
          organizationId: ({ vars }) => vars.organizationId,
          email: "bea@acme.test",
          captureInvitationIdAs: "invitationId",
        }),
        when.auth.signUp({
          email: "bea@acme.test",
          onboarding: "pending",
          captureSessionCookieAs: "session",
        }),
        when.auth.acceptInvitation({
          cookie: ({ vars }) => vars.session,
          invitationId: ({ vars }) => vars.invitationId,
        }),
        then.assert("onboarding skips what she uses Backoffice for", async (ctx) => {
          const cookie = await backofficeCookie(ctx, ctx.vars.session);
          await openOnboarding(ctx, cookie, ONBOARDING);
          await ctx.drain();
          expect(await openOnboarding(ctx, cookie, ONBOARDING)).toEqual({
            state: { status: "asking", prompt: { question: "jurisdiction" } },
            email: "bea@acme.test",
            memberOf: ["Acme"],
          });
          await answerOnboarding(ctx, cookie, ONBOARDING, {
            question: "jurisdiction",
            jurisdiction: "anywhere",
          });
          expect(await redirection(openOnboarding(ctx, cookie, ONBOARDING))).toMatchObject({
            location: "/backoffice/dashboard/org/acme",
          });
          const me = await authUser(ctx, cookie);
          expect(me.user).toMatchObject({ jurisdiction: null, onboardedAt: expect.any(Date) });
          expect(me.organizations.map(({ organization }) => organization.slug)).toEqual(["acme"]);
        }),
      ],
    }),
  );
});

test("someone who signs up to install an app sets up Backoffice first, then installs it", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Onboarding before installing an app",
      env,
      vars: () => ({ session: "", cookie: "", userId: "", installPath: "", onboardingPath: "" }),
      setup: ({ given }) => [given.auth.user({ id: "platform-admin", role: "admin" })],
      steps: ({ when, then }) => [
        then.assert("an administrator registers Bookkeeping", async (ctx) => {
          const client = await ctx.runtime.objects.auth
            .singleton()
            .commands.createAdminOAuthClient({
              administratorUserId: "platform-admin",
              name: "Bookkeeping",
              redirectUris: ["https://bookkeeping.example/callback"],
              scopes: ["openid", "backoffice"],
              clientType: "confidential",
              applicationType: "web",
              clientCredentials: true,
            });
          const registered = await ctx.runtime.objects.apps.singleton().commands.registerApp({
            actions: { kind: "none" },
            trust: { kind: "third-party" },
            slug: "bookkeeping",
            oauthClientId: client.clientId,
            requestedPermissions: [BACKOFFICE_PERMISSION.events.emit],
          });
          assert(registered.ok);
          ctx.vars.installPath = `/backoffice/apps/install?${new URLSearchParams({
            client_id: client.clientId,
            redirect_uri: "https://bookkeeping.example/install",
            state: "install-state",
          })}`;
        }),
        when.auth.signUp({
          email: "lin@example.test",
          onboarding: "pending",
          captureSessionCookieAs: "session",
        }),
        then.assert("until she onboards, nothing opens her personal scope", async (ctx) => {
          ctx.vars.cookie = await backofficeCookie(ctx, ctx.vars.session);
          ctx.vars.userId = (await authUser(ctx, ctx.vars.cookie)).user.id;
          const install = await redirection(
            installLoader(routeRequest(ctx, ctx.vars.cookie, ctx.vars.installPath, {}) as never),
          );
          assert(install.location === buildBackofficeOnboardingPath(ctx.vars.installPath));
          ctx.vars.onboardingPath = install.location;
          // Her token names no personal scope, so no request acts in one.
          const request = routeRequest(ctx, ctx.vars.cookie, "/api/backoffice", {});
          await expect(
            requireBackofficeContext(request.request, request.context, {
              kind: "user",
              userId: ctx.vars.userId,
              jurisdiction: null,
            }),
          ).rejects.toThrow("Forbidden");
        }),
        then.assert(
          "she onboards in the EU and returns to install Bookkeeping there",
          async (ctx) => {
            const path = ctx.vars.onboardingPath;
            await openOnboarding(ctx, ctx.vars.cookie, path);
            await ctx.drain();
            await answerOnboarding(ctx, ctx.vars.cookie, path, {
              question: "usage",
              usage: "personal",
            });
            await answerOnboarding(ctx, ctx.vars.cookie, path, {
              question: "jurisdiction",
              jurisdiction: "eu",
            });
            expect(await redirection(openOnboarding(ctx, ctx.vars.cookie, path))).toEqual({
              location: ctx.vars.installPath,
            });
            const install = await installLoader(
              routeRequest(ctx, ctx.vars.cookie, ctx.vars.installPath, {}) as never,
            );
            expect(install.data).toMatchObject({
              owners: [{ value: `user:${ctx.vars.userId}@eu`, label: "Personal" }],
              selectedOwner: { value: `user:${ctx.vars.userId}@eu`, kind: "user" },
            });
          },
        ),
      ],
    }),
  );
});
