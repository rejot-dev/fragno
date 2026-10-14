import { z } from "zod";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type {
  BackofficeCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
const apiKeyValueSchema = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .optional();

export const reson8ConfigureInputSchema = z.object({
  apiKey: apiKeyValueSchema,
});

const connectionStatusIdentity = {
  id: "reson8",
  label: "Reson8",
  kind: "connection",
} as const;
const getReson8Do = (objects: BackofficeObjectRegistry, orgId: string) =>
  objects.reson8.forOrg(orgId);

type Reson8AdminConfigResponse = {
  configured?: boolean;
  config?: Record<string, unknown>;
};

const toReson8Status = (response: Reson8AdminConfigResponse): ConnectionStatus => {
  if (!response.configured) {
    return {
      ...connectionStatusIdentity,
      configured: false,
      missing: ["apiKey"],
    };
  }

  return {
    ...connectionStatusIdentity,
    configured: true,
    ...(response.config ? { config: response.config } : {}),
  };
};

export const reson8Capability: BackofficeCapability = {
  id: connectionStatusIdentity.id,
  label: connectionStatusIdentity.label,
  objectBinding: null,
  contributions: {
    connection: {
      getStatus: async ({ objects, orgId }) =>
        toReson8Status(await getReson8Do(objects, orgId).commands.getAdminConfig()),
    },
    eventSources: [],
    actionProviders: ["integrations"],
    hookScopes: [],
    skillPaths: [],
    externalEntities: [],
    automationEvents: [],
  },
};
