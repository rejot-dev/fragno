import { z } from "zod";

import type {
  BackofficeCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";

const uploadProviderSchema = z.enum(["database", "r2", "r2-binding"]);

export const uploadConfigureInputSchema = z
  .object({
    provider: uploadProviderSchema.optional(),
    defaultProvider: uploadProviderSchema.optional(),
  })
  .passthrough();

const capability = { id: "upload", label: "Upload", kind: "connection" } as const;
const getUploadDo = (env: CloudflareEnv, orgId: string) =>
  env.UPLOAD.get(env.UPLOAD.idFromName(orgId));

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
  connection: {
    configurable: true,
    configureInputSchema: uploadConfigureInputSchema,
    configureFields: [
      { name: "provider", description: "Provider to configure: database, r2-binding, or r2." },
      { name: "defaultProvider", description: "Default provider to use after configuration." },
      { name: "r2", secret: true, description: "R2 provider credentials/configuration payload." },
      { name: "r2Binding", description: "R2 binding provider configuration payload." },
    ],
    setup: {
      overview: "Configure file upload storage for this organisation.",
      manualSteps: [
        {
          id: "choose-provider",
          title: "Choose provider",
          instructions: "Choose a provider: database, r2-binding, or r2.",
          expectedUserInput: ["provider"],
        },
        {
          id: "collect-provider-config",
          title: "Collect provider config",
          instructions: "Collect the provider-specific configuration payload.",
        },
      ],
      verify: {
        tool: "connections.get --id upload",
        description: "Check configured providers and default provider.",
      },
    },
    getStatus: async ({ env, orgId }) =>
      toUploadStatus(await getUploadDo(env, orgId).getAdminConfig()),
    verify: async ({ env, orgId }) =>
      toUploadStatus(await getUploadDo(env, orgId).getAdminConfig()),
    reset: async ({ env, orgId }) =>
      toUploadStatus(await getUploadDo(env, orgId).resetAdminConfig()),
    configure: async ({ env, orgId, origin, payload }) =>
      toUploadStatus(
        await getUploadDo(env, orgId).setAdminConfig(
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
      getRepository: ({ env, orgId }) => getUploadDo(env, orgId).getDurableHookRepository(),
    },
  ],
};
