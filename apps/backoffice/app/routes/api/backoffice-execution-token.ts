import {
  BackofficeExecutionTokenScopeError,
  BackofficeExecutionTokenAuthenticationError,
  backofficeExecutionTokenRequestSchema,
} from "@/fragno/auth/execution-token";
import { getAuthDurableObject } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/backoffice-execution-token";

function hasErrorName(error: unknown, name: string): error is Error {
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
  const input = backofficeExecutionTokenRequestSchema.safeParse(body);
  if (!input.success) {
    return Response.json(
      { error: "invalid_request", message: "scope must be a valid Backoffice scope or null." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const result = await getAuthDurableObject(context).commands.exchangeBackofficeExecutionToken({
      requestUrl: request.url,
      oauthAccessToken: bearerMatch[1],
      scope: input.data.scope,
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (
      error instanceof BackofficeExecutionTokenAuthenticationError ||
      hasErrorName(error, "BackofficeExecutionTokenAuthenticationError")
    ) {
      return authenticationFailureResponse(error.message);
    }
    if (
      error instanceof BackofficeExecutionTokenScopeError ||
      hasErrorName(error, "BackofficeExecutionTokenScopeError")
    ) {
      return Response.json(
        { error: "scope_unavailable", message: error.message },
        { status: 403, headers: { "cache-control": "no-store" } },
      );
    }
    throw error;
  }
}
