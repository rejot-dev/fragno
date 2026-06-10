import { getMcpDurableObject } from "@/cloudflare/cloudflare-utils";
import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../backoffice/auth-navigation";
import type { Route } from "./+types/mcp";

type RouteContext = Route.LoaderArgs["context"];

type OAuthCallbackPayload = {
  authenticated?: unknown;
  mode?: unknown;
};

const MCP_PUBLIC_PREFIX = "/api/mcp";
const MCP_INTERNAL_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

const isMcpOAuthCallbackRequest = (request: Request, orgId: string) => {
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
  context: RouteContext,
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

const readOAuthCallbackPayload = async (response: Response) => {
  if (!response.ok) {
    return null;
  }

  return (await response
    .clone()
    .json()
    .catch(() => null)) as OAuthCallbackPayload | null;
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

const handleOAuthCallback = async (request: Request, context: RouteContext, orgId: string) => {
  const access = await assertAuthenticatedOrganisationMember(request, context, orgId);
  if (!access.ok) {
    return access.response;
  }

  const mcpDo = getMcpDurableObject(context, orgId);
  const callbackUrl = new URL(request.url);
  callbackUrl.pathname = MCP_INTERNAL_OAUTH_CALLBACK_PATH;
  callbackUrl.searchParams.set("orgId", orgId);

  const response = await mcpDo.fetch(new Request(callbackUrl.toString(), request));
  const payload = await readOAuthCallbackPayload(response);
  const authenticated = payload?.authenticated === true && payload.mode === "oauth";

  return buildOAuthCompleteRedirect({
    request,
    orgId,
    status: authenticated ? "success" : "error",
  });
};

const forwardToMcp = async (request: Request, context: RouteContext, orgId: string | undefined) => {
  if (!orgId) {
    return new Response("Missing organisation id", { status: 400 });
  }

  if (isMcpOAuthCallbackRequest(request, orgId)) {
    return handleOAuthCallback(request, context, orgId);
  }

  const mcpDo = getMcpDurableObject(context, orgId);
  const url = new URL(request.url);
  const prefix = `${MCP_PUBLIC_PREFIX}/${orgId}`;
  if (url.pathname.startsWith(prefix)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = `${MCP_PUBLIC_PREFIX}${suffix}`;
  }
  url.searchParams.set("orgId", orgId);

  return mcpDo.fetch(new Request(url.toString(), request));
};

export async function loader({ request, context, params }: Route.LoaderArgs) {
  return forwardToMcp(request, context, params.orgId);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  return forwardToMcp(request, context, params.orgId);
}
