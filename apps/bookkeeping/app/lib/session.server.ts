import { env } from "cloudflare:workers";
import { redirect } from "react-router";

import type { SessionUser } from "../../workers/auth";

export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  return await env.AUTH.getByName("auth").getSessionUser(request.headers.get("cookie") ?? "");
}

export async function requireSessionUser(request: Request): Promise<SessionUser> {
  const user = await getSessionUser(request);
  if (!user) {
    throw redirect("/login");
  }
  return user;
}

/** Session cookies are SameSite=Lax; this also rejects same-site cross-origin submissions. */
export function assertSameOrigin(request: Request): void {
  if (request.headers.get("origin") !== new URL(env.BOOKKEEPING_BASE_URL).origin) {
    throw new Response("Cross-origin submissions are not allowed.", { status: 403 });
  }
}
