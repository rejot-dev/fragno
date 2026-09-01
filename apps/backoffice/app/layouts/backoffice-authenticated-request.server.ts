import {
  createContext,
  redirect,
  type RouterContext,
  type RouterContextProvider,
} from "react-router";

import { getBackofficeMe } from "@/fragno/auth/auth-server";
import type { BackofficeMeData } from "@/fragno/auth/contracts";
import { buildBackofficeAuthBootstrapPath } from "@/routes/backoffice/auth-navigation";

/** Contains the authenticated membership snapshot established before Backoffice route handlers. */
export type BackofficeAuthenticatedRequest = {
  me: BackofficeMeData;
  accessTokenExpiresAt: Date;
};

const backofficeAuthenticatedRequestContextKey = Symbol.for(
  "fragno.backoffice.authenticated-request-context",
);

/** Provides authentication established by the protected Backoffice layout middleware. */
export const BackofficeAuthenticatedRequestContext = ((globalThis as Record<symbol, unknown>)[
  backofficeAuthenticatedRequestContextKey
] ??=
  createContext<BackofficeAuthenticatedRequest>()) as RouterContext<BackofficeAuthenticatedRequest>;

/** Establishes Backoffice authentication before any protected descendant route handler runs. */
export async function establishBackofficeAuthenticatedRequest(
  { request, context }: { request: Request; context: Readonly<RouterContextProvider> },
  next: () => Promise<Response>,
): Promise<Response> {
  const authentication = await getBackofficeMe(request, context);
  if (authentication.status !== "authenticated") {
    const url = new URL(request.url);
    throw redirect(buildBackofficeAuthBootstrapPath(`${url.pathname}${url.search}`));
  }

  context.set(BackofficeAuthenticatedRequestContext, {
    me: authentication.me,
    accessTokenExpiresAt: authentication.expiresAt,
  });
  return await next();
}

/** Reads authentication guaranteed by the protected Backoffice layout middleware. */
export function getBackofficeAuthenticatedRequest(
  context: Readonly<RouterContextProvider>,
): BackofficeAuthenticatedRequest {
  return context.get(BackofficeAuthenticatedRequestContext);
}
