import { z } from "zod";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type {
  BackofficeCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createResendCapabilityFiles } from "@/fragno/backoffice-capabilities/capabilities/resend-files";

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
const getResendDo = (objects: BackofficeObjectRegistry, orgId: string) =>
  objects.resend.forOrg(orgId);

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
  get files() {
    return createResendCapabilityFiles();
  },
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
    getStatus: async ({ objects, orgId }) =>
      toResendStatus(await getResendDo(objects, orgId).getAdminConfig()),
    verify: async ({ objects, orgId }) =>
      toResendStatus(await getResendDo(objects, orgId).getAdminConfig()),
    reset: async ({ objects, orgId }) =>
      toResendStatus(await getResendDo(objects, orgId).resetAdminConfig()),
    configure: async ({ objects, orgId, origin, payload }) =>
      toResendStatus(
        await getResendDo(objects, orgId).setAdminConfig(
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
      getRepository: ({ objects, orgId }) => getResendDo(objects, orgId).getDurableHookRepository(),
    },
  ],
};
