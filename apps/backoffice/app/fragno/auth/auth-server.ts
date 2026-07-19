import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";

import type { AuthFragment } from "@/fragno/auth/auth";
import type { AuthMeData } from "@/fragno/auth/auth-client";
import { getAuthDurableObject } from "@/worker-runtime/durable-objects";

type AuthCallRoute = AuthFragment["callRoute"];

export function createAuthRouteCaller(
  request: Request,
  context: Readonly<RouterContextProvider>,
): AuthCallRoute {
  const authDo = getAuthDurableObject(context);
  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  if (cookie) {
    headers.set("cookie", cookie);
  }

  const authorization = request.headers.get("authorization");
  if (authorization) {
    headers.set("authorization", authorization);
  }

  return createRouteCaller<AuthFragment>({
    baseUrl: request.url,
    mountRoute: "/api/auth",
    baseHeaders: headers,
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
    return response.data as AuthMeData;
  } catch {
    return null;
  }
}
