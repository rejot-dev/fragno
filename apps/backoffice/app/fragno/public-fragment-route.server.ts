import type { RouterContextProvider } from "react-router";

import type { BackofficeObjectHandle } from "@/backoffice-runtime/object-registry";
import {
  backofficeRuntimeScopeFromResolvedScope,
  resolveBackofficeRouteScope,
} from "@/backoffice-runtime/resolved-scope";
import {
  backofficeRouteScopeFromSinglePathSegment,
  type BackofficeRoutableRouteScope,
} from "@/backoffice-runtime/route-scope";
import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import { authorizeBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import {
  appendBackofficeScopeQuery,
  scopedPublicFragmentPathSuffix,
} from "./scoped-public-fragment-routes";

export type PublicFragmentRoute<TCommands> = {
  publicPrefix: string;
  internalPrefix: string;
  getObjectForScope(
    context: Readonly<RouterContextProvider>,
    scope: BackofficeRoutableScope,
  ): BackofficeObjectHandle<TCommands>;
  /** Management forwarding cannot be overridden. Only explicit public ingress is configurable. */
  publicIngress:
    | ((
        | { kind: "fragment" }
        | {
            kind: "redirect";
            redirect(input: {
              request: Request;
              routeScope: BackofficeRoutableRouteScope;
            }): Response;
          }
      ) & { matches(request: Request, scope: BackofficeRoutableScope, suffix: string): boolean })
    | null;
  isScopeSupported?: (scope: BackofficeRoutableScope) => boolean;
  oauth?: {
    internalCallbackPath: string;
    invalidResponse: (message: string) => Response;
    redirect(input: {
      request: Request;
      scope: BackofficeRoutableScope;
      routeScope: BackofficeRoutableRouteScope;
      status: "success" | "error";
      code?: string;
      message?: string;
    }): Response;
  };
};

async function readRequiredJsonObject(
  response: Response,
  invalidResponse: (message: string) => Response,
  message: string,
) {
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
}

async function readFragmentError(response: Response, label: string) {
  const fallback = `${label} failed with status ${response.status}`;
  try {
    const payload = await response.clone().json();
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
}

function parsePublicRouteScope(scopePathSegment: string | undefined) {
  if (!scopePathSegment) {
    return { ok: false as const, response: new Response("Missing scope", { status: 400 }) };
  }

  try {
    return {
      ok: true as const,
      scopePathSegment,
      routeScope: backofficeRouteScopeFromSinglePathSegment(scopePathSegment),
    };
  } catch {
    return { ok: false as const, response: new Response("Invalid scope", { status: 400 }) };
  }
}

async function resolvePublicRouteScope(
  context: Readonly<RouterContextProvider>,
  routeScope: BackofficeRoutableRouteScope,
): Promise<BackofficeRoutableScope | null> {
  if (routeScope.kind === "user") {
    return backofficeRuntimeScopeFromResolvedScope(routeScope);
  }

  const organization = await context
    .get(BackofficeWorkerContext)
    .runtime.objects.auth.singleton()
    .commands.getOrganizationBySlug(routeScope.orgSlug);
  if (!organization) {
    return null;
  }

  const resolvedScope = resolveBackofficeRouteScope(routeScope, [organization]);
  return resolvedScope ? backofficeRuntimeScopeFromResolvedScope(resolvedScope) : null;
}

async function handleScopedOAuthCallback<TCommands>({
  request,
  context,
  routeScope,
  route,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  routeScope: BackofficeRoutableRouteScope;
  route: PublicFragmentRoute<TCommands> & {
    oauth: NonNullable<PublicFragmentRoute<TCommands>["oauth"]>;
  };
}) {
  const scope = await resolvePublicRouteScope(context, routeScope);
  if (!scope || (route.isScopeSupported && !route.isScopeSupported(scope))) {
    return new Response("Not Found", { status: 404 });
  }

  // OAuth providers cannot be expected to retain Backoffice authentication. The fragment's
  // single-use state authorizes the callback inside the resolved, ID-backed scope.
  const callbackUrl = new URL(request.url);
  callbackUrl.pathname = route.oauth.internalCallbackPath;
  appendBackofficeScopeQuery(callbackUrl, scope);

  const response = await route
    .getObjectForScope(context, scope)
    .http.fetch(new Request(callbackUrl.toString(), request));
  if (!response.ok) {
    const fragmentError = await readFragmentError(response, "OAuth callback");
    return route.oauth.redirect({
      request,
      scope,
      routeScope,
      status: "error",
      code: fragmentError.code,
      message: fragmentError.message,
    });
  }

  const payload = await readRequiredJsonObject(
    response,
    route.oauth.invalidResponse,
    "Invalid OAuth callback response",
  );
  if (payload instanceof Response) {
    return payload;
  }

  if (typeof payload.authenticated !== "boolean" || typeof payload.mode !== "string") {
    return route.oauth.invalidResponse(
      "Invalid OAuth callback response: missing authentication fields",
    );
  }

  return route.oauth.redirect({
    request,
    scope,
    routeScope,
    status: payload.authenticated && payload.mode === "oauth" ? "success" : "error",
  });
}

export async function forwardPublicFragmentRequest<TCommands>({
  request,
  context,
  scopePathSegment,
  route,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  scopePathSegment: string | undefined;
  route: PublicFragmentRoute<TCommands>;
}) {
  const parsed = parsePublicRouteScope(scopePathSegment);
  if (!parsed.ok) {
    return parsed.response;
  }

  const url = new URL(request.url);
  const publicPathSuffix = scopedPublicFragmentPathSuffix({
    pathname: url.pathname,
    publicPrefix: route.publicPrefix,
    scopePathSegment: parsed.scopePathSegment,
  });
  if (publicPathSuffix === null) {
    return new Response("Not Found", { status: 404 });
  }
  if (route.oauth && request.method === "GET" && publicPathSuffix === "/oauth/callback") {
    return handleScopedOAuthCallback({
      request,
      context,
      routeScope: parsed.routeScope,
      route: { ...route, oauth: route.oauth },
    });
  }

  const scope = await resolvePublicRouteScope(context, parsed.routeScope);
  if (!scope || (route.isScopeSupported && !route.isScopeSupported(scope))) {
    return new Response("Not Found", { status: 404 });
  }
  const ingress = route.publicIngress;
  const isPublicIngress = ingress?.matches(request, scope, publicPathSuffix) ?? false;
  if (isPublicIngress && ingress?.kind === "redirect") {
    return ingress.redirect({ request, routeScope: parsed.routeScope });
  }
  const auth = isPublicIngress
    ? { ok: true as const, execution: null, headers: [] }
    : await authorizeBackofficeContext(request, context, scope);
  if (!auth.ok) {
    return auth.response;
  }

  url.pathname = `${route.internalPrefix}${publicPathSuffix}`;
  appendBackofficeScopeQuery(url, scope);

  const object = route.getObjectForScope(context, scope);
  const outboundRequest = new Request(url.toString(), request);
  const response = auth.execution
    ? await object.http.fetchAuthorized(outboundRequest, {
        execution: auth.execution,
        propagationContext: null,
      })
    : await object.http.fetch(outboundRequest);
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
}
