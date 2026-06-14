import { z } from "zod";

import type {
  BackofficeCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createPiCapabilityFiles } from "@/fragno/backoffice-capabilities/capabilities/pi-files";

const AUTOMATION_SOURCE = "pi" as const;
const AUTOMATION_EVENT_CAPABILITY_CONFIGURED = "capability.configured" as const;

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

const piCapabilityConfiguredPayloadSchema = z.object({
  capabilityId: z.literal("pi"),
  capabilityLabel: z.literal("Pi"),
  harnesses: z.array(
    z.object({
      id: z.string().trim().min(1),
      label: z.string().trim().min(1),
      description: z.string().optional(),
      tools: z.array(z.string()),
    }),
  ),
  modelCatalog: z.array(
    z.object({
      provider: z.enum(["openai", "anthropic", "gemini"]),
      name: z.string().trim().min(1),
      label: z.string().trim().min(1),
    }),
  ),
});

const piCapabilityConfiguredSubjectSchema = z.object({
  orgId: z.string().trim().min(1),
  capabilityId: z.literal("pi"),
});

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
  get files() {
    return createPiCapabilityFiles();
  },
  connection: {
    configurable: true,
    configureInputSchema: piConfigureInputSchema,
    configureFields: [
      { name: "apiKeys.openai", secret: true, description: "OpenAI API key." },
      { name: "apiKeys.anthropic", secret: true, description: "Anthropic API key." },
      { name: "apiKeys.gemini", secret: true, description: "Gemini API key." },
      { name: "harnesses", description: "Harness configuration array." },
    ],
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
  automationEvents: [
    {
      source: AUTOMATION_SOURCE,
      eventType: AUTOMATION_EVENT_CAPABILITY_CONFIGURED,
      label: "Pi configured",
      description: "Fires after Pi is configured for an organisation for the first time.",
      payloadSchema: piCapabilityConfiguredPayloadSchema,
      subjectSchema: piCapabilityConfiguredSubjectSchema,
      example: {
        capabilityId: "pi",
        capabilityLabel: "Pi",
        harnesses: [
          {
            id: "default",
            label: "Default",
            description: "Built-in harness with codemode, read, and bash access.",
            tools: ["execCodeMode", "read", "bash"],
          },
        ],
        modelCatalog: [{ provider: "openai", name: "gpt-5-nano", label: "GPT-5 nano" }],
      },
    },
  ],
};
