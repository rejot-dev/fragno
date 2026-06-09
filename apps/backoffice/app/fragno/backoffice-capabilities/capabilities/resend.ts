import { z } from "zod";

import type {
  BackofficeCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";

const optionalTrimmedString = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .optional();

const requiredHttpUrl = z
  .string()
  .trim()
  .min(1, "Webhook base URL is required.")
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Webhook base URL must include http:// or https://." },
  );

export const resendConfigureInputSchema = z.object({
  apiKey: optionalTrimmedString,
  defaultFrom: optionalTrimmedString,
  defaultReplyTo: z.union([z.string(), z.array(z.string())]).optional(),
  webhookBaseUrl: requiredHttpUrl,
});

const capability = { id: "resend", label: "Resend", kind: "connection" } as const;
const getResendDo = (env: CloudflareEnv, orgId: string) =>
  env.RESEND.get(env.RESEND.idFromName(orgId));

type ResendAdminConfigResponse = {
  configured?: boolean;
  config?: Record<string, unknown>;
};

const toResendStatus = (response: ResendAdminConfigResponse): ConnectionStatus => {
  if (!response.configured) {
    return {
      ...capability,
      configured: false,
      missing: ["apiKey", "defaultFrom", "webhookBaseUrl", "webhookSecret"],
    };
  }

  return {
    ...capability,
    configured: true,
    ...(response.config ? { config: response.config } : {}),
  };
};

export const resendCapability: BackofficeCapability = {
  ...capability,
  runtimeToolNamespaces: ["resend"],
  connection: {
    configurable: true,
    configureInputSchema: resendConfigureInputSchema,
    configureFields: [
      { name: "apiKey", secret: true, description: "Resend API key. Required on first setup." },
      { name: "defaultFrom", description: "Default sender address. Required on first setup." },
      { name: "defaultReplyTo", description: "Optional default reply-to address or addresses." },
      {
        name: "webhookBaseUrl",
        required: true,
        description: "Public http(s) base URL used when registering Resend webhooks.",
      },
    ],
    setup: {
      overview: "Connect Resend email delivery to this organisation.",
      manualSteps: [
        {
          id: "create-api-key",
          title: "Create API key",
          instructions: "Create a Resend API key.",
          expectedUserInput: ["apiKey"],
        },
        {
          id: "choose-default-from",
          title: "Choose default sender and public URL",
          instructions:
            "Choose a default from address for outgoing email and provide the public Backoffice origin or tunnel URL.",
          expectedUserInput: ["defaultFrom", "webhookBaseUrl"],
        },
      ],
      verify: {
        tool: "connections.get --id resend",
        description: "Check configured=true and webhook secret status.",
      },
    },
    getStatus: async ({ env, orgId }) =>
      toResendStatus(await getResendDo(env, orgId).getAdminConfig()),
    verify: async ({ env, orgId }) =>
      toResendStatus(await getResendDo(env, orgId).getAdminConfig()),
    reset: async ({ env, orgId }) =>
      toResendStatus(await getResendDo(env, orgId).resetAdminConfig()),
    configure: async ({ env, orgId, origin, payload }) =>
      toResendStatus(
        await getResendDo(env, orgId).setAdminConfig(
          resendConfigureInputSchema.parse(payload),
          orgId,
          origin,
        ),
      ),
  },
  hooks: [
    {
      id: "resend",
      label: "Resend",
      getRepository: ({ env, orgId }) => getResendDo(env, orgId).getDurableHookRepository(),
    },
  ],
};
