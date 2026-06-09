import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const cloudflareCapability: BackofficeCapability = {
  id: "cloudflare",
  label: "Cloudflare Workers",
  kind: "connection",
  runtimeToolNamespaces: [],
  connection: {
    configurable: false,
    setup: {
      overview: "Cloudflare Workers integration is configured through Worker environment bindings.",
      manualSteps: [
        {
          id: "configure-bindings",
          title: "Configure Cloudflare bindings",
          instructions:
            "Set the required Cloudflare account/API bindings and Durable Object bindings in the Worker environment.",
        },
      ],
      verify: {
        tool: "connections.get --id cloudflare",
        description: "Check the environment-managed Cloudflare connection status.",
      },
    },
    getStatus: async ({ env }) => ({
      id: "cloudflare",
      label: "Cloudflare Workers",
      kind: "connection",
      configured: Boolean(env.CLOUDFLARE_WORKERS),
      config: { configurationScope: "environment" },
      nextSteps: ["Configure Cloudflare Worker bindings and secrets."],
    }),
  },
  hooks: [
    {
      id: "cloudflare",
      label: "Cloudflare Workers",
      getRepository: async ({ env, orgId }) => {
        const repository = await env.CLOUDFLARE_WORKERS.get(
          env.CLOUDFLARE_WORKERS.idFromName(orgId),
        ).getDurableHookRepository();
        return {
          getHookQueue: async (options) => await repository.getHookQueue({ ...options, orgId }),
          getHook: async (hookId, options) =>
            await repository.getHook(hookId, { ...options, orgId }),
        };
      },
    },
  ],
};
