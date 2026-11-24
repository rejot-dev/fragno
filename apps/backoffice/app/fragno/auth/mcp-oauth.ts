import type { BackofficeUserContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

export const LEYWAY_MCP_PATH = "/api/v0/mcp";
export const LEYWAY_MCP_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${LEYWAY_MCP_PATH}`;
export const LEYWAY_OAUTH_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
export const LEYWAY_MCP_OAUTH_SCOPE = "mcp";
export const LEYWAY_MCP_OAUTH_SCOPES = [LEYWAY_MCP_OAUTH_SCOPE, "offline_access"] as const;

/** What Auth needs of an MCP request to verify its Bearer or DPoP credential. */
export const leywayMcpRequestCredentialsSchema = z.object({
  url: z.url(),
  method: z.string().min(1),
  authorization: z.string().nullable(),
  dpop: z.string().nullable(),
});

export type LeywayMcpRequestCredentials = z.infer<typeof leywayMcpRequestCredentialsSchema>;

/** A rejection is the complete HTTP answer, such as the challenge that starts OAuth sign-in. */
export type LeywayMcpRequestAuthorization =
  | { kind: "authorized"; scope: BackofficeUserContextScope }
  | { kind: "rejected"; status: number; headers: [string, string][]; body: string };
