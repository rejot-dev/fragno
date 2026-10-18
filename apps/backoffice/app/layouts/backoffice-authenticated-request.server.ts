import { createContext, type RouterContext, type RouterContextProvider } from "react-router";

import { getBackofficeMe } from "@/fragno/auth/auth-server";
import { reopenWithBackofficeCredential } from "@/fragno/auth/browser-credential.server";
import type { BackofficeMeData } from "@/fragno/auth/contracts";

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
  args: { request: Request; context: Readonly<RouterContextProvider>; url: URL },
  next: () => Promise<Response>,
): Promise<Response> {
  const { request, context } = args;
  const authentication = await getBackofficeMe(request, context);
  if (authentication.status !== "authenticated") {
    throw await reopenWithBackofficeCredential(args, { selection: "preferred" });
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
