import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { ApiObject } from "../../workers/api.do";
import { AuthObject } from "../../workers/auth.do";
import { AutomationsObject } from "../../workers/automations.do";
import { FormsObject } from "../../workers/forms.do";
import { OtpObject } from "../../workers/otp.do";
import { UploadObject } from "../../workers/upload.do";
import { establishBackofficeAuthenticatedRequest } from "./backoffice-authenticated-request.server";
import { sessionUserId } from "./backoffice-layout.test-support";
import {
  establishBackofficeShellRequest,
  getBackofficeShellRequest,
} from "./backoffice-shell-request.server";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  FORMS: (input) => new FormsObject(input),
  OTP: (input) => new OtpObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const origin = "https://backoffice.example";

type Vars = { session: string; browser: string; alphaId: string };
type Ctx = BackofficeScenarioContext<Vars>;

/** What the browser sees on one request: a redirect, or the page with its token's organization. */
type PageVisit = { redirect: string } | { page: { tokenOrganization: string | null } };

/**
 * How the browser loads a page: a document request for the page itself, or a client navigation
 * that fetches the page's React Router `.data` endpoint.
 */
type Navigation = "document" | "client";

/** Opens a dashboard page through both Backoffice middlewares, keeping the cookies it sets. */
async function openDashboard(ctx: Ctx, path: string, navigation: Navigation): Promise<PageVisit> {
  const url = new URL(path, origin);
  const requestUrl = navigation === "document" ? url : new URL(`${path}.data`, origin);
  const request = new Request(requestUrl, { headers: { cookie: ctx.vars.browser } });
  const context = createBackofficeRouterContextProvider(request, {
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
  const [scopeKind, scopeId] = path.split("/").slice(3);
  const args = { request, context, url, params: { scopeKind, scopeId } };
  try {
    await establishBackofficeAuthenticatedRequest(args, () =>
      establishBackofficeShellRequest(args, async () => new Response("Dashboard")),
    );
  } catch (error) {
    assert(error instanceof Response, String(error));
    assert.equal(error.status, 302);
    ctx.vars.browser = withResponseCookies(ctx.vars.browser, error);
    const location = error.headers.get("location");
    assert(location);
    return { redirect: location };
  }
  const { principal } = getBackofficeShellRequest(context);
  return { page: { tokenOrganization: principal.auth.organization?.slug ?? null } };
}

/** Opens a page and follows redirects the way a browser does. */
async function browse(
  ctx: Ctx,
  path: string,
  navigation: Navigation = "document",
): Promise<PageVisit[]> {
  const visits: PageVisit[] = [];
  let location = path;
  while (visits.length < 3) {
    const visit = await openDashboard(ctx, location, navigation);
    visits.push(visit);
    // Only the dashboard is opened here; other destinations, such as sign-in, end the visit.
    if (!("redirect" in visit) || !visit.redirect.startsWith("/backoffice/dashboard")) {
      return visits;
    }
    location = visit.redirect;
  }
  throw new Error(`Redirect loop opening ${path}: ${JSON.stringify(visits)}`);
}

function withResponseCookies(cookieHeader: string, response: Response): string {
  const cookies = new Map(
    cookieHeader
      .split("; ")
      .filter(Boolean)
      .map((cookie) => cookie.split("=", 2) as [string, string]),
  );
  for (const setCookie of response.headers.getSetCookie()) {
    const [name, value] = setCookie.split(";", 1)[0].split("=", 2) as [string, string];
    if (setCookie.includes("Max-Age=0")) {
      cookies.delete(name);
    } else {
      cookies.set(name, value);
    }
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

test("pages mint the browser's access token in the organization it last opened", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario<Vars>({
      objects: scenarioObjects,
      name: "Backoffice pages mint access tokens from the Auth session",
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_INVITATIONS_ENABLED: "false" },
      vars: () => ({ session: "", browser: "", alphaId: "" }),
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "ada@example.test", captureSessionCookieAs: "session" }),
        when.auth.createOrganization({
          cookie: ({ vars }) => vars.session,
          name: "Alpha",
          slug: "alpha",
          captureOrganizationIdAs: "alphaId",
        }),
        when.auth.createOrganization({
          cookie: ({ vars }) => vars.session,
          name: "Beta",
          slug: "beta",
        }),
        then.assert("a browser without a session signs in first", async (ctx) => {
          expect(await browse(ctx, "/backoffice/dashboard")).toEqual([
            { redirect: "/backoffice/login?returnTo=%2Fbackoffice%2Fdashboard" },
          ]);
        }),
        then.assert(
          "a signed-in browser reopens the page with a token for its newest organization",
          async (ctx) => {
            ctx.vars.browser = ctx.vars.session;
            expect(await browse(ctx, "/backoffice/dashboard")).toEqual([
              { redirect: "/backoffice/dashboard" },
              { page: { tokenOrganization: "beta" } },
            ]);
          },
        ),
        then.assert(
          "a client navigation, such as the one after signing in, reopens the page and not its data",
          async (ctx) => {
            ctx.vars.browser = ctx.vars.session;
            expect(await browse(ctx, "/backoffice/dashboard", "client")).toEqual([
              { redirect: "/backoffice/dashboard" },
              { page: { tokenOrganization: "beta" } },
            ]);
          },
        ),
        then.assert("opening another organization's page switches the token there", async (ctx) => {
          expect(await browse(ctx, "/backoffice/dashboard/org/alpha")).toEqual([
            { redirect: "/backoffice/dashboard/org/alpha" },
            { page: { tokenOrganization: "alpha" } },
          ]);
          expect(await browse(ctx, "/backoffice/dashboard/org/alpha")).toEqual([
            { page: { tokenOrganization: "alpha" } },
          ]);
        }),
        then.assert("an expired token is replaced in the organization last opened", async (ctx) => {
          ctx.vars.browser = ctx.vars.session;
          expect(await browse(ctx, "/backoffice/dashboard")).toEqual([
            { redirect: "/backoffice/dashboard" },
            { page: { tokenOrganization: "alpha" } },
          ]);
        }),
        when.auth.removeMember({
          orgId: ({ vars }) => vars.alphaId,
          userId: async (ctx) => await sessionUserId(ctx, ctx.vars.session),
        }),
        then.assert(
          "a token for an organization the user left is replaced with one they belong to",
          async (ctx) => {
            expect(await browse(ctx, "/backoffice/dashboard")).toEqual([
              { redirect: "/backoffice/dashboard" },
              { page: { tokenOrganization: "beta" } },
            ]);
          },
        ),
      ],
    }),
  );
});
