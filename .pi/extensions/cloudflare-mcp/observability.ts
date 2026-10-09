export const CLOUDFLARE_OBSERVABILITY_SERVER = {
  name: "cloudflare-observability",
  config: {
    url: "https://observability.mcp.cloudflare.com/mcp",
    description: "Inspect Cloudflare Workers logs and observability data",
    exposure: "codemode",
  },
} as const;
