import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import { z } from "zod";

import {
  createOtpFragment,
  type OtpFragmentConfig,
  type ResolvedOtpConfirmedHookPayload,
} from "@fragno-dev/otp-fragment";

import type { AutomationKnownEvent } from "./automation/contracts";
import { AUTOMATION_SOURCES, AUTOMATION_SOURCE_EVENT_TYPES } from "./automation/contracts";

export const IDENTITY_LINK_TYPE = "identity_link" as const;
export const DEFAULT_IDENTITY_LINK_EXPIRY_MINUTES = 15;

export const identityClaimPayloadSchema = z.object({
  orgId: z.string().trim().min(1),
  linkSource: z.string().trim().min(1),
  externalActorId: z.string().trim().min(1),
});

export type IdentityClaimOtpPayload = z.infer<typeof identityClaimPayloadSchema>;
export type IdentityClaimPayload = Pick<IdentityClaimOtpPayload, "linkSource" | "externalActorId">;

export const identityClaimConfirmationPayloadSchema = z.object({
  subjectUserId: z.string().trim().min(1),
});

export type IdentityClaimConfirmationPayload = z.infer<
  typeof identityClaimConfirmationPayloadSchema
>;

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
}): AutomationKnownEvent<typeof AUTOMATION_SOURCES.otp> => ({
  id: `identity-claim-completed:${input.otp.id}`,
  orgId: input.orgId,
  source: AUTOMATION_SOURCES.otp,
  eventType: AUTOMATION_SOURCE_EVENT_TYPES.otp.identityClaimCompleted,
  occurredAt: toIsoString(input.otp.confirmedAt, "confirmedAt"),
  payload: {
    otpId: input.otp.id,
    claimType: input.otp.type,
    linkSource: input.claim.linkSource,
    externalActorId: input.claim.externalActorId,
  },
  subject: {
    userId: input.userId,
  },
});

export function createAdapter(state?: DurableObjectState) {
  const dialect = new DurableObjectDialect({
    ctx: state!,
  });

  return new SqlAdapter({
    dialect,
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });
}

export function createOtpServer(
  state: DurableObjectState,
  config: Pick<OtpFragmentConfig, "hooks"> = {},
) {
  return createOtpFragment(
    {
      defaultExpiryMinutes: DEFAULT_IDENTITY_LINK_EXPIRY_MINUTES,
      hooks: config.hooks,
    },
    {
      databaseAdapter: createAdapter(state),
      mountRoute: "/api/otp",
    },
  );
}

export type OtpFragment = ReturnType<typeof createOtpServer>;
