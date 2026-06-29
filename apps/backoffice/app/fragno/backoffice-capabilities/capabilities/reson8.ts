import { z } from "zod";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type {
  BackofficeCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createReson8CapabilityFiles } from "@/fragno/backoffice-capabilities/capabilities/reson8-files";

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

const capability = { id: "reson8", label: "Reson8", kind: "connection" } as const;
const getReson8Do = (objects: BackofficeObjectRegistry, orgId: string) =>
  objects.reson8.forOrg(orgId);

type Reson8AdminConfigResponse = {
  configured?: boolean;
  config?: Record<string, unknown>;
};

const toReson8Status = (response: Reson8AdminConfigResponse): ConnectionStatus => {
  if (!response.configured) {
    return {
      ...capability,
      configured: false,
      missing: ["apiKey"],
    };
  }

  return {
    ...capability,
    configured: true,
    ...(response.config ? { config: response.config } : {}),
  };
};

export const reson8Capability: BackofficeCapability = {
  ...capability,
  runtimeToolNamespaces: ["reson8"],
  get files() {
    return createReson8CapabilityFiles();
  },
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
};
