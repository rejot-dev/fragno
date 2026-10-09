import type { IdentityCreateClaimArgs } from "@/fragno/runtime-tools/automation-types";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

export type AutomationIdentityClaimRecord = {
  url: string;
  otpId: string;
  externalId: string;
  code: string;
  actor: {
    scope: "external";
    source: string;
    type: string;
    id: string;
  };
  type?: string;
  expiresAt?: string;
};

export type OtpRuntime = {
  createClaim: (input: IdentityCreateClaimArgs) => Promise<AutomationIdentityClaimRecord>;
};

type OtpToolContext = BackofficeToolContext<{ otp?: OtpRuntime }>;

const getOtpRuntime = (runtime: OtpToolContext["runtimes"]["otp"]): OtpRuntime => {
  if (!runtime) {
    throw new Error("OTP runtime is not available in this execution context");
  }
  return runtime;
};

const parseOtpIdentityCreateClaim = defineCliArgsParser<IdentityCreateClaimArgs>(
  "otp.identity.create-claim",
  {
    ttlMinutes: { kind: "positiveInteger" },
  },
);

const createClaimTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("otp.identity.create-claim"),
  namespace: "otp",
  name: "createIdentityClaim",
  execute: async (input, context: OtpToolContext) =>
    await getOtpRuntime(context.runtimes.otp).createClaim(input),
  adapters: {
    bash: {
      command: "otp.identity.create-claim",
      help: {
        summary:
          "otp.identity.create-claim creates a short-lived identity claim URL for the trusted external initiator.",
        options: [
          {
            name: "ttl-minutes",
            valueRequired: true,
            valueName: "minutes",
            description: "Optional claim TTL, in minutes",
          },
        ],
        examples: [
          "otp.identity.create-claim",
          "otp.identity.create-claim --ttl-minutes 15 --print url",
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
