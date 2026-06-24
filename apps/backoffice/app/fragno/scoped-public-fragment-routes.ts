import {
  backofficeScopeSinglePathSegment,
  type BackofficeRoutableScope,
} from "@/backoffice-runtime/scope-codec";

export const API_PUBLIC_PREFIX = "/api/http";
export const API_INTERNAL_PREFIX = "/api/api";
export const API_INTERNAL_OAUTH_CALLBACK_PATH = "/api/api/oauth/callback";

export const MCP_PUBLIC_PREFIX = "/api/mcp";
export const MCP_INTERNAL_PREFIX = "/api/mcp";
export const MCP_INTERNAL_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

export const appendBackofficeScopeQuery = (url: URL, scope: BackofficeRoutableScope) => {
  url.searchParams.set("scope", backofficeScopeSinglePathSegment(scope));
};

export const scopedPublicBaseUrl = ({
  baseUrl,
  publicPrefix,
  scope,
}: {
  baseUrl: string;
  publicPrefix: string;
  scope: BackofficeRoutableScope;
}) => {
  const parsed = new URL(baseUrl);
  const mountPath = `${publicPrefix}/${encodeURIComponent(backofficeScopeSinglePathSegment(scope))}`;
  const trimmedPath = parsed.pathname.replace(/\/+$/, "");
  if (trimmedPath !== mountPath) {
    parsed.pathname = `${trimmedPath}${mountPath}`.replace(/\/+/g, "/");
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
};
