import { z } from "zod";

import type { IdentityCreateClaimArgs } from "@/fragno/runtime-tools/automation-types";
import {
  assertNoPositionals,
  parseCliTokens,
  readIntegerOption,
  readStringOption,
} from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeRuntimeTool,
  type BackofficeToolContext,
} from "../runtime-tools";

export type AutomationIdentityClaimRecord = {
  url: string;
  externalId: string;
  code: string;
  type?: string;
  expiresAt?: string;
};

export type OtpRuntime = {
  createClaim: (input: IdentityCreateClaimArgs) => Promise<AutomationIdentityClaimRecord>;
};

type OtpToolContext = BackofficeToolContext<{ otp?: OtpRuntime }>;

const nonEmptyString = z.string().trim().min(1);

const createClaimInputSchema = z.object({
  source: nonEmptyString,
  externalActorId: nonEmptyString,
  ttlMinutes: z.number().int().positive().optional(),
});

const identityClaimRecordSchema = z.object({
  url: nonEmptyString,
  externalId: nonEmptyString,
  code: nonEmptyString,
  type: nonEmptyString.optional(),
  expiresAt: nonEmptyString.optional(),
});

const defineOtpRuntimeTool = <TInputSchema extends z.ZodType, TOutputSchema extends z.ZodType>(
  tool: BackofficeRuntimeTool<TInputSchema, TOutputSchema, OtpToolContext>,
) => defineBackofficeRuntimeTool(tool);

const getOtpRuntime = (runtime: OtpToolContext["runtimes"]["otp"]): OtpRuntime => {
  if (!runtime) {
    throw new Error("OTP runtime is not available in this execution context");
  }
  return runtime;
};

const parseOtpIdentityCreateClaim = (args: string[]): IdentityCreateClaimArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "otp.identity.create-claim");

  const ttlMinutes = readIntegerOption(parsed, "ttl-minutes");
  if (typeof ttlMinutes !== "undefined" && ttlMinutes <= 0) {
    throw new Error("--ttl-minutes must be a positive integer");
  }

  return {
    source: readStringOption(parsed, "source", true)!,
    externalActorId: readStringOption(parsed, "external-actor-id", true)!,
    ...(typeof ttlMinutes !== "undefined" ? { ttlMinutes } : {}),
  };
};

const createClaimTool = defineOtpRuntimeTool({
  id: "otp.identity.create-claim",
  namespace: "otp",
  name: "createIdentityClaim",
  description: "Create a short-lived identity claim URL for an external actor.",
  inputSchema: createClaimInputSchema,
  outputSchema: identityClaimRecordSchema,
  execute: async (input, context) => getOtpRuntime(context.runtimes.otp).createClaim(input),
  adapters: {
    bash: {
      command: "otp.identity.create-claim",
      help: {
        summary:
          "otp.identity.create-claim creates a short-lived identity claim URL for an external actor.",
        options: [
          {
            name: "source",
            required: true,
            valueRequired: true,
            valueName: "source",
            description: "Identity source name (e.g. telegram)",
          },
          {
            name: "external-actor-id",
            required: true,
            valueRequired: true,
            valueName: "external-actor-id",
            description: "External actor identifier from the source",
          },
          {
            name: "ttl-minutes",
            valueRequired: true,
            valueName: "minutes",
            description: "Optional claim TTL, in minutes",
          },
        ],
        examples: [
          "otp.identity.create-claim --source telegram --external-actor-id chat-123",
          "otp.identity.create-claim --source telegram --external-actor-id chat-123 --ttl-minutes 15 --print url",
        ],
      },
      parse: parseOtpIdentityCreateClaim,
      format: (result) => ({ data: result }),
    },
  },
});

export const otpRuntimeTools = [createClaimTool] as const;

export const otpToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "otp",
  tools: otpRuntimeTools,
  isAvailable: (context: OtpToolContext) => !!context.runtimes.otp,
});
