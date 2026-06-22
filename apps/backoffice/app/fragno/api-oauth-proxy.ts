import type { RouterContextProvider } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";
import { getApiDurableObject } from "@/worker-runtime/durable-objects";

import { buildBackofficeLoginPath } from "../routes/backoffice/auth-navigation";

const API_PUBLIC_PREFIX = "/api/http";
const API_INTERNAL_OAUTH_CALLBACK_PATH = "/api/api/oauth/callback";

const invalidApiResponse = (message: string) => new Response(message, { status: 502 });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readRequiredJsonObject = async (response: Response, message: string) => {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return invalidApiResponse(`${message}: invalid JSON`);
  }

  if (!isRecord(payload)) {
    return invalidApiResponse(`${message}: expected a JSON object`);
  }

  return payload;
};

export const isBackofficeApiOAuthCallbackRequest = (request: Request, orgId: string) => {
  const url = new URL(request.url);
  return url.pathname === `${API_PUBLIC_PREFIX}/${orgId}/oauth/callback`;
};

const getConnectionSlugFromState = (request: Request) => {
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
  code,
  message,
}: {
  request: Request;
  orgId: string;
  status: "success" | "error";
  code?: string;
  message?: string;
}) => {
  const redirectUrl = new URL("/backoffice/connections/api/oauth-complete", request.url);
  redirectUrl.searchParams.set("status", status);

  redirectUrl.searchParams.set("orgId", orgId);

  const connectionSlug = getConnectionSlugFromState(request);
  if (connectionSlug) {
    redirectUrl.searchParams.set("connection", connectionSlug);
  }
  if (code) {
    redirectUrl.searchParams.set("code", code);
  }
  if (message) {
    redirectUrl.searchParams.set("message", message);
  }

  return Response.redirect(redirectUrl, 302);
};

const readFragmentError = async (response: Response) => {
  const fallback = `API OAuth callback failed with status ${response.status}`;
  try {
    const payload = await response.clone().json();
    if (!isRecord(payload)) {
      return { message: fallback };
    }
    const error = isRecord(payload.error) ? payload.error : payload;
    return {
      code: typeof error.code === "string" ? error.code : undefined,
      message: typeof error.message === "string" ? error.message : fallback,
    };
  } catch {
    return { message: fallback };
  }
};

export const handleBackofficeApiOAuthCallback = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
) => {
  const access = await assertAuthenticatedOrganisationMember(request, context, orgId);
  if (!access.ok) {
    return access.response;
  }

  const apiDo = getApiDurableObject(context, orgId);
  const callbackUrl = new URL(request.url);
  callbackUrl.pathname = API_INTERNAL_OAUTH_CALLBACK_PATH;
  callbackUrl.searchParams.set("orgId", orgId);

  const response = await apiDo.fetch(new Request(callbackUrl.toString(), request));
  if (!response.ok) {
    const fragmentError = await readFragmentError(response);
    return buildOAuthCompleteRedirect({
      request,
      orgId,
      status: "error",
      code: fragmentError.code,
      message: fragmentError.message,
    });
  }

  const payload = await readRequiredJsonObject(response, "Invalid API OAuth callback response");
  if (payload instanceof Response) {
    return payload;
  }

  if (typeof payload.authenticated !== "boolean" || typeof payload.mode !== "string") {
    return invalidApiResponse("Invalid API OAuth callback response: missing authentication fields");
  }

  return buildOAuthCompleteRedirect({
    request,
    orgId,
    status: payload.authenticated && payload.mode === "oauth" ? "success" : "error",
  });
};
