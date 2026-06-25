import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const automationsCapability: BackofficeCapability = {
  id: "automations",
  label: "Automations",
  kind: "system",
  runtimeToolNamespaces: ["store", "router", "workflow", "hooks", "events"],
  hooks: [
    {
      id: "automations",
      label: "Automations",
      getRepository: ({ objects, orgId }) =>
        objects.automations.forOrg(orgId).getDurableHookRepository("automation"),
    },
  ],
};
