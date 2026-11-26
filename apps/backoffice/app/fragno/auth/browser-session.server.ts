import { redirect, type RouterContextProvider } from "react-router";
import { z } from "zod";

import { buildBackofficeLoginPath } from "@/routes/backoffice/auth-navigation";

import { callBetterAuth } from "./auth-server";

const betterAuthBrowserSessionSchema = z.object({
  user: z.object({ id: z.string().min(1), name: z.string(), email: z.email() }),
  // Set by Better Auth's admin plugin while an administrator impersonates the user.
  session: z.object({ impersonatedBy: z.string().nullish() }),
});

type BrowserSessionInput = {
  request: Request;
  context: Readonly<RouterContextProvider>;
  url: URL;
};

async function readBrowserSession({ request, context, url }: BrowserSessionInput) {
  const response = await callBetterAuth(request, context, "/get-session");
  if (!response.ok) {
    throw new Response("Unable to read your browser session.", { status: response.status });
  }
  const session = betterAuthBrowserSessionSchema.safeParse(await response.json());
  if (!session.success) {
    throw redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }
  return session.data;
}

/**
 * OAuth approval and revocation require a live Better Auth session, not a Backoffice JWT. `url` is
 * React Router's page URL, which sign-in returns to; `request.url` may be a `.data` endpoint.
 */
export async function requireBackofficeBrowserSession(input: BrowserSessionInput) {
  return (await readBrowserSession(input)).user;
}

/**
 * A live browser session of the person themselves, for decisions only they may make about what is
 * theirs. An administrator impersonating them is refused.
 */
export async function requireOwnBrowserSession(input: BrowserSessionInput) {
  const { user, session } = await readBrowserSession(input);
  if (session.impersonatedBy) {
    throw new Response("Only the person themselves can decide this, not while impersonated.", {
      status: 403,
    });
  }
  return user;
}
