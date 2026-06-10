import { z } from "zod";

import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

const AUTOMATION_SOURCE = "otp" as const;
const AUTOMATION_EVENT_IDENTITY_CLAIM_COMPLETED = "identity.claim.completed" as const;

const identityClaimCompletedPayloadSchema = z.object({
  otpId: z.string().trim().min(1),
  claimType: z.string().trim().min(1),
});

const identityClaimCompletedActorSchema = z.object({
  scope: z.literal("external"),
  source: z.string().trim().min(1),
  type: z.string().trim().min(1),
  id: z.string().trim().min(1),
});

const identityClaimCompletedSubjectSchema = z.object({
  userId: z.string().trim().min(1),
});

export const otpCapability: BackofficeCapability = {
  id: "otp",
  label: "OTP",
  kind: "system",
  runtimeToolNamespaces: ["otp"],
  hooks: [
    {
      id: "otp",
      label: "OTP",
      getRepository: ({ env, orgId }) =>
        env.OTP.get(env.OTP.idFromName(orgId)).getDurableHookRepository(),
    },
  ],
  automationEvents: [
    {
      source: AUTOMATION_SOURCE,
      eventType: AUTOMATION_EVENT_IDENTITY_CLAIM_COMPLETED,
      label: "OTP identity claim completed",
      payloadSchema: identityClaimCompletedPayloadSchema,
      actorSchema: identityClaimCompletedActorSchema,
      subjectSchema: identityClaimCompletedSubjectSchema,
      example: {
        otpId: "otp_123",
        claimType: "identity_link",
      },
    },
  ],
};
