import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const githubCapability: BackofficeCapability = {
  id: "github",
  label: "GitHub",
  kind: "connection",
  runtimeToolNamespaces: [],
  connection: {
    configurable: false,
    getStatus: async ({ env }) => ({
      id: "github",
      label: "GitHub",
      kind: "connection",
      configured: Boolean(env.GITHUB),
      config: { configurationScope: "environment" },
      nextSteps: ["Configure the GitHub App environment and installation."],
    }),
  },
  hooks: [
    {
      id: "github",
      label: "GitHub",
      getRepository: ({ env, orgId }) =>
        env.GITHUB.get(env.GITHUB.idFromName(orgId)).getDurableHookRepository(),
    },
  ],
};
