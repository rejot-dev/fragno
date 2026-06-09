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

const piApiKeysSchema = z.object({
  openai: apiKeyValueSchema,
  anthropic: apiKeyValueSchema,
  gemini: apiKeyValueSchema,
});

export const piConfigureInputSchema = z
  .object({
    apiKeys: piApiKeysSchema.optional(),
    harnesses: z.unknown().optional(),
  })
  .passthrough();

const capability = { id: "pi", label: "Pi", kind: "connection" } as const;
const getPiDo = (env: CloudflareEnv, orgId: string) => env.PI.get(env.PI.idFromName(orgId));

type PiAdminConfigResponse = {
  configured?: boolean;
  config?: Record<string, unknown>;
};

const toPiStatus = (response: PiAdminConfigResponse): ConnectionStatus => {
  if (!response.configured) {
    return {
      ...capability,
      configured: false,
      missing: ["apiKeys", "harnesses"],
    };
  }

  return {
    ...capability,
    configured: true,
    ...(response.config ? { config: response.config } : {}),
  };
};

export const piCapability: BackofficeCapability = {
  ...capability,
  runtimeToolNamespaces: ["pi"],
  connection: {
    configurable: true,
    configureInputSchema: piConfigureInputSchema,
    configureFields: [
      { name: "apiKeys.openai", secret: true, description: "OpenAI API key." },
      { name: "apiKeys.anthropic", secret: true, description: "Anthropic API key." },
      { name: "apiKeys.gemini", secret: true, description: "Gemini API key." },
      { name: "harnesses", description: "Harness configuration array." },
    ],
    setup: {
      overview: "Configure Pi model providers and harnesses for this organisation.",
      manualSteps: [
        {
          id: "add-model-key",
          title: "Add model provider key",
          instructions: "Add at least one model provider API key.",
          expectedUserInput: ["apiKeys"],
        },
        {
          id: "configure-harness",
          title: "Configure harnesses",
          instructions: "Configure at least one harness.",
          expectedUserInput: ["harnesses"],
        },
      ],
      verify: {
        tool: "connections.get --id pi",
        description: "Check configured API keys and harnesses.",
      },
    },
    getStatus: async ({ env, orgId }) => toPiStatus(await getPiDo(env, orgId).getAdminConfig()),
    verify: async ({ env, orgId }) => toPiStatus(await getPiDo(env, orgId).getAdminConfig()),
    reset: async ({ env, orgId }) => toPiStatus(await getPiDo(env, orgId).resetAdminConfig()),
    configure: async ({ env, orgId, payload }) =>
      toPiStatus(
        await getPiDo(env, orgId).setAdminConfig({
          ...piConfigureInputSchema.parse(payload),
          orgId,
        }),
      ),
  },
  hooks: [
    {
      id: "pi",
      label: "Pi",
      getRepository: ({ env, orgId }) => getPiDo(env, orgId).getDurableHookRepository("pi"),
    },
    {
      id: "pi-workflows",
      label: "Pi workflows",
      getRepository: ({ env, orgId }) => getPiDo(env, orgId).getDurableHookRepository("workflows"),
    },
  ],
};
