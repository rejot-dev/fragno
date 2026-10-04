import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

/** Durable Pi contributes scoped agent actions; usage delivery is owned by each agent object. */
export const piCapability: BackofficeCapability = {
  id: "pi",
  label: "Pi",
  objectBinding: "PI_MANAGER",
  contributions: {
    connection: null,
    eventSources: [],
    actionProviders: ["pi"],
    hookScopes: [],
    skillPaths: [],
    externalEntities: [],
    automationEvents: [],
  },
};
