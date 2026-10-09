import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { CLOUDFLARE_OBSERVABILITY_SERVER } from "./observability.js";

const CLOUDFLARE_MCP_SERVERS = {
  cloudflare: {
    url: "https://mcp.cloudflare.com/mcp",
    description: "Search and execute Cloudflare API operations",
    exposure: "codemode",
  },
  "cloudflare-docs": {
    url: "https://docs.mcp.cloudflare.com/mcp",
    description: "Search Cloudflare documentation",
    exposure: "codemode",
  },
  [CLOUDFLARE_OBSERVABILITY_SERVER.name]: CLOUDFLARE_OBSERVABILITY_SERVER.config,
} as const;

const CLOUDFLARE_MODE_SYSTEM_PROMPT =
  "The user explicitly launched Cloudflare mode for this session. Use the Cloudflare MCP tools through codemode for Cloudflare API operations, documentation lookup, and observability tasks.";

/** Registers `/cloudflare` as the opt-in boundary for Cloudflare's remote MCP servers. */
export default function registerCloudflareMcpCommand(pi: ExtensionAPI) {
  let cloudflareMcpEnabled = false;

  pi.on("before_agent_start", (event) => {
    if (cloudflareMcpEnabled) {
      event.systemPromptOptions.sections["cloudflare_mode"] = CLOUDFLARE_MODE_SYSTEM_PROMPT;
    }
  });

  pi.registerCommand("cloudflare", {
    description: "Connect the Cloudflare API, documentation, and observability MCP servers",
    handler: async (_args, ctx) => {
      if (!cloudflareMcpEnabled) {
        try {
          for (const [name, config] of Object.entries(CLOUDFLARE_MCP_SERVERS)) {
            if (!pi.getMcpServers().some((server) => server.name === name)) {
              pi.registerMcpServer(name, config);
            }
          }
          cloudflareMcpEnabled = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Cloudflare MCP activation failed: ${message}`, "error");
          return;
        }
      }

      ctx.ui.notify(
        "Cloudflare MCP servers registered. Use /mcp to inspect connections and sign in; /mcp login <server> authenticates a server.",
        "info",
      );
    },
  });
}
