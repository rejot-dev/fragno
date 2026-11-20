import {
  LEYWAY_MCP_RESOURCE_METADATA_PATH,
  LEYWAY_OAUTH_SERVER_METADATA_PATH,
} from "@/fragno/auth/mcp-oauth";

/** Whether the API router serves this request. */
export function isBackofficeApiPath(pathname: string): boolean {
  return (
    pathname === LEYWAY_MCP_RESOURCE_METADATA_PATH ||
    pathname === LEYWAY_OAUTH_SERVER_METADATA_PATH ||
    /^\/api\/v\d+(?:\/|$)/u.test(pathname)
  );
}
