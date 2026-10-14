import { z } from "zod";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type {
  BackofficeCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createDurableHookRepositoryFromCommands } from "@/fragno/durable-hook-command-repository";
const uploadProviderSchema = z.enum(["database", "r2", "r2-binding"]);

export const uploadConfigureInputSchema = z.looseObject({
  provider: uploadProviderSchema.optional(),
  defaultProvider: uploadProviderSchema.optional(),
});

const uploadCapabilityConfiguredPayloadSchema = z.object({
  capabilityId: z.literal("upload"),
  capabilityLabel: z.literal("Upload"),
});

const uploadCapabilityConfiguredSubjectSchema = z.object({
  orgId: z.string().trim().min(1),
  capabilityId: z.literal("upload"),
});

const connectionStatusIdentity = {
  id: "upload",
  label: "Upload",
  kind: "connection",
} as const;
const getUploadDo = (objects: BackofficeObjectRegistry, orgId: string) =>
  objects.upload.forOrg(orgId);

type UploadAdminConfigResponse = {
  configured?: boolean;
  config?: Record<string, unknown>;
  providers?: Record<string, { configured?: boolean }>;
};

const isUploadConfigured = (response: UploadAdminConfigResponse) =>
  response.configured === true ||
  Object.values(response.providers ?? {}).some((provider) => provider.configured === true);

const toUploadStatus = (response: UploadAdminConfigResponse): ConnectionStatus => {
  if (!isUploadConfigured(response)) {
    return {
      ...connectionStatusIdentity,
      configured: false,
      missing: ["provider"],
    };
  }

  return {
    ...connectionStatusIdentity,
    configured: true,
    ...(response.config ? { config: response.config } : {}),
  };
};

export const uploadCapability: BackofficeCapability = {
  id: connectionStatusIdentity.id,
  label: connectionStatusIdentity.label,
  objectBinding: null,
  contributions: {
    connection: {
      getStatus: async ({ objects, orgId }) =>
        toUploadStatus(await getUploadDo(objects, orgId).commands.getAdminConfig()),
    },
    eventSources: [],
    actionProviders: ["upload"],
    hookScopes: [
      {
        id: "upload",
        label: "Upload",
        getRepository: ({ objects, orgId }) =>
          createDurableHookRepositoryFromCommands(getUploadDo(objects, orgId).commands),
      },
    ],
    skillPaths: ["skills/using-prepared-uploads/SKILL.md"],
    externalEntities: [],
    automationEvents: [
      {
        source: "upload",
        eventType: "capability.configured",
        label: "Upload configured",
        description: "Fires after Upload is configured for an organization for the first time.",
        payloadSchema: uploadCapabilityConfiguredPayloadSchema,
        subjectSchema: uploadCapabilityConfiguredSubjectSchema,
        example: {
          capabilityId: "upload",
          capabilityLabel: "Upload",
        },
      },
    ],
  },
};
