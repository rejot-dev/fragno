import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { backofficeContextScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";

export const API_PUBLIC_PREFIX = "/api/http";
export const API_INTERNAL_PREFIX = "/api/api";
export const API_INTERNAL_OAUTH_CALLBACK_PATH = "/api/api/oauth/callback";

export const MCP_PUBLIC_PREFIX = "/api/mcp";
export const MCP_INTERNAL_PREFIX = "/api/mcp";
export const MCP_INTERNAL_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

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

export const scopedPublicBaseUrl = ({
  baseUrl,
  publicPrefix,
  scope,
}: {
  baseUrl: string;
  publicPrefix: string;
  scope: BackofficeContextScope;
}) => {
  const parsed = new URL(baseUrl);
  const mountPath = scopedPublicMountPath({ publicPrefix, scope });
  const trimmedPath = parsed.pathname.replace(/\/+$/, "");
  if (trimmedPath !== mountPath) {
    parsed.pathname = `${trimmedPath}${mountPath}`.replace(/\/+/g, "/");
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
};
