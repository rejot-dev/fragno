import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { backofficeContextScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";

export const API_PUBLIC_PREFIX = "/api/http";
export const API_INTERNAL_PREFIX = "/api/api";
export const API_INTERNAL_OAUTH_CALLBACK_PATH = "/api/api/oauth/callback";

export const MCP_PUBLIC_PREFIX = "/api/mcp";
export const MCP_INTERNAL_PREFIX = "/api/mcp";
export const MCP_INTERNAL_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

export type ScopedPublicFragmentAddress = {
  baseUrl: string;
  oauthRedirectUri: string;
};

export const appendBackofficeScopeQuery = (url: URL, scope: BackofficeContextScope) => {
  url.searchParams.set("scope", backofficeContextScopeSinglePathSegment(scope));
};

export const scopedPublicMountPath = ({
  publicPrefix,
  scope,
}: {
  publicPrefix: string;
  scope: BackofficeContextScope;
}) => `${publicPrefix}/${encodeURIComponent(backofficeContextScopeSinglePathSegment(scope))}`;

export const scopedPublicBaseUrlForPathSegment = ({
  baseUrl,
  publicPrefix,
  scopePathSegment,
}: {
  baseUrl: string;
  publicPrefix: string;
  scopePathSegment: string;
}) => {
  const parsed = new URL(baseUrl);
  const mountPath = `${publicPrefix}/${encodeURIComponent(scopePathSegment)}`;
  const trimmedPath = parsed.pathname.replace(/\/+$/, "");
  if (trimmedPath !== mountPath) {
    parsed.pathname = `${trimmedPath}${mountPath}`.replace(/\/+/g, "/");
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
};

function requirePublicFragmentOrigin(
  publicOrigin: string | undefined,
  fragmentName: "API" | "MCP",
): string {
  const normalized = publicOrigin?.trim();
  if (!normalized) {
    throw new Error(`${fragmentName} public origin is not configured.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${fragmentName} public origin must be a valid HTTP or HTTPS URL.`);
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(`${fragmentName} public origin must be a valid HTTP or HTTPS URL.`);
  }
  return normalized;
}

function scopedPublicFragmentAddress({
  publicOrigin,
  publicPrefix,
  scopePathSegment,
}: {
  publicOrigin: string;
  publicPrefix: string;
  scopePathSegment: string;
}): ScopedPublicFragmentAddress {
  const baseUrl = scopedPublicBaseUrlForPathSegment({
    baseUrl: publicOrigin,
    publicPrefix,
    scopePathSegment,
  });
  return {
    baseUrl,
    oauthRedirectUri: `${baseUrl}/oauth/callback`,
  };
}

/** Builds the slug-backed public API addresses outside the ID-backed API object. */
export function apiPublicAddress(
  publicOrigin: string | undefined,
  scopePathSegment: string,
): ScopedPublicFragmentAddress {
  return scopedPublicFragmentAddress({
    publicOrigin: requirePublicFragmentOrigin(publicOrigin, "API"),
    publicPrefix: API_PUBLIC_PREFIX,
    scopePathSegment,
  });
}

/** Builds the slug-backed public MCP addresses outside the ID-backed MCP object. */
export function mcpPublicAddress(
  publicOrigin: string | undefined,
  scopePathSegment: string,
): ScopedPublicFragmentAddress {
  return scopedPublicFragmentAddress({
    publicOrigin: requirePublicFragmentOrigin(publicOrigin, "MCP"),
    publicPrefix: MCP_PUBLIC_PREFIX,
    scopePathSegment,
  });
}

/** Allows only one scoped OAuth callback path on the configured Backoffice public origin. */
export function isScopedPublicOAuthRedirectUriAllowed({
  publicOrigin,
  publicPrefix,
  redirectUri,
}: {
  publicOrigin: string | undefined;
  publicPrefix: string;
  redirectUri: URL;
}): boolean {
  let configuredPublicUrl: URL;
  try {
    configuredPublicUrl = new URL(publicOrigin ?? "");
  } catch {
    return false;
  }

  if (
    (configuredPublicUrl.protocol !== "http:" && configuredPublicUrl.protocol !== "https:") ||
    configuredPublicUrl.username ||
    configuredPublicUrl.password ||
    redirectUri.origin !== configuredPublicUrl.origin ||
    redirectUri.username ||
    redirectUri.password ||
    redirectUri.search ||
    redirectUri.hash
  ) {
    return false;
  }

  const configuredPath = configuredPublicUrl.pathname.replace(/\/+$/, "");
  const callbackPrefix = `${configuredPath}${publicPrefix}/`.replace(/\/+/g, "/");
  const callbackSuffix = "/oauth/callback";
  if (
    !redirectUri.pathname.startsWith(callbackPrefix) ||
    !redirectUri.pathname.endsWith(callbackSuffix)
  ) {
    return false;
  }

  const scopePathSegment = redirectUri.pathname.slice(
    callbackPrefix.length,
    -callbackSuffix.length,
  );
  return scopePathSegment.length > 0 && !scopePathSegment.includes("/");
}

/** Builds the externally reachable URL for one API webhook endpoint. */
export function apiWebhookPublicUrl(publicBaseUrl: string, endpointId: string): string {
  return `${publicBaseUrl}/webhooks/endpoints/${encodeURIComponent(endpointId)}/events`;
}
