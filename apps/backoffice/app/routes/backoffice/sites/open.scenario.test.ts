import { assert, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { siteHostOf, siteHostOrigin } from "@/artifacts/sites/site-host-names";
import { createSiteHostState, serveSiteHost } from "@/artifacts/sites/site-host.server";
import { runtimeSiteHosts } from "@/artifacts/sites/site-hosts.server";
import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { resolveBackofficeInternalRequestSecret } from "@/backoffice-runtime/internal-object-request";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { blobsR2BucketsFromEnv } from "@/fragno/blobs-r2-buckets";
import { createFakeR2 } from "@/fragno/blobs-r2.test-utils";
import { establishBackofficeAuthenticatedRequest } from "@/layouts/backoffice-authenticated-request.server";
import { sessionUserId } from "@/layouts/backoffice-layout.test-support";
import { establishBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { action as loginAction } from "../login";
import { loader as openLoader } from "./open";

const backoffice = "https://backoffice.example";
const email = "site-viewer@example.test";

const buckets = blobsR2BucketsFromEnv(
  {
    BLOBS_R2_ENDPOINT: "https://account-1.r2.cloudflarestorage.com",
    BLOBS_R2_BUCKET: "backoffice-blobs",
    BLOBS_R2_ACCESS_KEY_ID: "access-key",
    BLOBS_R2_SECRET_ACCESS_KEY: "secret-key",
    DOCS_PUBLIC_BASE_URL: `${backoffice}/`,
  },
  "enforced",
);
assert(buckets);
const r2 = createFakeR2(buckets);

type Vars = { session: string };
type Ctx = BackofficeScenarioContext<Vars>;

/**
 * How the browser loads a page: a document request for the page itself, or a client navigation
 * that fetches the page's React Router `.data` endpoint.
 */
type Navigation = "document" | "client";

function routerContext(ctx: Ctx, request: Request) {
  return createBackofficeRouterContextProvider(request, {
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
}

/** Opens Backoffice's `sites/open` page through the Backoffice layout's middlewares. */
async function openSitesOpen(
  ctx: Ctx,
  path: string,
  cookie: string,
  navigation: Navigation,
): Promise<Response> {
  const url = new URL(path, backoffice);
  const requestUrl =
    navigation === "document" ? url : new URL(`${url.pathname}.data${url.search}`, backoffice);
  const request = new Request(requestUrl, { headers: { cookie } });
  const context = routerContext(ctx, request);
  const args = { request, context, url, params: {} };
  try {
    return await establishBackofficeAuthenticatedRequest(args, () =>
      establishBackofficeShellRequest(args, async () =>
        openLoader({ ...args, pattern: "/backoffice/sites/open" }),
      ),
    );
  } catch (error) {
    assert(error instanceof Response, String(error));
    return error;
  }
}

/** Requests a URL of the sites domain as a browser reaches the Worker. */
async function hostRequest(ctx: Ctx, url: string, init: RequestInit = {}) {
  const runtime = ctx.runtime.services;
  const sites = runtimeSiteHosts(runtime);
  assert(sites);
  return await serveSiteHost({
    request: new Request(url, init),
    runtime,
    kernel: new BackofficeKernel(runtime),
    hosts: sites.hosts,
    domain: sites.domain,
    host: siteHostOf(new URL(url), sites.domain) ?? null,
    secret: resolveBackofficeInternalRequestSecret(ctx.runtime.env),
    bindings: {} as never,
    cache: null,
    state: createSiteHostState(() => Date.now()),
    now: () => Date.now(),
  });
}

function withSetCookies(cookie: string, response: Response): string {
  const cookies = new Map(
    cookie
      .split("; ")
      .filter(Boolean)
      .map((pair) => pair.split("=", 2) as [string, string]),
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

test("a viewer who signs in first is sent on to the site they opened", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario<Vars>({
      objects: allLocalObjects,
      name: "signing in on the way to a site",
      env: {
        AUTH_EMAIL_VERIFICATION_ENABLED: "false",
        SIGN_UP_ACCESS_CODES_REQUIRED: "false",
        SITES_ENABLED: "true",
        SITES_DOMAIN: "ley.run",
        DOCS_PUBLIC_BASE_URL: `${backoffice}/`,
        siteStorage: { buckets, fetch: r2.fetch },
      },
      vars: () => ({ session: "" }),
      steps: ({ when, then }) => [
        when.auth.signUp({ email, captureSessionCookieAs: "session" }),
        then.assert(
          "sign-in loads the page that posts the ticket as a document, which signs in at the site",
          async (ctx) => {
            const sites = runtimeSiteHosts(ctx.runtime.services);
            assert(sites);
            const userId = await sessionUserId(ctx, ctx.vars.session);
            const origin = siteHostOrigin(
              await sites.hosts.hostFor({ kind: "user", userId, jurisdiction: null }),
              sites.domain,
            );

            // A browser signed in nowhere opens a link to the site.
            const atHost = await hostRequest(ctx, `${origin}/notes.site/?tab=all`);
            assert.equal(atHost.status, 302);
            const siteCookie = withSetCookies("", atHost);
            const open = new URL(atHost.headers.get("location") ?? "");
            assert.equal(open.origin, backoffice);
            const openPath = `${open.pathname}${open.search}`;

            const toLogin = await openSitesOpen(ctx, openPath, "", "document");
            assert.equal(toLogin.status, 302);
            const loginUrl = new URL(toLogin.headers.get("location") ?? "", backoffice);
            assert.equal(loginUrl.pathname, "/backoffice/login");

            const signInRequest = new Request(loginUrl, {
              method: "POST",
              headers: { origin: backoffice },
              body: new URLSearchParams({ intent: "sign_in", email, password: "password123" }),
            });
            const signedIn = await loginAction({
              request: signInRequest,
              context: routerContext(ctx, signInRequest),
              params: {},
              pattern: "/backoffice/login",
              url: loginUrl,
            });
            assert(signedIn instanceof Response, JSON.stringify(signedIn));
            assert.equal(signedIn.headers.get("location"), openPath);
            let cookie = withSetCookies("", signedIn);

            // The sign-in form follows its redirect with a client navigation, which mints the
            // access token and then cannot take a page that posts a form as route data.
            const minted = await openSitesOpen(ctx, openPath, cookie, "client");
            assert.equal(minted.headers.get("location"), openPath);
            cookie = withSetCookies(cookie, minted);
            const reload = await openSitesOpen(ctx, openPath, cookie, "client");
            assert.equal(reload.status, 302);
            assert.equal(reload.headers.get("location"), openPath);
            assert.equal(reload.headers.get("x-remix-reload-document"), "true");

            const page = await openSitesOpen(ctx, openPath, cookie, "document");
            assert.equal(page.status, 200);
            const html = await page.text();
            assert.include(html, `<form method="post" action="${origin}/__ley/sign-in">`);
            const ticket = /name="ticket" value="([^"]+)"/u.exec(html)?.[1];
            assert(ticket);

            const atSite = await hostRequest(ctx, `${origin}/__ley/sign-in`, {
              method: "POST",
              headers: { cookie: siteCookie },
              body: new URLSearchParams({ ticket, next: "/notes.site/?tab=all" }),
            });
            assert.equal(atSite.status, 303);
            assert.equal(atSite.headers.get("location"), `${origin}/notes.site/?tab=all`);
            assert(atSite.headers.getSetCookie().some((c) => c.startsWith("__Host-ley-session=")));
          },
        ),
      ],
    }),
  );
});
