import { z } from "zod";

import {
  createOtpFragment,
  type OtpFragmentConfig,
  type ResolvedOtpConfirmedHookPayload,
} from "@fragno-dev/otp-fragment";

import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";

import type { AutomationExternalEntityRef, AutomationKnownEvent } from "./automation/contracts";
import { AUTOMATION_SOURCES, AUTOMATION_SOURCE_EVENT_TYPES } from "./automation/contracts";

export const IDENTITY_LINK_TYPE = "identity_link" as const;
export const EMAIL_VERIFICATION_TYPE = "email_verification" as const;
export const DEFAULT_IDENTITY_LINK_EXPIRY_MINUTES = 15;
export const EMAIL_VERIFICATION_EXPIRY_HOURS = 24;
export const EMAIL_VERIFICATION_EXPIRY_MINUTES = EMAIL_VERIFICATION_EXPIRY_HOURS * 60;

const identityClaimActorSchema = z.object({
  scope: z.literal("external"),
  source: z.string().trim().min(1),
  type: z.string().trim().min(1),
  id: z.string().trim().min(1),
});

export const identityClaimPayloadSchema = z.object({
  orgId: z.string().trim().min(1),
  actor: identityClaimActorSchema,
});

export type IdentityClaimOtpPayload = z.infer<typeof identityClaimPayloadSchema>;
export type IdentityClaimPayload = Pick<IdentityClaimOtpPayload, "actor">;

export const identityClaimConfirmationPayloadSchema = z.object({
  subjectUserId: z.string().trim().min(1),
});

export const emailVerificationPayloadSchema = z.object({
  email: z.email(),
  publicBaseUrl: z.url(),
  expiresInHours: z.number().int().positive(),
});

export type EmailVerificationOtpPayload = z.infer<typeof emailVerificationPayloadSchema>;

export const buildEmailVerificationUrl = (publicBaseUrl: string, userId: string, code: string) => {
  const url = new URL("/backoffice/verify-email", publicBaseUrl);
  url.searchParams.set("userId", userId);
  url.searchParams.set("code", code);
  return url.toString();
};

export const buildIdentityClaimCompletionUrl = (
  publicBaseUrl: string,
  orgId: string,
  externalId: string,
  code: string,
) => {
  const url = new URL(publicBaseUrl);
  url.pathname = `/backoffice/automations/${encodeURIComponent(orgId)}/claims/complete`;
  url.searchParams.set("externalId", externalId);
  url.searchParams.set("code", code);
  return url.toString();
};

type SerializableResolvedOtpConfirmedPayload = Pick<
  ResolvedOtpConfirmedHookPayload,
  "id" | "type"
> & {
  confirmedAt: Date | string;
};

const toIsoString = (value: Date | string, fieldName: string) => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid OTP hook date for ${fieldName}`);
  }

  return parsed.toISOString();
};

export const buildIdentityClaimCompletedAutomationEvent = (input: {
  orgId: string;
  userId: string;
  otp: SerializableResolvedOtpConfirmedPayload;
  claim: IdentityClaimPayload;
  eventId?: string;
}): AutomationKnownEvent<typeof AUTOMATION_SOURCES.otp> => ({
  id: input.eventId ?? `identity-claim-completed:${input.otp.id}`,
  scope: { kind: "org", orgId: input.orgId },
  source: AUTOMATION_SOURCES.otp,
  eventType: AUTOMATION_SOURCE_EVENT_TYPES.otp.identityClaimCompleted,
  occurredAt: toIsoString(input.otp.confirmedAt, "confirmedAt"),
  payload: {
    otpId: input.otp.id,
    claimType: input.otp.type,
  },
  actor: { ...(input.claim.actor as AutomationExternalEntityRef), role: "initiator" },
  actors: [{ ...(input.claim.actor as AutomationExternalEntityRef), role: "initiator" }],
  subject: {
    userId: input.userId,
  },
});

export function createOtpServer(
  runtime: BackofficeFragmentRuntimeOptions,
  config: Pick<OtpFragmentConfig, "hooks"> = {},
) {
  return createOtpFragment(
    {
      defaultExpiryMinutes: DEFAULT_IDENTITY_LINK_EXPIRY_MINUTES,
      hooks: config.hooks,
    },
    {
      databaseAdapter: runtime.adapters.createAdapter({
        kind: "otp",
      }),
      mountRoute: "/api/otp",
    },
  ).withMiddleware(async function reserveEmailVerificationForInternalRpc(
    { ifMatchesRoute },
    { error },
  ) {
    const issueResult = await ifMatchesRoute("POST", "/otp/issue", async ({ input }) => {
      const body = await input.valid();
      if (body.type === EMAIL_VERIFICATION_TYPE) {
        return error(
          {
            message: "Email verification OTPs cannot be issued through the public API.",
            code: "OTP_TYPE_RESERVED",
          },
          403,
        );
      }
    });
    if (issueResult) {
      return issueResult;
    }

    const confirmResult = await ifMatchesRoute("POST", "/otp/confirm", async ({ input }) => {
      const body = await input.valid();
      if (body.type === EMAIL_VERIFICATION_TYPE) {
        return error(
          {
            message: "Email verification OTPs cannot be confirmed through the public API.",
            code: "OTP_TYPE_RESERVED",
          },
          403,
        );
      }
    });
    if (confirmResult) {
      return confirmResult;
    }

    return await ifMatchesRoute("POST", "/otp/invalidate", async ({ input }) => {
      const body = await input.valid();
      if (body.type === EMAIL_VERIFICATION_TYPE) {
        return error(
          {
            message: "Email verification OTPs cannot be invalidated through the public API.",
            code: "OTP_TYPE_RESERVED",
          },
          403,
        );
      }
    });
  });
}

export type OtpFragment = ReturnType<typeof createOtpServer>;
