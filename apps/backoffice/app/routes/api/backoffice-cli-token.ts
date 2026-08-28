import {
  BackofficeCliScopeAuthorizationError,
  BackofficeCliOAuthAuthenticationError,
  backofficeCliTokenInputSchema,
} from "@/fragno/auth/contracts";
import { getAuthDurableObject } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/backoffice-cli-token";

function hasErrorName(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

function authenticationFailureResponse(message: string): Response {
  return Response.json(
    { error: "authentication_failed", message },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

export async function action({ request, context }: Route.ActionArgs) {
  const authorization = request.headers.get("authorization");
  const bearerMatch = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!bearerMatch) {
    return authenticationFailureResponse("A valid OAuth bearer token is required.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "invalid_request", message: "The request body must be valid JSON." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const input = backofficeCliTokenInputSchema.safeParse(body);
  if (!input.success) {
    return Response.json(
      { error: "invalid_request", message: "scope must be a valid Backoffice scope or null." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const result = await getAuthDurableObject(context).commands.exchangeBackofficeOAuthAccessToken({
      requestUrl: request.url,
      oauthAccessToken: bearerMatch[1],
      scope: input.data.scope,
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (
      error instanceof BackofficeCliOAuthAuthenticationError ||
      hasErrorName(error, "BackofficeCliOAuthAuthenticationError")
    ) {
      return authenticationFailureResponse("The OAuth access token is invalid or expired.");
    }
    if (
      error instanceof BackofficeCliScopeAuthorizationError ||
      hasErrorName(error, "BackofficeCliScopeAuthorizationError")
    ) {
      return Response.json(
        { error: "scope_unavailable", message: error instanceof Error ? error.message : "" },
        { status: 403, headers: { "cache-control": "no-store" } },
      );
    }
    throw error;
  }
}
