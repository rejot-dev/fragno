import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const automationsCapability: BackofficeCapability = {
  id: "automations",
  label: "Automations",
  kind: "system",
  runtimeToolNamespaces: ["store", "workflow", "hooks", "events"],
  hooks: [
    {
      id: "automations",
      label: "Automations",
      getRepository: ({ env, orgId }) =>
        env.AUTOMATIONS.get(env.AUTOMATIONS.idFromName(orgId)).getDurableHookRepository(
          "automation",
        ),
    },
  ],
};
