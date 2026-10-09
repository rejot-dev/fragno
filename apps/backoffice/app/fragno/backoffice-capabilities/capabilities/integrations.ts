import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { integrationConnectionEvents } from "@/fragno/runtime-tools/families/integrations/integration-events";

export const integrationsCapability: BackofficeCapability = {
  id: "integrations",
  label: "Integrations",
  objectBinding: null,
  contributions: {
    connection: null,
    eventSources: [
      {
        source: "integrations",
        label: "Integrations",
        description: "Connection state changes reported by every integration service.",
      },
    ],
    actionProviders: [],
    hookScopes: [],
    skillPaths: [],
    externalEntities: [],
    automationEvents: integrationConnectionEvents,
  },
};
