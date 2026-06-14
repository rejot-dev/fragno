import { z } from "zod";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type {
  BackofficeCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createUploadCapabilityFiles } from "@/fragno/backoffice-capabilities/capabilities/upload-files";

const uploadProviderSchema = z.enum(["database", "r2", "r2-binding"]);

export const uploadConfigureInputSchema = z
  .object({
    provider: uploadProviderSchema.optional(),
    defaultProvider: uploadProviderSchema.optional(),
  })
  .passthrough();

const capability = { id: "upload", label: "Upload", kind: "connection" } as const;
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
      ...capability,
      configured: false,
      missing: ["provider"],
    };
  }

  return {
    ...capability,
    configured: true,
    ...(response.config ? { config: response.config } : {}),
  };
};

export const uploadCapability: BackofficeCapability = {
  ...capability,
  runtimeToolNamespaces: [],
  get files() {
    return createUploadCapabilityFiles();
  },
  connection: {
    configurable: true,
    configureInputSchema: uploadConfigureInputSchema,
    configureFields: [
      { name: "provider", description: "Provider to configure: database, r2-binding, or r2." },
      { name: "defaultProvider", description: "Default provider to use after configuration." },
      { name: "r2", secret: true, description: "R2 provider credentials/configuration payload." },
      { name: "r2Binding", description: "R2 binding provider configuration payload." },
    ],
    getStatus: async ({ objects, orgId }) =>
      toUploadStatus(await getUploadDo(objects, orgId).getAdminConfig()),
    verify: async ({ objects, orgId }) =>
      toUploadStatus(await getUploadDo(objects, orgId).getAdminConfig()),
    reset: async ({ objects, orgId }) =>
      toUploadStatus(await getUploadDo(objects, orgId).resetAdminConfig()),
    configure: async ({ objects, orgId, origin, payload }) =>
      toUploadStatus(
        await getUploadDo(objects, orgId).setAdminConfig(
          uploadConfigureInputSchema.parse(payload),
          orgId,
          origin,
        ),
      ),
  },
  hooks: [
    {
      id: "upload",
      label: "Upload",
      getRepository: ({ objects, orgId }) => getUploadDo(objects, orgId).getDurableHookRepository(),
    },
  ],
};
