import { env } from "cloudflare:workers";
import { redirect } from "react-router";

import type { authClient } from "./auth-client";

type Session = typeof authClient.$Infer.Session;

export async function getSession(request: Request): Promise<Session | null> {
  const response = await env.AUTH.getByName("auth").fetch(
    new Request(new URL("/api/auth/get-session", env.BOOKKEEPING_BASE_URL), {
      headers: { cookie: request.headers.get("cookie") ?? "" },
    }),
  );
  if (!response.ok) {
    throw new Response("Could not load your account. Please try again.", { status: 503 });
  }
  return (await response.json()) as Session | null;
}

export async function requireSession(request: Request): Promise<Session> {
  const session = await getSession(request);
  if (!session) {
    throw redirect("/login");
  }
  return session;
}
