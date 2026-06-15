import { z } from "zod";

import type { IdentityCreateClaimArgs } from "@/fragno/runtime-tools/automation-types";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

export type AutomationIdentityClaimRecord = {
  url: string;
  otpId: string;
  externalId: string;
  code: string;
  actor: IdentityCreateClaimArgs["actor"];
  type?: string;
  expiresAt?: string;
};

export type OtpRuntime = {
  createClaim: (input: IdentityCreateClaimArgs) => Promise<AutomationIdentityClaimRecord>;
};

type OtpToolContext = BackofficeToolContext<{ otp?: OtpRuntime }>;

const actorSchema = z.object({
  scope: z.literal("external"),
  source: z.string().trim().min(1),
  type: z.string().trim().min(1),
  id: z.string().trim().min(1),
});

const createClaimInputSchema = z.object({
  actor: actorSchema,
  ttlMinutes: z.number().int().positive().optional(),
});

const identityClaimRecordSchema = z.object({
  url: z.string().trim().min(1),
  otpId: z.string().trim().min(1),
  externalId: z.string().trim().min(1),
  code: z.string().trim().min(1),
  actor: actorSchema,
  type: z.string().trim().min(1).optional(),
  expiresAt: z.string().trim().min(1).optional(),
});

const getOtpRuntime = (runtime: OtpToolContext["runtimes"]["otp"]): OtpRuntime => {
  if (!runtime) {
    throw new Error("OTP runtime is not available in this execution context");
  }
  return runtime;
};

const parseOtpIdentityCreateClaim = defineCliArgsParser<IdentityCreateClaimArgs>(
  "otp.identity.create-claim",
  {
    actor: { kind: "json", option: "actor-json", required: true },
    ttlMinutes: { kind: "positiveInteger" },
  },
);

const createClaimTool = defineBackofficeRuntimeTool({
  id: "otp.identity.create-claim",
  namespace: "otp",
  name: "createIdentityClaim",
  description: "Create a short-lived identity claim URL for an external actor.",
  requiredPermissions: ["create"],
  inputSchema: createClaimInputSchema,
  outputSchema: identityClaimRecordSchema,
  execute: async (input, context: OtpToolContext) =>
    await getOtpRuntime(context.runtimes.otp).createClaim(input),
  adapters: {
    bash: {
      command: "otp.identity.create-claim",
      help: {
        summary:
          "otp.identity.create-claim creates a short-lived identity claim URL for an external actor.",
        options: [
          {
            name: "actor-json",
            required: true,
            valueRequired: true,
            valueName: "json",
            description: "Full actor entity ref JSON",
          },
          {
            name: "ttl-minutes",
            valueRequired: true,
            valueName: "minutes",
            description: "Optional claim TTL, in minutes",
          },
        ],
        examples: [
          'otp.identity.create-claim --actor-json \'{"scope":"external","source":"telegram","type":"chat","id":"chat-123"}\'',
          'otp.identity.create-claim --actor-json \'{"scope":"external","source":"telegram","type":"chat","id":"chat-123"}\' --ttl-minutes 15 --print url',
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
  permissions: {
    create: "Create OTP identity claims.",
  },
  tools: otpRuntimeTools,
  isAvailable: (context: OtpToolContext) => !!context.runtimes.otp,
});
