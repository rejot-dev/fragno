import { z } from "zod";

import type { BackofficeApiOperation } from "../api";

export const externalIdentitySchema = z.strictObject({
  scope: z.literal("external"),
  source: z.string().trim().min(1),
  type: z.string().trim().min(1),
  id: z.string().trim().min(1),
});

const createClaimInputSchema = z.strictObject({
  ttlMinutes: z.number().int().positive().optional(),
});

const identityClaimRecordSchema = z.object({
  url: z.string().trim().min(1),
  otpId: z.string().trim().min(1),
  externalId: z.string().trim().min(1),
  code: z.string().trim().min(1),
  actor: externalIdentitySchema,
  type: z.string().trim().min(1).optional(),
  expiresAt: z.string().trim().min(1).optional(),
});

export const otpOperations = {
  "otp.identity.create-claim": {
    description: "Create a short-lived identity claim URL for the trusted external initiator.",
    input: createClaimInputSchema,
    output: identityClaimRecordSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
