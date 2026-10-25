import type { BackofficeSystemCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createDurableHookRepositoryFromCommands } from "@/fragno/durable-hook-command-repository";

export const uploadCapability: BackofficeSystemCapability = {
  id: "upload",
  label: "Upload",
  objectBinding: null,
  contributions: {
    connection: null,
    eventSources: [],
    actionProviders: [],
    hookScopes: [
      {
        id: "upload",
        label: "Upload",
        getRepository: ({ objects, scope }) =>
          createDurableHookRepositoryFromCommands(objects.upload.for(scope).commands),
      },
    ],
    skillPaths: [],
    externalEntities: [],
    automationEvents: [],
  },
};
