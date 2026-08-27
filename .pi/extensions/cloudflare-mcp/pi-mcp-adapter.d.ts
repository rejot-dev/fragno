declare module "pi-mcp-adapter" {
  import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

  export const MCP_STATUS_EVENT: "pi-mcp-adapter/status/v1";

  export type McpServerRuntimeStatus =
    | "connected"
    | "cached"
    | "failed"
    | "needs-auth"
    | "not-connected"
    | "disabled";

  export interface McpServerStatusSnapshot {
    readonly name: string;
    readonly status: McpServerRuntimeStatus;
    readonly toolCount: number;
    readonly disabled: boolean;
  }

  export interface McpStatusSnapshot {
    readonly version: 1;
    readonly servers: ReadonlyArray<McpServerStatusSnapshot>;
    readonly totalTools: number;
    readonly totalResources: number;
    readonly connectedCount: number;
    readonly disabledCount: number;
  }

  interface EagerOAuthMcpServerDefinition {
    url: string;
    auth: "oauth";
    lifecycle: "eager";
    protocolVersion: "auto";
  }

  interface McpAdapterOptions {
    config: {
      mcpServers: Record<string, EagerOAuthMcpServerDefinition>;
      settings: {
        mcpFooterStatus: "compact";
        showStatusIcon: true;
      };
    };
  }

  export function createMcpAdapter(options: McpAdapterOptions): (pi: ExtensionAPI) => void;
}
