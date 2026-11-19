import { z } from "zod";

import {
  backofficeDeferredExecutionSchema,
  backofficeVerifiedRequestAuthoritySchema,
  type BackofficeDeferredExecution,
  type BackofficeVerifiedRequestAuthority,
} from "@/backoffice-runtime/context";
import { base64ToBytes, bytesToBase64 } from "@/lib/base64";

/**
 * The site host's own cookies, which a site's Worker neither receives nor sets. `__Host-` makes
 * browsers accept them only from that host, so another site cannot set or replace them.
 */
export const SITE_HOST_COOKIE_PREFIX = "__Host-ley-";

/** The cookie a site host keeps a viewer signed in with. */
export const SITE_SESSION_COOKIE = `${SITE_HOST_COOKIE_PREFIX}session`;

/**
 * The cookie that ties a ticket to the browser that asked for it, as OAuth's state does, so no
 * one can sign a viewer in as someone else. Backoffice posts the ticket from its own site, so the
 * cookie must reach a cross-site POST.
 */
export const SITE_SIGN_IN_COOKIE = `${SITE_HOST_COOKIE_PREFIX}sign-in`;

/** The cookie a browser that opened a site link keeps its visit in. */
export const SITE_VISIT_COOKIE = `${SITE_HOST_COOKIE_PREFIX}visit`;

/** How long a ticket may take from Backoffice to the site host. */
export const SITE_TICKET_LIFETIME_MS = 60 * 1000;

/** How long a viewer stays signed in to a site host before Backoffice is asked again. */
export const SITE_SESSION_LIFETIME_MS = 60 * 60 * 1000;

/** How long a site link opens its site, and its visits last. */
export const SITE_LINK_LIFETIME_MS = 10 * 60 * 1000;

/** Who views a site, as Backoffice signed them in. */
export type SiteViewer = { id: string; email: string };

/**
 * A viewer, with the authority Backoffice verified when it signed them in: their Backoffice
 * token's role snapshot, trusted until that token expires, as Backoffice trusts it.
 */
export type SiteSignIn = { viewer: SiteViewer; authority: BackofficeVerifiedRequestAuthority };

const claimsSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().min(1),
  email: z.string(),
  // Tickets carry the hash of the sign-in cookie's value; sessions carry none.
  nonceHash: z.string().optional(),
  authority: backofficeVerifiedRequestAuthoritySchema,
  expiresAt: z.number(),
});

type Claims = SiteViewer & { nonceHash?: string; authority: BackofficeVerifiedRequestAuthority };

// Every kind of token signs with the same secret, so each signs with its own prefix.
const TICKET = "leyway-site-ticket-v1";
const SESSION = "leyway-site-session-v1";
const LINK = "leyway-site-link-v1";
const VISIT = "leyway-site-visit-v1";

function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    return null;
  }
  try {
    return base64ToBytes(value.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return null;
  }
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// The audience is the site host's origin, so a token opens only the host it was signed for.
function signingInput(kind: string, origin: string, payload: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${kind}\n${origin}\n${payload}`);
}

/** Where a token is signed and checked: the secret, the site host's origin, and the time. */
export type SiteTokenContext = { secret: string; origin: string; now: number };

async function sign(
  kind: string,
  { secret, origin, now }: SiteTokenContext,
  claimed: Claims | SiteLink | SiteVisit,
  lifetime: number,
): Promise<string> {
  const payload = base64Url(
    new TextEncoder().encode(JSON.stringify({ version: 1, ...claimed, expiresAt: now + lifetime })),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    signingInput(kind, origin, payload),
  );
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

/** The claims of a token of `kind` signed for this host, while it lasts. */
async function verify<T extends { expiresAt: number }>(
  kind: string,
  { secret, origin, now }: SiteTokenContext,
  token: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const [payload, encodedSignature, ...rest] = token.split(".");
  const signature = encodedSignature ? fromBase64Url(encodedSignature) : null;
  if (!payload || !signature || rest.length > 0) {
    return null;
  }
  const verified = await crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    Uint8Array.from(signature),
    signingInput(kind, origin, payload),
  );
  const bytes = verified ? fromBase64Url(payload) : null;
  if (!bytes) {
    return null;
  }
  const claims = schema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  return claims.success && claims.data.expiresAt > now ? claims.data : null;
}

async function verifyViewer(
  kind: string,
  context: SiteTokenContext,
  token: string,
): Promise<Claims | null> {
  const claims = await verify(kind, context, token, claimsSchema);
  if (!claims || claims.authority.userId !== claims.id) {
    return null;
  }
  const { id, email, nonceHash, authority } = claims;
  return { id, email, authority, ...(nonceHash === undefined ? {} : { nonceHash }) };
}

function signInOf({ id, email, authority }: Claims): SiteSignIn {
  return { viewer: { id, email }, authority };
}

/**
 * What a site host sends Backoffice in place of its sign-in cookie's nonce, so the nonce never
 * leaves that cookie: whoever reads a ticket, or the URL that asked for it, cannot redeem it.
 */
export async function siteNonceHash(nonce: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  return base64Url(new Uint8Array(digest));
}

/**
 * A ticket Backoffice hands a viewer to sign in to one site host, for the browser whose sign-in
 * cookie holds the nonce `nonceHash` is the hash of.
 */
export async function signSiteTicket(
  context: SiteTokenContext,
  { viewer, authority }: SiteSignIn,
  nonceHash: string,
): Promise<string> {
  return await sign(TICKET, context, { ...viewer, authority, nonceHash }, SITE_TICKET_LIFETIME_MS);
}

/** Who a ticket signs in, when it is valid for this host and this browser's `nonce`. */
export async function verifySiteTicket(
  context: SiteTokenContext,
  ticket: string,
  nonce: string,
): Promise<SiteSignIn | null> {
  const claims = await verifyViewer(TICKET, context, ticket);
  if (
    !claims ||
    claims.nonceHash === undefined ||
    claims.nonceHash !== (await siteNonceHash(nonce))
  ) {
    return null;
  }
  return signInOf(claims);
}

/**
 * The session a site host keeps in its cookie once a ticket signed the viewer in. It outlives the
 * authority it carries, which the host then checks live.
 */
export async function signSiteSession(
  context: SiteTokenContext,
  { viewer, authority }: SiteSignIn,
): Promise<string> {
  return await sign(SESSION, context, { ...viewer, authority }, SITE_SESSION_LIFETIME_MS);
}

export async function verifySiteSession(
  context: SiteTokenContext,
  session: string,
): Promise<SiteSignIn | null> {
  const claims = await verifyViewer(SESSION, context, session);
  return claims && claims.nonceHash === undefined ? signInOf(claims) : null;
}

/**
 * A link that opens one site without signing in, for whoever made it: a browser or service outside
 * Backoffice, such as Browser Run. It names their execution rather than a snapshot of their
 * authority, so the host checks what they, and the agent acting for them, may do now.
 */
export type SiteLink = {
  id: string;
  sitePath: string;
  /** The page within the site it opens, with its query. */
  page: string;
  /** Who the Worker is told views the site, as an agent's request names them. */
  viewer: SiteViewer | null;
  execution: BackofficeDeferredExecution;
};

/**
 * One opening of a link, which the browser that opened it keeps in its cookie. Its requests share
 * a Worker of their own, which fires no events, so they are told apart from the link's other
 * visits in the site's logs.
 */
export type SiteVisit = Omit<SiteLink, "id" | "page"> & { link: string; visit: string };

const linkedSchema = {
  version: z.literal(1),
  sitePath: z.string(),
  viewer: z.strictObject({ id: z.string().min(1), email: z.string() }).nullable(),
  execution: backofficeDeferredExecutionSchema,
  expiresAt: z.number(),
};

const visitClaimsSchema = z.strictObject({
  ...linkedSchema,
  link: z.string(),
  visit: z.string(),
});

/** A link that lasts until `expiresAt`, for the host of `context`. */
export async function signSiteLink(
  context: SiteTokenContext,
  link: SiteLink,
  expiresAt: number,
): Promise<string> {
  return await sign(LINK, context, link, expiresAt - context.now);
}

/** The link a token names, and when it expires, while it is valid for this host. */
export async function verifySiteLink(
  context: SiteTokenContext,
  token: string,
): Promise<{ link: SiteLink; expiresAt: number } | null> {
  const claims = await verify(
    LINK,
    context,
    token,
    z.strictObject({ ...linkedSchema, id: z.string(), page: z.string() }),
  );
  if (!claims) {
    return null;
  }
  const { id, sitePath, page, viewer, execution, expiresAt } = claims;
  return { link: { id, sitePath, page, viewer, execution }, expiresAt };
}

/** The visit of a link opened now, which lasts as long as the link. */
export async function signSiteVisit(
  context: SiteTokenContext,
  visit: SiteVisit,
  expiresAt: number,
): Promise<string> {
  return await sign(VISIT, context, visit, expiresAt - context.now);
}

export async function verifySiteVisit(
  context: SiteTokenContext,
  token: string,
): Promise<SiteVisit | null> {
  const claims = await verify(VISIT, context, token, visitClaimsSchema);
  if (!claims) {
    return null;
  }
  const { link, visit, sitePath, viewer, execution } = claims;
  return { link, visit, sitePath, viewer, execution };
}

/**
 * The visit cookie, or the one that clears it. It outlives its visit, until the browser closes, so
 * a browser that opened a link stays its visit, expired or not, until it signs out or in; were it
 * to lapse, a viewer's session would take over the page the link opened.
 */
export function siteVisitCookie(visit: string | null): string {
  return visit === null
    ? `${SITE_VISIT_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`
    : `${SITE_VISIT_COOKIE}=${visit}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

/** The session cookie: sent only to its host, over https, and never readable by its scripts. */
export function siteSessionCookie(session: string | null): string {
  return session === null
    ? `${SITE_SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`
    : `${SITE_SESSION_COOKIE}=${session}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SITE_SESSION_LIFETIME_MS / 1000}`;
}

/** The sign-in cookie, which lasts as long as signing in may take. */
export function siteSignInCookie(nonce: string | null): string {
  return nonce === null
    ? `${SITE_SIGN_IN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0`
    : `${SITE_SIGN_IN_COOKIE}=${nonce}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=600`;
}

/** The value of the cookie `name` a request carries, if any. */
export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [cookie, ...value] = part.trim().split("=");
    if (cookie === name) {
      return value.join("=");
    }
  }
  return null;
}
