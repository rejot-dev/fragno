import { redirect, type RouterContextProvider } from "react-router";
import { z } from "zod";

import { buildBackofficeLoginPath } from "@/routes/backoffice/auth-navigation";

import { callBetterAuth } from "./auth-server";

const betterAuthBrowserSessionSchema = z.object({
  user: z.object({ id: z.string().min(1), email: z.email() }),
});

/**
 * OAuth approval and revocation require a live Better Auth session, not a Backoffice JWT. `url` is
 * React Router's page URL, which sign-in returns to; `request.url` may be a `.data` endpoint.
 */
export async function requireBackofficeBrowserSession({
  request,
  context,
  url,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  url: URL;
}) {
  const response = await callBetterAuth(request, context, "/get-session");
  if (!response.ok) {
    throw new Response("Unable to read your browser session.", { status: response.status });
  }
  const session = betterAuthBrowserSessionSchema.safeParse(await response.json());
  if (!session.success) {
    throw redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }
  return session.data.user;
}
