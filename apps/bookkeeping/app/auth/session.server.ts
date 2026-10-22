import { env } from "cloudflare:workers";
import { redirect } from "react-router";

import type { SessionUser } from "../../workers/auth/auth";

export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  return await env.AUTH.getByName("auth").getSessionUser(request.headers.get("cookie") ?? "");
}

/** The path and query of the requested page, to come back to after signing in. */
export function currentPath(request: Request): string {
  const url = new URL(request.url);
  return url.pathname + url.search;
}

/** The signed-in person. Without a session, they sign in and come back here. */
export async function requireSessionUser(request: Request): Promise<SessionUser> {
  const user = await getSessionUser(request);
  if (!user) {
    throw redirect(`/login?returnTo=${encodeURIComponent(currentPath(request))}`);
  }
  return user;
}

/** A path on Bookkeeping's own origin to continue to, or `/start` for anything else. */
export function safeReturnTo(value: string | null): string {
  if (value === null || !value.startsWith("/")) {
    return "/start";
  }
  const origin = new URL(env.BOOKKEEPING_BASE_URL).origin;
  const url = new URL(value, origin);
  // `/.//evil.test` resolves here but normalizes to `//evil.test`, which browsers read as a host.
  return url.origin === origin && !url.pathname.startsWith("//")
    ? url.pathname + url.search
    : "/start";
}

/** Session cookies are SameSite=Lax; this also rejects same-site cross-origin submissions. */
export function assertSameOrigin(request: Request): void {
  if (request.headers.get("origin") !== new URL(env.BOOKKEEPING_BASE_URL).origin) {
    throw new Response("Cross-origin submissions are not allowed.", { status: 403 });
  }
}
