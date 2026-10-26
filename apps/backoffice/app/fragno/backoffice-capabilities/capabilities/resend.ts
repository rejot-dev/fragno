import type { BackofficeOrganizationContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type {
  BackofficeCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createDurableHookRepositoryFromCommands } from "@/fragno/durable-hook-command-repository";
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

const connectionStatusIdentity = {
  id: "resend",
  label: "Resend",
  kind: "connection",
} as const;
const getResendDo = (
  objects: BackofficeObjectRegistry,
  organization: BackofficeOrganizationContextScope,
) => objects.resend.for(organization);

type ResendAdminConfigResponse = {
  configured?: boolean;
  config?: Record<string, unknown>;
};

const toResendStatus = (response: ResendAdminConfigResponse): ConnectionStatus => {
  if (!response.configured) {
    return {
      ...connectionStatusIdentity,
      configured: false,
      missing: ["apiKey", "defaultFrom", "webhookBaseUrl", "webhookSecret"],
    };
  }

  return {
    ...connectionStatusIdentity,
    configured: true,
    ...(response.config ? { config: response.config } : {}),
  };
};

export const resendCapability: BackofficeCapability = {
  id: connectionStatusIdentity.id,
  label: connectionStatusIdentity.label,
  objectBinding: null,
  contributions: {
    connection: {
      getStatus: async ({ objects, organization }) =>
        toResendStatus(await getResendDo(objects, organization).commands.getAdminConfig()),
    },
    eventSources: [],
    actionProviders: ["integrations"],
    hookScopes: [
      {
        id: "resend",
        label: "Resend",
        getRepository: ({ objects, organization }) =>
          createDurableHookRepositoryFromCommands(getResendDo(objects, organization).commands),
      },
    ],
    skillPaths: [],
    externalEntities: [],
    automationEvents: [],
  },
};
