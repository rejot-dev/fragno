import type { RouterContextProvider } from "react-router";
import type { AuthMeData } from "@/fragno/auth-client";
import type { AuthFragment } from "@/fragno/auth";
import { getAuthDurableObject } from "@/cloudflare/cloudflare-utils";
import { createRouteCaller } from "@fragno-dev/core/api";

type AuthCallRoute = AuthFragment["callRoute"];

function createAuthRouteCaller(
  request: Request,
  context: Readonly<RouterContextProvider>,
): AuthCallRoute {
  const authDo = getAuthDurableObject(context);

  return createRouteCaller<AuthFragment>({
    baseUrl: request.url,
    mountRoute: "/api/auth",
    baseHeaders: request.headers,
    fetch: authDo.fetch.bind(authDo),
  });
}

export async function getAuthMe(
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<AuthMeData | null> {
  try {
    const callAuthRoute = createAuthRouteCaller(request, context);
    const response = await callAuthRoute("GET", "/me");
    if (response.type !== "json") {
      return null;
    }
    return response.data;
  } catch {
    return null;
  }
}
