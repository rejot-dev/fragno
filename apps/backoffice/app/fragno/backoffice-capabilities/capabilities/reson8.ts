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

const reson8CapabilityConfiguredPayloadSchema = z.object({
  capabilityId: z.literal("reson8"),
  capabilityLabel: z.literal("Reson8"),
});

const reson8CapabilityConfiguredSubjectSchema = z.object({
  orgId: z.string().trim().min(1),
  capabilityId: z.literal("reson8"),
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
      configurable: true,
      configureInputSchema: reson8ConfigureInputSchema,
      configureFields: [
        { name: "apiKey", secret: true, description: "Reson8 API key. Required on first setup." },
      ],
      getStatus: async ({ objects, orgId }) =>
        toReson8Status(await getReson8Do(objects, orgId).getAdminConfig()),
      verify: async ({ objects, orgId }) =>
        toReson8Status(await getReson8Do(objects, orgId).getAdminConfig()),
      reset: async ({ objects, orgId }) =>
        toReson8Status(await getReson8Do(objects, orgId).resetAdminConfig()),
      configure: async ({ objects, orgId, payload }) =>
        toReson8Status(
          await getReson8Do(objects, orgId).setAdminConfig(
            reson8ConfigureInputSchema.parse(payload),
            orgId,
          ),
        ),
    },
    eventSources: [],
    actionProviders: ["reson8"],
    hookScopes: [],
    skillPaths: ["skills/reson8-connection/SKILL.md"],
    externalEntities: [],
    automationEvents: [
      {
        source: "reson8",
        eventType: "capability.configured",
        label: "Reson8 configured",
        description: "Fires after Reson8 is configured for an organisation for the first time.",
        payloadSchema: reson8CapabilityConfiguredPayloadSchema,
        subjectSchema: reson8CapabilityConfiguredSubjectSchema,
        example: {
          capabilityId: "reson8",
          capabilityLabel: "Reson8",
        },
      },
    ],
  },
};
