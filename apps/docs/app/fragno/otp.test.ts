import { describe, expect, it } from "vitest";

import {
  IDENTITY_LINK_TYPE,
  buildIdentityClaimCompletedAutomationEvent,
  buildIdentityClaimCompletionUrl,
  identityClaimConfirmationPayloadSchema,
  identityClaimPayloadSchema,
} from "./otp";

describe("otp identity claim helpers", () => {
  it("parses valid identity claim payloads", () => {
    expect(
      identityClaimPayloadSchema.parse({
        orgId: " org_123 ",
        linkSource: " telegram ",
        externalActorId: " chat_123 ",
      }),
    ).toEqual({
      orgId: "org_123",
      linkSource: "telegram",
      externalActorId: "chat_123",
    });
  });

  it("rejects malformed identity claim payloads", () => {
    expect(identityClaimPayloadSchema.safeParse(null).success).toBe(false);
    expect(
      identityClaimPayloadSchema.safeParse({
        orgId: "org_123",
        linkSource: "telegram",
      }).success,
    ).toBe(false);
    expect(
      identityClaimPayloadSchema.safeParse({
        orgId: "org_123",
        externalActorId: "chat_123",
      }).success,
    ).toBe(false);
  });

  it("parses valid identity claim confirmation payloads", () => {
    expect(
      identityClaimConfirmationPayloadSchema.parse({
        subjectUserId: " user_123 ",
      }),
    ).toEqual({
      subjectUserId: "user_123",
    });
  });

  it("rejects malformed identity claim confirmation payloads", () => {
    expect(identityClaimConfirmationPayloadSchema.safeParse(null).success).toBe(false);
    expect(identityClaimConfirmationPayloadSchema.safeParse({}).success).toBe(false);
    expect(
      identityClaimConfirmationPayloadSchema.safeParse({
        subjectUserId: "",
      }).success,
    ).toBe(false);
  });

  it("builds browser completion urls from issued otp data", () => {
    expect(
      buildIdentityClaimCompletionUrl("https://docs.example/base", "org_123", "chat_123", "654321"),
    ).toBe(
      "https://docs.example/backoffice/automations/org_123/claims/complete?externalId=chat_123&code=654321",
    );
  });

  it("projects confirmed otp payloads into canonical automation events", () => {
    expect(
      buildIdentityClaimCompletedAutomationEvent({
        orgId: "org_123",
        userId: "user_123",
        claim: {
          linkSource: "telegram",
          externalActorId: "chat_123",
        },
        otp: {
          id: "otp_123",
          type: IDENTITY_LINK_TYPE,
          confirmedAt: new Date("2026-03-17T12:05:00.000Z"),
        },
      }),
    ).toEqual({
      id: "identity-claim-completed:otp_123",
      orgId: "org_123",
      source: "otp",
      eventType: "identity.claim.completed",
      occurredAt: "2026-03-17T12:05:00.000Z",
      payload: {
        otpId: "otp_123",
        claimType: IDENTITY_LINK_TYPE,
        linkSource: "telegram",
        externalActorId: "chat_123",
      },
      subject: {
        userId: "user_123",
      },
    });
  });

  it("accepts serialized confirmedAt timestamps from durable hook delivery", () => {
    expect(
      buildIdentityClaimCompletedAutomationEvent({
        orgId: "org_123",
        userId: "user_123",
        claim: {
          linkSource: "telegram",
          externalActorId: "chat_123",
        },
        otp: {
          id: "otp_123",
          type: IDENTITY_LINK_TYPE,
          confirmedAt: "2026-03-17T12:05:00.000Z",
        },
      }),
    ).toMatchObject({
      occurredAt: "2026-03-17T12:05:00.000Z",
    });
  });
});
