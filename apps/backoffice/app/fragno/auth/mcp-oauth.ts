export const LEYWAY_MCP_PATH = "/api/v0/mcp";
export const LEYWAY_MCP_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${LEYWAY_MCP_PATH}`;
export const LEYWAY_OAUTH_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
export const LEYWAY_MCP_OAUTH_SCOPE = "mcp";
export const LEYWAY_MCP_OAUTH_SCOPES = [LEYWAY_MCP_OAUTH_SCOPE, "offline_access"] as const;
