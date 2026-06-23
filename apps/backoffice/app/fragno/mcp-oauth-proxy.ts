import type { RouterContextProvider } from "react-router";

import {
  backofficeScopeFromSinglePathSegment,
  backofficeScopeRouteId,
  type BackofficeRoutableScope,
} from "@/backoffice-runtime/scope-codec";
import { getAuthMe } from "@/fragno/auth/auth-server";
import { getMcpObjectForScope } from "@/routes/backoffice/connections/mcp/data";

import { buildBackofficeLoginPath } from "../routes/backoffice/auth-navigation";

const MCP_PUBLIC_PREFIX = "/api/mcp";
const MCP_INTERNAL_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

const invalidMcpResponse = (message: string) => new Response(message, { status: 502 });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readRequiredJsonObject = async (response: Response, message: string) => {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return invalidMcpResponse(`${message}: invalid JSON`);
  }

  if (!isRecord(payload)) {
    return invalidMcpResponse(`${message}: expected a JSON object`);
  }

  return payload;
};

export const isBackofficeMcpOAuthCallbackRequest = (request: Request, scopePathSegment: string) => {
  const url = new URL(request.url);
  return (
    url.pathname === `${MCP_PUBLIC_PREFIX}/${encodeURIComponent(scopePathSegment)}/oauth/callback`
  );
};

const getServerSlugFromState = (request: Request) => {
  const state = new URL(request.url).searchParams.get("state") ?? "";
  return state.split(":")[0]?.trim() || null;
};

const redirectToLogin = (request: Request) => {
  const url = new URL(request.url);
  return Response.redirect(
    new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
    302,
  );
};

const assertAuthenticatedScopeAccess = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeRoutableScope,
) => {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return { ok: false as const, response: redirectToLogin(request) };
  }

  const hasAccess =
    scope.kind === "user"
      ? me.user.id === scope.userId
      : me.organizations.some((entry) => entry.organization.id === scope.orgId);
  if (!hasAccess) {
    return { ok: false as const, response: new Response("Not Found", { status: 404 }) };
  }

  return { ok: true as const };
};

const buildOAuthCompleteRedirect = ({
  request,
  scope,
  status,
}: {
  request: Request;
  scope: BackofficeRoutableScope;
  status: "success" | "error";
}) => {
  const redirectUrl = new URL(
    `/backoffice/automations/${scope.kind}/${encodeURIComponent(backofficeScopeRouteId(scope))}/mcp`,
    request.url,
  );
  redirectUrl.searchParams.set("oauth", status);

  const serverSlug = getServerSlugFromState(request);
  if (serverSlug) {
    redirectUrl.searchParams.set("server", serverSlug);
  }

  return Response.redirect(redirectUrl, 302);
};

export const handleBackofficeMcpOAuthCallback = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
  scopePathSegment: string,
) => {
  let scope;
  try {
    scope = backofficeScopeFromSinglePathSegment(scopePathSegment);
  } catch {
    return new Response("Not Found", { status: 404 });
  }

  const access = await assertAuthenticatedScopeAccess(request, context, scope);
  if (!access.ok) {
    return access.response;
  }

  const mcpDo = getMcpObjectForScope(context, scope);
  const callbackUrl = new URL(request.url);
  callbackUrl.pathname = MCP_INTERNAL_OAUTH_CALLBACK_PATH;
  callbackUrl.searchParams.set("scopeKind", scope.kind);
  if (scope.kind === "org" || scope.kind === "project") {
    callbackUrl.searchParams.set("orgId", scope.orgId);
  }
  if (scope.kind === "project") {
    callbackUrl.searchParams.set("projectId", scope.projectId);
  }
  if (scope.kind === "user") {
    callbackUrl.searchParams.set("userId", scope.userId);
  }

  const response = await mcpDo.fetch(new Request(callbackUrl.toString(), request));
  if (!response.ok) {
    return buildOAuthCompleteRedirect({ request, scope, status: "error" });
  }

  const payload = await readRequiredJsonObject(response, "Invalid MCP OAuth callback response");
  if (payload instanceof Response) {
    return payload;
  }

  if (typeof payload.authenticated !== "boolean" || typeof payload.mode !== "string") {
    return invalidMcpResponse("Invalid MCP OAuth callback response: missing authentication fields");
  }

  return buildOAuthCompleteRedirect({
    request,
    scope,
    status: payload.authenticated && payload.mode === "oauth" ? "success" : "error",
  });
};
