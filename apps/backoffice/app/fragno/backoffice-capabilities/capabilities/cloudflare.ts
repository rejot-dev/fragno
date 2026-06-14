import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const cloudflareCapability: BackofficeCapability = {
  id: "cloudflare",
  label: "Cloudflare Workers",
  kind: "connection",
  runtimeToolNamespaces: [],
  connection: {
    configurable: false,
    getStatus: async ({ config }) => ({
      id: "cloudflare",
      label: "Cloudflare Workers",
      kind: "connection",
      configured: config.bindings.cloudflareWorkers,
      config: { configurationScope: "environment" },
      nextSteps: ["Configure Cloudflare Worker bindings and secrets."],
    }),
  },
  hooks: [
    {
      id: "cloudflare",
      label: "Cloudflare Workers",
      getRepository: async ({ objects, orgId }) => {
        const repository = await objects.cloudflareWorkers.forOrg(orgId).getDurableHookRepository();
        return {
          getHookQueue: async (options) => await repository.getHookQueue({ ...options, orgId }),
          getHook: async (hookId, options) =>
            await repository.getHook(hookId, { ...options, orgId }),
        };
      },
    },
  ],
};
