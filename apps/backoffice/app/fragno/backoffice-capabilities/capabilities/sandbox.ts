import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const sandboxCapability: BackofficeCapability = {
  id: "sandbox",
  label: "Sandbox",
  kind: "connection",
  runtimeToolNamespaces: ["sandbox"],
  connection: {
    configurable: false,
    getStatus: async ({ config }) => ({
      id: "sandbox",
      label: "Sandbox",
      kind: "connection",
      configured: config.bindings.sandbox && config.bindings.automations,
      config: { configurationScope: "environment" },
      nextSteps: ["Configure Cloudflare Sandbox and Automations bindings."],
    }),
  },
};
