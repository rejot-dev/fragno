import {
  createMcpAdapter,
  MCP_STATUS_EVENT,
  type McpServerStatusSnapshot,
  type McpStatusSnapshot,
} from "pi-mcp-adapter";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLOUDFLARE_MCP_SERVERS = {
  cloudflare: {
    url: "https://mcp.cloudflare.com/mcp",
    auth: "oauth",
    lifecycle: "eager",
    protocolVersion: "auto",
  },
  "cloudflare-docs": {
    url: "https://docs.mcp.cloudflare.com/mcp",
    auth: "oauth",
    lifecycle: "eager",
    protocolVersion: "auto",
  },
  "cloudflare-observability": {
    url: "https://observability.mcp.cloudflare.com/mcp",
    auth: "oauth",
    lifecycle: "eager",
    protocolVersion: "auto",
  },
} as const;

const CLOUDFLARE_MCP_SERVER_NAMES = Object.keys(CLOUDFLARE_MCP_SERVERS);
const CLOUDFLARE_MCP_STATUS_WAIT_MS = 15_000;
const CLOUDFLARE_MODE_SYSTEM_PROMPT = `The user explicitly launched Cloudflare mode for this session. Use the Cloudflare MCP tools for Cloudflare API operations, documentation lookup, and observability tasks.`;

function hasEveryCloudflareMcpServer(snapshot: McpStatusSnapshot): boolean {
  const reportedServerNames = new Set(snapshot.servers.map((server) => server.name));
  return CLOUDFLARE_MCP_SERVER_NAMES.every((serverName) => reportedServerNames.has(serverName));
}

function formatCloudflareMcpServerStatus(server: McpServerStatusSnapshot | undefined): string {
  if (!server) {
    return "starting";
  }

  switch (server.status) {
    case "connected":
      return `connected (${server.toolCount} tools)`;
    case "needs-auth":
      return `authentication required — run /mcp-auth ${server.name}`;
    case "cached":
      return `using cached metadata (${server.toolCount} tools)`;
    case "failed":
      return "connection failed";
    case "not-connected":
      return "not connected";
    case "disabled":
      return "disabled";
    default:
      return server.status satisfies never;
  }
}

function formatCloudflareMcpStatus(snapshot: McpStatusSnapshot | undefined): string {
  const serversByName = new Map(snapshot?.servers.map((server) => [server.name, server]));
  return [
    "Cloudflare MCP status:",
    `API: ${formatCloudflareMcpServerStatus(serversByName.get("cloudflare"))}`,
    `Docs: ${formatCloudflareMcpServerStatus(serversByName.get("cloudflare-docs"))}`,
    `Observability: ${formatCloudflareMcpServerStatus(serversByName.get("cloudflare-observability"))}`,
  ].join("\n");
}

/** Registers `/cloudflare` as the opt-in boundary for Cloudflare's remote MCP servers. */
export default function registerCloudflareMcpCommand(pi: ExtensionAPI) {
  let cloudflareMcpEnabled = false;
  let latestMcpStatus: McpStatusSnapshot | undefined;
  const statusWaiters = new Set<(snapshot: McpStatusSnapshot) => void>();

  pi.events.on(MCP_STATUS_EVENT, (rawSnapshot) => {
    const snapshot = rawSnapshot as McpStatusSnapshot;
    latestMcpStatus = snapshot;
    for (const resolve of statusWaiters) {
      resolve(snapshot);
    }
  });

  async function waitForCloudflareMcpStatus(): Promise<McpStatusSnapshot | undefined> {
    if (latestMcpStatus && hasEveryCloudflareMcpServer(latestMcpStatus)) {
      return latestMcpStatus;
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        statusWaiters.delete(handleStatus);
        resolve(latestMcpStatus);
      }, CLOUDFLARE_MCP_STATUS_WAIT_MS);

      function handleStatus(snapshot: McpStatusSnapshot) {
        if (!hasEveryCloudflareMcpServer(snapshot)) {
          return;
        }

        clearTimeout(timeout);
        statusWaiters.delete(handleStatus);
        resolve(snapshot);
      }

      statusWaiters.add(handleStatus);
    });
  }

  pi.on("before_agent_start", (event) => {
    if (!cloudflareMcpEnabled) {
      return undefined;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${CLOUDFLARE_MODE_SYSTEM_PROMPT}`,
    };
  });

  pi.registerCommand("cloudflare", {
    description: "Connect the Cloudflare API, documentation, and observability MCP servers",
    handler: async (_args, ctx) => {
      if (!cloudflareMcpEnabled) {
        try {
          createMcpAdapter({
            config: {
              mcpServers: CLOUDFLARE_MCP_SERVERS,
              settings: {
                mcpFooterStatus: "compact",
                showStatusIcon: true,
              },
            },
          })(pi);
          cloudflareMcpEnabled = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Cloudflare MCP activation failed: ${message}`, "error");
          return;
        }
      }

      const status = await waitForCloudflareMcpStatus();
      const hasUnavailableServer = status?.servers.some(
        (server) =>
          CLOUDFLARE_MCP_SERVER_NAMES.includes(server.name) && server.status !== "connected",
      );
      ctx.ui.notify(formatCloudflareMcpStatus(status), hasUnavailableServer ? "warning" : "info");
    },
  });
}
