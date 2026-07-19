import { describe, expect, it, assert } from "vitest";

import {
  IDENTITY_LINK_TYPE,
  buildEmailVerificationUrl,
  buildIdentityClaimCompletedAutomationEvent,
  buildIdentityClaimCompletionUrl,
  emailVerificationPayloadSchema,
  identityClaimConfirmationPayloadSchema,
  identityClaimPayloadSchema,
} from "./otp";

const telegramChatActor = {
  scope: "external" as const,
  source: "telegram",
  type: "chat",
  id: "chat_123",
};

describe("otp identity claim helpers", () => {
  it("parses valid identity claim payloads", () => {
    expect(
      identityClaimPayloadSchema.parse({
        orgId: " org_123 ",
        actor: telegramChatActor,
      }),
    ).toEqual({
      orgId: "org_123",
      actor: telegramChatActor,
    });
  });

  it("rejects malformed identity claim payloads", () => {
    assert(!identityClaimPayloadSchema.safeParse(null).success);
    assert(
      !identityClaimPayloadSchema.safeParse({
        orgId: "org_123",
      }).success,
    );
    assert(
      !identityClaimPayloadSchema.safeParse({
        orgId: "org_123",
        actor: { scope: "external", source: "telegram", type: "chat" },
      }).success,
    );
    assert(
      !identityClaimPayloadSchema.safeParse({
        orgId: "org_123",
        actor: { scope: "external", type: "chat", id: "chat_123" },
      }).success,
    );
    assert(
      !identityClaimPayloadSchema.safeParse({
        orgId: "org_123",
        actor: { scope: "internal", type: "user", id: "user_123" },
      }).success,
    );
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
    assert(!identityClaimConfirmationPayloadSchema.safeParse(null).success);
    assert(!identityClaimConfirmationPayloadSchema.safeParse({}).success);
    assert(
      !identityClaimConfirmationPayloadSchema.safeParse({
        subjectUserId: "",
      }).success,
    );
  });

  it("parses complete email verification delivery payloads", () => {
    const payload = {
      email: "user@example.com",
      publicBaseUrl: "https://backoffice.example",
      expiresInHours: 24,
    };

    expect(emailVerificationPayloadSchema.parse(payload)).toEqual(payload);
    assert(
      !emailVerificationPayloadSchema.safeParse({ ...payload, email: "not-an-email" }).success,
    );
    assert(!emailVerificationPayloadSchema.safeParse({ email: "user@example.com" }).success);
  });

  it("builds email verification urls from issued otp data", () => {
    assert(
      buildEmailVerificationUrl("https://docs.example/base", "user_123", "ABC12345") ===
        "https://docs.example/backoffice/verify-email?userId=user_123&code=ABC12345",
    );
  });

  it("builds browser completion urls from issued otp data", () => {
    assert(
      buildIdentityClaimCompletionUrl(
        "https://docs.example/base",
        "org_123",
        "chat_123",
        "654321",
      ) ===
        "https://docs.example/backoffice/automations/org_123/claims/complete?externalId=chat_123&code=654321",
    );
  });

  it("projects confirmed otp payloads into canonical automation events", () => {
    expect(
      buildIdentityClaimCompletedAutomationEvent({
        orgId: "org_123",
        userId: "user_123",
        claim: {
          actor: telegramChatActor,
        },
        otp: {
          id: "otp_123",
          type: IDENTITY_LINK_TYPE,
          confirmedAt: new Date("2026-03-17T12:05:00.000Z"),
        },
      }),
    ).toEqual({
      id: "identity-claim-completed:otp_123",
      scope: { kind: "org", orgId: "org_123" },
      source: "otp",
      eventType: "identity.claim.completed",
      occurredAt: "2026-03-17T12:05:00.000Z",
      payload: {
        otpId: "otp_123",
        claimType: IDENTITY_LINK_TYPE,
      },
      actor: { ...telegramChatActor, role: "initiator" },
      actors: [{ ...telegramChatActor, role: "initiator" }],
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
          actor: telegramChatActor,
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
