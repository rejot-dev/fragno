import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  backofficeScopePathSegment,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import {
  createBackofficeRequestExecution,
  createBackofficeUserExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { resolveBackofficeInternalRequestSecret } from "@/backoffice-runtime/internal-object-request";
import { isBackofficeForbiddenError, type BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";

import { siteFilesCacheFor, siteStoreForServing, type SiteFilesCache } from "./assets.server";
import {
  createSitePointerCache,
  exportedSiteWorkerBindings,
  readSitePointer,
  serveSite,
  type SitePointerCache,
  type SiteWorkerBindings,
} from "./serve.server";
import {
  publicSiteHost,
  readSiteHost,
  SITE_HOST_PATHS,
  SITE_SIGN_IN_PATH,
  siteHostDestination,
  siteHostOrigin,
} from "./site-host-names";
import { runtimeSiteHosts, type SiteHosts } from "./site-hosts.server";
import { siteRequestTarget } from "./site-path";
import {
  readCookie,
  SITE_SESSION_COOKIE,
  SITE_SIGN_IN_COOKIE,
  signSiteSession,
  siteNonceHash,
  siteSessionCookie,
  siteSignInCookie,
  verifySiteSession,
  verifySiteTicket,
  type SiteSignIn,
} from "./site-session.server";
import type { SitePointerRead } from "./site-store.server";

const SITE_SIGN_OUT_PATH = `${SITE_HOST_PATHS}sign-out`;

/**
 * How long an isolate trusts a live check that a viewer may read a site, so a page's requests
 * share one once the authority they signed in with has expired.
 */
const AUTHORIZATION_KEPT_MS = 30 * 1000;
const AUTHORIZATIONS_KEPT = 1000;

/** What an isolate keeps between requests to site hosts. */
export type SiteHostState = {
  pointers: SitePointerCache;
  /** Until when each viewer may read each site without a live check. */
  authorized: Map<string, number>;
};

export function createSiteHostState(now: () => number): SiteHostState {
  return { pointers: createSitePointerCache(now), authorized: new Map() };
}

const isolateState = createSiteHostState(() => Date.now());

/** Serves a request to a subdomain of the sites domain in the Worker that received it. */
export async function serveSiteHostRequest({
  request,
  env,
  ctx,
  runtime,
  kernel,
  host,
}: {
  request: Request;
  env: CloudflareEnv;
  ctx: ExecutionContext;
  runtime: BackofficeRuntimeServices;
  kernel: BackofficeKernel;
  host: string | null;
}): Promise<Response> {
  const sites = runtimeSiteHosts(runtime);
  if (sites === null) {
    throw new Error("Site hosts are served only where SITES_DOMAIN is set.");
  }
  return await serveSiteHost({
    request,
    runtime,
    kernel,
    hosts: sites.hosts,
    domain: sites.domain,
    host,
    secret: resolveBackofficeInternalRequestSecret(env),
    bindings: exportedSiteWorkerBindings(runtime.workerLoader, ctx.exports),
    cache: siteFilesCacheFor(runtime, request, (promise) => {
      ctx.waitUntil(promise);
    }),
    state: isolateState,
    now: () => Date.now(),
  });
}

/**
 * Serves a request to a scope's subdomain of the sites domain: a site of the scope, at its path
 * below `/workspace`, to a viewer Backoffice signed in who may read it. Public sites are served to
 * anyone, only at the scope's public subdomain, which never signs anyone in. `host` is the
 * subdomain, or null for the sites domain itself.
 */
export async function serveSiteHost(input: {
  request: Request;
  runtime: BackofficeRuntimeServices;
  kernel: BackofficeKernel;
  hosts: SiteHosts;
  domain: string;
  host: string | null;
  /** Signs tickets and sessions; Backoffice signs tickets with it too. */
  secret: string;
  bindings: SiteWorkerBindings;
  cache: SiteFilesCache | null;
  state: SiteHostState;
  now: () => number;
}): Promise<Response> {
  return withSiteHostHeaders(await answer(input));
}

async function answer({
  request,
  runtime,
  kernel,
  hosts,
  domain,
  host,
  secret,
  bindings,
  cache,
  state,
  now,
}: Parameters<typeof serveSiteHost>[0]): Promise<Response> {
  if (!runtime.config.sites || host === null) {
    return text("Not Found", 404);
  }
  const { host: claimed, public: onPublicHost } = readSiteHost(host);
  const scope = await hosts.scopeFor(claimed);
  if (scope === null) {
    return text(`${host}.${domain} serves no sites.`, 404);
  }
  const origin = siteHostOrigin(host, domain);
  const tokens = { secret, origin, now: now() };
  const url = new URL(request.url);

  if (!onPublicHost && url.pathname === SITE_SIGN_IN_PATH) {
    return await signIn(request, tokens, origin);
  }
  if (!onPublicHost && url.pathname === SITE_SIGN_OUT_PATH) {
    return new Response("Signed out of this scope's sites.", {
      headers: { "set-cookie": siteSessionCookie(null), "cache-control": "no-store" },
    });
  }
  if (url.pathname.startsWith(SITE_HOST_PATHS)) {
    return text("Not Found", 404);
  }
  // Forms and scripts of other origins, the other scopes' sites included, cannot act as the viewer.
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && crossOrigin(request)) {
    return text("Requests that change something must come from this site's own pages.", 403);
  }

  const target = siteRequestTarget(url.pathname.split("/").slice(1));
  const storeOf = (sitePath: string) => siteStoreForServing({ runtime, scope, sitePath, cache });
  // Read once: the site is served from this read, so the build it serves is the one checked here.
  const read: SitePointerRead =
    target === null
      ? { status: "none" }
      : await readSitePointer({
          store: storeOf(target.sitePath),
          pointers: state.pointers,
          scope,
          sitePath: target.sitePath,
        });
  // Each site is served only at the host of its kind, so a public site's pages, and what its
  // visitors put in them, never run at an origin a viewer's session reaches.
  const isPublic = read.status === "built" && read.pointer.served.public;
  if (onPublicHost && !isPublic) {
    return text("No public site at this path.", 404);
  }
  // Not permanently, as the site may be built private again.
  if (!onPublicHost && isPublic) {
    return new Response(null, {
      status: 302,
      headers: {
        location: `${siteHostOrigin(publicSiteHost(claimed), domain)}${url.pathname}${url.search}`,
        "cache-control": "no-store",
      },
    });
  }
  // Anyone may open a public site, so its requests name no viewer.
  const session = onPublicHost ? null : readCookie(request, SITE_SESSION_COOKIE);
  const signedIn = session === null ? null : await verifySiteSession(tokens, session);
  if (!onPublicHost && signedIn === null) {
    return await signInFirst(request, url, host, runtime);
  }

  if (target === null) {
    return text("No site at this path. Open a site at its path, such as /shop.site/.", 404);
  }
  // Relative URLs in the site's pages resolve against its root only with the trailing slash.
  if (target.pathname === null) {
    return new Response(null, {
      status: 308,
      headers: { location: `${url.pathname}/${url.search}` },
    });
  }
  if (
    signedIn !== null &&
    !(await mayRead({ kernel, state, scope, signedIn, sitePath: target.sitePath, now: now() }))
  ) {
    return text(`${signedIn.viewer.email} may not open ${target.sitePath}.`, 403);
  }
  return await serveSite({
    request,
    store: storeOf(target.sitePath),
    read,
    bindings,
    scope,
    sitePath: target.sitePath,
    pathname: target.pathname,
    viewer: signedIn?.viewer ?? null,
  });
}

/**
 * Sends a browser without a session to Backoffice, which signs its viewer in and posts a ticket
 * back to `SITE_SIGN_IN_PATH`. The ticket names the hash of the nonce this sets in the browser's
 * cookie, so the nonce itself leaves the cookie only for this host.
 */
async function signInFirst(
  request: Request,
  url: URL,
  host: string,
  runtime: BackofficeRuntimeServices,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return text("Sign in first: open the site in a browser.", 401);
  }
  const backoffice = runtime.config.docsPublicBaseUrl;
  if (!backoffice) {
    throw new Error("SITES_DOMAIN needs DOCS_PUBLIC_BASE_URL, where viewers sign in.");
  }
  const nonce = randomNonce();
  const open = new URL("backoffice/sites/open", backoffice);
  open.searchParams.set("host", host);
  open.searchParams.set("next", `${url.pathname}${url.search}`);
  open.searchParams.set("nonceHash", await siteNonceHash(nonce));
  return new Response(null, {
    status: 302,
    headers: {
      location: open.toString(),
      "set-cookie": siteSignInCookie(nonce),
      "cache-control": "no-store",
    },
  });
}

/** Signs in the viewer a ticket from Backoffice names, in the browser that asked for it. */
async function signIn(
  request: Request,
  tokens: { secret: string; origin: string; now: number },
  origin: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return text("Method Not Allowed", 405);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return text("Expected a form with a ticket.", 400);
  }
  const ticket = form.get("ticket");
  const nonce = readCookie(request, SITE_SIGN_IN_COOKIE);
  const signedIn =
    typeof ticket === "string" && nonce !== null
      ? await verifySiteTicket(tokens, ticket, nonce)
      : null;
  const headers = new Headers({ "cache-control": "no-store" });
  headers.append("set-cookie", siteSignInCookie(null));
  if (signedIn === null) {
    return new Response(
      "This sign-in expired, or was started in another browser. Open the site again.",
      { status: 403, headers },
    );
  }
  headers.append("set-cookie", siteSessionCookie(await signSiteSession(tokens, signedIn)));
  const next = form.get("next");
  headers.set(
    "location",
    (typeof next === "string" ? siteHostDestination(origin, next) : null) ?? `${origin}/`,
  );
  return new Response(null, { status: 303, headers });
}

/**
 * Whether the viewer may read the site: from the authority they signed in with while it lasts, as
 * Backoffice trusts its own token, and from a live check, kept briefly, once it expired.
 */
async function mayRead({
  kernel,
  state,
  scope,
  signedIn: { viewer, authority },
  sitePath,
  now,
}: {
  kernel: BackofficeKernel;
  state: SiteHostState;
  scope: BackofficeContextScope;
  signedIn: SiteSignIn;
  sitePath: string;
  now: number;
}): Promise<boolean> {
  if (authority.expiresAtEpochMs > now) {
    const { kind: _kind, expiresAtEpochMs, ...verified } = authority;
    return await authorized(
      kernel,
      createBackofficeRequestExecution({
        scope,
        verifiedRequestAuthority: { ...verified, expiresAt: new Date(expiresAtEpochMs) },
      }),
      sitePath,
    );
  }
  const key = JSON.stringify([viewer.id, backofficeScopePathSegment(scope), sitePath]);
  if ((state.authorized.get(key) ?? 0) > now) {
    return true;
  }
  if (
    !(await authorized(
      kernel,
      createBackofficeUserExecution({ scope, userId: viewer.id }),
      sitePath,
    ))
  ) {
    return false;
  }
  if (state.authorized.size >= AUTHORIZATIONS_KEPT) {
    state.authorized.clear();
  }
  state.authorized.set(key, now + AUTHORIZATION_KEPT_MS);
  return true;
}

async function authorized(
  kernel: BackofficeKernel,
  execution: BackofficeExecutionContext,
  sitePath: string,
): Promise<boolean> {
  try {
    await kernel.assertAuthorizedAll({
      execution,
      requirements: [
        { operation: BACKOFFICE_PERMISSION.upload.read, resource: { path: sitePath } },
      ],
    });
    return true;
  } catch (error) {
    if (isBackofficeForbiddenError(error)) {
      return false;
    }
    throw error;
  }
}

/** Whether the browser says the request came from another origin; other clients say nothing. */
function crossOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin" && site !== "none";
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

function text(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain;charset=UTF-8", "cache-control": "no-store" },
  });
}

/**
 * The host's headers on every answer, which a site's own cannot loosen: browsers enforce every
 * Content-Security-Policy they receive, so a site's adds to this one. Answers depend on who is
 * signed in, so shared caches never keep them.
 */
export function withSiteHostHeaders(response: Response): Response {
  if (response.webSocket) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("strict-transport-security", "max-age=63072000; includeSubDomains");
  headers.set("x-content-type-options", "nosniff");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("origin-agent-cluster", "?1");
  // A site's service worker controls at most its own directory, never the host's sign-in.
  headers.delete("service-worker-allowed");
  headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=()",
  );
  headers.append(
    "content-security-policy",
    "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'",
  );
  if (!headers.has("referrer-policy")) {
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
  }
  const directives = (headers.get("cache-control") ?? "")
    .split(",")
    .map((directive) => directive.trim())
    .filter((directive) => directive !== "" && directive.toLowerCase() !== "public");
  if (directives.length === 0) {
    directives.push("no-cache");
  }
  if (!directives.some((directive) => /^(private|no-store)$/iu.test(directive))) {
    directives.unshift("private");
  }
  headers.set("cache-control", directives.join(", "));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
