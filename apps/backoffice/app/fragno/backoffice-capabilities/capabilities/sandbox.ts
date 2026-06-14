import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const sandboxCapability: BackofficeCapability = {
  id: "sandbox",
  label: "Sandbox",
  kind: "connection",
  runtimeToolNamespaces: ["sandbox"],
  connection: {
    configurable: false,
    getStatus: async ({ env }) => ({
      id: "sandbox",
      label: "Sandbox",
      kind: "connection",
      configured: Boolean(env.SANDBOX && env.SANDBOX_REGISTRY),
      config: { configurationScope: "environment" },
      nextSteps: ["Configure Cloudflare Sandbox and Sandbox Registry bindings."],
    }),
  },
};
