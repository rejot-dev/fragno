import type { RouterContextProvider } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";
import { getMcpDurableObject } from "@/worker-runtime/durable-objects";

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

export const isBackofficeMcpOAuthCallbackRequest = (request: Request, orgId: string) => {
  const url = new URL(request.url);
  return url.pathname === `${MCP_PUBLIC_PREFIX}/${orgId}/oauth/callback`;
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

const assertAuthenticatedOrganisationMember = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
) => {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return { ok: false as const, response: redirectToLogin(request) };
  }

  const isMember = me.organizations.some((entry) => entry.organization.id === orgId);
  if (!isMember) {
    return { ok: false as const, response: new Response("Not Found", { status: 404 }) };
  }

  return { ok: true as const };
};

const buildOAuthCompleteRedirect = ({
  request,
  orgId,
  status,
}: {
  request: Request;
  orgId: string;
  status: "success" | "error";
}) => {
  const redirectUrl = new URL(`/backoffice/connections/mcp/${orgId}/oauth-complete`, request.url);
  redirectUrl.searchParams.set("status", status);

  const serverSlug = getServerSlugFromState(request);
  if (serverSlug) {
    redirectUrl.searchParams.set("server", serverSlug);
  }

  return Response.redirect(redirectUrl, 302);
};

export const handleBackofficeMcpOAuthCallback = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
) => {
  const access = await assertAuthenticatedOrganisationMember(request, context, orgId);
  if (!access.ok) {
    return access.response;
  }

  const mcpDo = getMcpDurableObject(context, orgId);
  const callbackUrl = new URL(request.url);
  callbackUrl.pathname = MCP_INTERNAL_OAUTH_CALLBACK_PATH;
  callbackUrl.searchParams.set("orgId", orgId);

  const response = await mcpDo.fetch(new Request(callbackUrl.toString(), request));
  if (!response.ok) {
    return buildOAuthCompleteRedirect({ request, orgId, status: "error" });
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
    orgId,
    status: payload.authenticated && payload.mode === "oauth" ? "success" : "error",
  });
};
