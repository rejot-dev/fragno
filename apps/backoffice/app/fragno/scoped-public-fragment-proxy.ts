import type { RouterContextProvider } from "react-router";

import {
  backofficeScopeFromSinglePathSegment,
  type BackofficeRoutableScope,
} from "@/backoffice-runtime/scope-codec";
import { authorizeAccessTokenForScope } from "@/fragno/auth/access-token.server";
import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../routes/backoffice/auth-navigation";
import { appendBackofficeScopeQuery } from "./scoped-public-fragment-routes";

type FetchableBackofficeObject = {
  fetch(request: Request): Promise<Response>;
};

export type ScopedPublicFragmentProxy<TObject extends FetchableBackofficeObject> = {
  publicPrefix: string;
  internalPrefix: string;
  getObjectForScope(
    context: Readonly<RouterContextProvider>,
    scope: BackofficeRoutableScope,
  ): TObject;
  isAnonymousRequest?: (
    request: Request,
    scope: BackofficeRoutableScope,
    publicPathSuffix: string,
  ) => boolean;
  oauth?: {
    internalCallbackPath: string;
    invalidResponse: (message: string) => Response;
    redirect(input: {
      request: Request;
      scope: BackofficeRoutableScope;
      status: "success" | "error";
      code?: string;
      message?: string;
    }): Response;
  };
};

const isScopedOAuthCallbackRequest = (
  request: Request,
  publicPrefix: string,
  scopePathSegment: string,
) => {
  const url = new URL(request.url);
  return url.pathname === `${publicPrefix}/${encodeURIComponent(scopePathSegment)}/oauth/callback`;
};

const redirectToLogin = (request: Request) => {
  const url = new URL(request.url);
  return Response.redirect(
    new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
    302,
  );
};

const browserSessionHasScopeAccess = async (
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

const readRequiredJsonObject = async (
  response: Response,
  invalidResponse: (message: string) => Response,
  message: string,
) => {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return invalidResponse(`${message}: invalid JSON`);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return invalidResponse(`${message}: expected a JSON object`);
  }

  return payload as Record<string, unknown>;
};

const readFragmentError = async (response: Response, label: string) => {
  const fallback = `${label} failed with status ${response.status}`;
  try {
    const payload = (await response.clone().json()) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { message: fallback };
    }
    const record = payload as Record<string, unknown>;
    const error =
      record.error && typeof record.error === "object" && !Array.isArray(record.error)
        ? (record.error as Record<string, unknown>)
        : record;
    return {
      code: typeof error.code === "string" ? error.code : undefined,
      message: typeof error.message === "string" ? error.message : fallback,
    };
  } catch {
    return { message: fallback };
  }
};

const parsePublicScope = (scopePathSegment: string | undefined) => {
  if (!scopePathSegment) {
    return { ok: false as const, response: new Response("Missing scope", { status: 400 }) };
  }

  try {
    return { ok: true as const, scope: backofficeScopeFromSinglePathSegment(scopePathSegment) };
  } catch {
    return { ok: false as const, response: new Response("Invalid scope", { status: 400 }) };
  }
};

const handleScopedOAuthCallback = async <TObject extends FetchableBackofficeObject>({
  request,
  context,
  scopePathSegment,
  proxy,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  scopePathSegment: string | undefined;
  proxy: ScopedPublicFragmentProxy<TObject> & {
    oauth: NonNullable<ScopedPublicFragmentProxy<TObject>["oauth"]>;
  };
}) => {
  const parsed = parsePublicScope(scopePathSegment);
  if (!parsed.ok) {
    return new Response("Not Found", { status: 404 });
  }

  const { scope } = parsed;
  const access = await browserSessionHasScopeAccess(request, context, scope);
  if (!access.ok) {
    return access.response;
  }

  const callbackUrl = new URL(request.url);
  callbackUrl.pathname = proxy.oauth.internalCallbackPath;
  appendBackofficeScopeQuery(callbackUrl, scope);

  const response = await proxy
    .getObjectForScope(context, scope)
    .fetch(new Request(callbackUrl.toString(), request));
  if (!response.ok) {
    const fragmentError = await readFragmentError(response, "OAuth callback");
    return proxy.oauth.redirect({
      request,
      scope,
      status: "error",
      code: fragmentError.code,
      message: fragmentError.message,
    });
  }

  const payload = await readRequiredJsonObject(
    response,
    proxy.oauth.invalidResponse,
    "Invalid OAuth callback response",
  );
  if (payload instanceof Response) {
    return payload;
  }

  if (typeof payload.authenticated !== "boolean" || typeof payload.mode !== "string") {
    return proxy.oauth.invalidResponse(
      "Invalid OAuth callback response: missing authentication fields",
    );
  }

  return proxy.oauth.redirect({
    request,
    scope,
    status: payload.authenticated && payload.mode === "oauth" ? "success" : "error",
  });
};

export const forwardScopedPublicRequest = async <TObject extends FetchableBackofficeObject>({
  request,
  context,
  scopePathSegment,
  proxy,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  scopePathSegment: string | undefined;
  proxy: ScopedPublicFragmentProxy<TObject>;
}) => {
  if (
    proxy.oauth &&
    scopePathSegment &&
    isScopedOAuthCallbackRequest(request, proxy.publicPrefix, scopePathSegment)
  ) {
    return handleScopedOAuthCallback({
      request,
      context,
      scopePathSegment,
      proxy: { ...proxy, oauth: proxy.oauth },
    });
  }

  const parsed = parsePublicScope(scopePathSegment);
  if (!parsed.ok) {
    return parsed.response;
  }

  const { scope } = parsed;
  const url = new URL(request.url);
  const prefix = `${proxy.publicPrefix}/${encodeURIComponent(scopePathSegment!)}`;
  const publicPathSuffix = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
  const auth = proxy.isAnonymousRequest?.(request, scope, publicPathSuffix)
    ? { ok: true as const, headers: [] }
    : await authorizeAccessTokenForScope(request, context, scope);
  if (!auth.ok) {
    return auth.response;
  }

  if (url.pathname.startsWith(prefix)) {
    url.pathname = `${proxy.internalPrefix}${publicPathSuffix}`;
  }
  appendBackofficeScopeQuery(url, scope);

  const response = await proxy
    .getObjectForScope(context, scope)
    .fetch(new Request(url.toString(), request));
  if (auth.headers.length === 0) {
    return response;
  }

  const headers = new Headers(response.headers);
  for (const [name, value] of auth.headers) {
    headers.append(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
