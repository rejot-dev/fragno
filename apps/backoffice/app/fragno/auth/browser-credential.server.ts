import { redirect, type RouterContextProvider } from "react-router";

import { buildBackofficeLoginPath } from "@/routes/backoffice/auth-navigation";
import { getSetCookieHeaders } from "@/worker-runtime/http-headers";

import { callBetterAuth } from "./auth-server";
import type { IssueBackofficeTokenInput } from "./contracts";
import { readBackofficeSessionExchangeErrorMessage } from "./session-exchange-error";
import { expiredBackofficeAccessTokenCookieHeaders } from "./token-lifecycle";

/**
 * Reopens the requested page with an access token minted from the browser's Auth session, or sends
 * a browser without a session to sign in. A reopened submission arrives as a plain page load.
 *
 * `url` is React Router's page URL. On client navigations `request.url` is the `.data` endpoint,
 * which is not a page.
 */
export async function reopenWithBackofficeCredential(
  {
    request,
    context,
    url,
  }: { request: Request; context: Readonly<RouterContextProvider>; url: URL },
  input: IssueBackofficeTokenInput,
): Promise<Response> {
  const returnTo = `${url.pathname}${url.search}`;
  const issued = await callBetterAuth(request, context, "/backoffice-token", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (issued.status === 401) {
    // A token outlives its session by up to its lifetime. Sign-in would send a browser still
    // holding one straight back here, so it is dropped with the session.
    const headers = new Headers();
    for (const cookie of expiredBackofficeAccessTokenCookieHeaders()) {
      headers.append("Set-Cookie", cookie);
    }
    return redirect(buildBackofficeLoginPath(returnTo), { headers });
  }
  if (!issued.ok) {
    return new Response(await readBackofficeSessionExchangeErrorMessage(issued), {
      status: issued.status,
    });
  }
  const headers = new Headers();
  for (const cookie of getSetCookieHeaders(issued.headers)) {
    headers.append("Set-Cookie", cookie);
  }
  return redirect(returnTo, { headers });
}
