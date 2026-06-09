import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const githubCapability: BackofficeCapability = {
  id: "github",
  label: "GitHub",
  kind: "connection",
  runtimeToolNamespaces: [],
  connection: {
    configurable: false,
    setup: {
      overview:
        "GitHub is configured through environment GitHub App settings and installation flows.",
      manualSteps: [
        {
          id: "configure-github-app",
          title: "Configure GitHub App",
          instructions:
            "Set the GitHub App environment secrets/bindings and install the app for the organisation.",
        },
      ],
      verify: {
        tool: "connections.get --id github",
        description: "Check the environment-managed GitHub connection status.",
      },
    },
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
