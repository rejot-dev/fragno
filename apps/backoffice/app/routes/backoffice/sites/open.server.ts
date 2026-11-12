import {
  backofficeScopeOrganization,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { redirectDocument, type RouterContextProvider } from "react-router";

import {
  SITE_SIGN_IN_PATH,
  siteHostDestination,
  siteHostOrigin,
} from "@/artifacts/sites/site-host-names";
import { runtimeSiteHosts } from "@/artifacts/sites/site-hosts.server";
import { signSiteTicket } from "@/artifacts/sites/site-session.server";
import { resolveBackofficeInternalRequestSecret } from "@/backoffice-runtime/internal-object-request";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { reopenWithBackofficeCredential } from "@/fragno/auth/browser-credential.server";
import type { BackofficeMeData } from "@/fragno/auth/contracts";
import { requireBackofficePrincipal } from "@/fragno/auth/request-auth.server";
import { getBackofficeAuthenticatedRequest } from "@/layouts/backoffice-authenticated-request.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

// Submits the ticket as a form, so it stays out of URLs, history, and Referer headers.
const SUBMIT_SCRIPT = "document.forms[0].submit();";

/**
 * Signs a viewer in to a scope's site host, which sent them here without a session: Backoffice
 * signed them in, and they hold a place in the scope, so it posts the host a ticket naming them
 * and the authority their token holds. Each site checks on its own host that they may read it.
 */
export async function openSiteHost({
  request,
  context,
  url,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  /** React Router's page URL; on client navigations `request.url` is the `.data` endpoint. */
  url: URL;
}): Promise<Response> {
  // Sign-in sends the viewer here with a client navigation, which would take this page as route
  // data and never post its ticket, so the browser loads it as a document.
  if (new URL(request.url).pathname !== url.pathname) {
    throw redirectDocument(`${url.pathname}${url.search}`);
  }
  const { runtime, env } = context.get(BackofficeWorkerContext);
  const sites = runtimeSiteHosts(runtime);
  if (!runtime.config.sites || sites === null) {
    return new Response("Not Found", { status: 404 });
  }
  const host = url.searchParams.get("host") ?? "";
  const nonceHash = url.searchParams.get("nonceHash") ?? "";
  const scope = await sites.hosts.scopeFor(host);
  const origin = siteHostOrigin(host, sites.domain);
  const next = siteHostDestination(origin, url.searchParams.get("next") ?? "/");
  if (scope === null || !/^[A-Za-z0-9_-]{43}$/u.test(nonceHash) || next === null) {
    return new Response("Not Found", { status: 404 });
  }
  const organizationId = organizationToSelect(scope, getBackofficeAuthenticatedRequest(context).me);
  if (organizationId !== null) {
    throw await reopenWithBackofficeCredential(
      { request, context, url },
      { selection: "required", organizationId },
    );
  }
  const { userAuthority: authority } = await requireBackofficeContext(request, context, scope);
  const { user } = await requireBackofficePrincipal(request, context);
  const ticket = await signSiteTicket(
    { secret: resolveBackofficeInternalRequestSecret(env), origin, now: Date.now() },
    { viewer: { id: user.id, email: user.email }, authority },
    nonceHash,
  );
  return await siteSignInPage({ origin, ticket, next });
}

/**
 * The organization the viewer's Backoffice token must name before it opens `scope`'s sites: the
 * scope's, when the token names another and the viewer belongs to it, as the shell switches for
 * a URL naming the scope. Null when the token may open the scope as it is, or never will.
 */
export function organizationToSelect(
  scope: BackofficeContextScope,
  {
    activeOrganizationId,
    organizations,
  }: Pick<BackofficeMeData, "activeOrganizationId" | "organizations">,
): string | null {
  const organizationId = backofficeScopeOrganization(scope)?.orgId ?? null;
  return organizationId !== null &&
    organizationId !== activeOrganizationId &&
    organizations.some(({ organization }) => organization.id === organizationId)
    ? organizationId
    : null;
}

/** A page that posts `ticket` to the site host at `origin`, which then continues at `next`. */
export async function siteSignInPage({
  origin,
  ticket,
  next,
}: {
  origin: string;
  ticket: string;
  next: string;
}): Promise<Response> {
  const scriptHash = await sha256Base64(SUBMIT_SCRIPT);
  return new Response(
    `<!doctype html>
<meta charset="utf-8">
<title>Opening the site</title>
<form method="post" action="${attribute(`${origin}${SITE_SIGN_IN_PATH}`)}">
<input type="hidden" name="ticket" value="${attribute(ticket)}">
<input type="hidden" name="next" value="${attribute(next)}">
<noscript><button>Open the site</button></noscript>
</form>
<script>${SUBMIT_SCRIPT}</script>
`,
    {
      headers: {
        "content-type": "text/html;charset=UTF-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy": `default-src 'none'; script-src 'sha256-${scriptHash}'; form-action ${origin}; base-uri 'none'; frame-ancestors 'none'`,
      },
    },
  );
}

function attribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}
