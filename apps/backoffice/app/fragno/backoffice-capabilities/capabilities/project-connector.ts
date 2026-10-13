import type { BackofficeCapability } from "../backoffice-capabilities";

/** Connector stores identity-bound provider accounts in the owning user's scope. */
export const connectorCapability: BackofficeCapability = {
  id: "connector",
  label: "Connector",
  objectBinding: "PROJECT_CONNECTOR",
  contributions: {
    connection: null,
    eventSources: [],
    actionProviders: ["integrations"],
    hookScopes: [],
    skillPaths: ["skills/configuring-integrations/SKILL.md"],
    externalEntities: [],
    automationEvents: [],
  },
};
