import { z } from "zod";

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

const capability = { id: "reson8", label: "Reson8", kind: "connection" } as const;
const getReson8Do = (env: CloudflareEnv, orgId: string) =>
  env.RESON8.get(env.RESON8.idFromName(orgId));

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
  connection: {
    configurable: true,
    configureInputSchema: reson8ConfigureInputSchema,
    configureFields: [
      { name: "apiKey", secret: true, description: "Reson8 API key. Required on first setup." },
    ],
    setup: {
      overview: "Connect Reson8 to this organisation.",
      manualSteps: [
        {
          id: "create-api-key",
          title: "Create API key",
          instructions: "Create a Reson8 API key.",
          expectedUserInput: ["apiKey"],
        },
      ],
      verify: {
        tool: "connections.get --id reson8",
        description: "Check configured=true.",
      },
    },
    getStatus: async ({ env, orgId }) =>
      toReson8Status(await getReson8Do(env, orgId).getAdminConfig()),
    verify: async ({ env, orgId }) =>
      toReson8Status(await getReson8Do(env, orgId).getAdminConfig()),
    reset: async ({ env, orgId }) =>
      toReson8Status(await getReson8Do(env, orgId).resetAdminConfig()),
    configure: async ({ env, orgId, payload }) =>
      toReson8Status(
        await getReson8Do(env, orgId).setAdminConfig(
          reson8ConfigureInputSchema.parse(payload),
          orgId,
        ),
      ),
  },
};
