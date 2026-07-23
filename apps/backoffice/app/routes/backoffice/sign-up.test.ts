import { afterEach, assert, describe, expect, it, vi } from "vitest";

import { createAuthRouteCaller } from "@/fragno/auth/auth-server";
import { requestEmailVerificationResend } from "@/fragno/auth/email-verification.server";

import { action } from "./sign-up";

vi.mock("@/fragno/auth/auth-server", () => ({
  createAuthRouteCaller: vi.fn(),
  getAuthMe: vi.fn(),
}));

vi.mock("@/fragno/auth/email-verification.server", () => ({
  requestEmailVerificationResend: vi.fn(),
}));

const createActionArgs = (body: Record<string, string>) =>
  ({
    request: new Request("https://example.com/backoffice/sign-up", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ intent: "sign_up", ...body }),
    }),
    url: new URL("https://example.com/backoffice/sign-up"),
    context: {} as never,
    params: {},
  }) as unknown as Parameters<typeof action>[0];

const validSignUpForm = {
  email: "new-user@example.com",
  password: "password123",
  confirmPassword: "password123",
};

describe("backoffice sign-up route", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("shows the verification-required state without issuing a session", async () => {
    vi.stubEnv("MODE", "development");
    vi.mocked(createAuthRouteCaller).mockReturnValue(
      vi.fn().mockResolvedValue({
        type: "json",
        status: 200,
        data: {
          status: "email_verification_required",
          userId: "user_123",
          email: "new-user@example.com",
          role: "user",
        },
        headers: new Headers(),
      }) as never,
    );

    expect(await action(createActionArgs(validSignUpForm))).toEqual({
      state: "verification_required",
      email: "new-user@example.com",
      resend: "available",
    });
  });

  it("requests another verification email without exposing account state", async () => {
    vi.stubEnv("MODE", "development");
    vi.mocked(requestEmailVerificationResend).mockResolvedValue({
      status: "accepted",
      email: "new-user@example.com",
    });

    await expect(
      action(
        createActionArgs({
          intent: "resend",
          email: "new-user@example.com",
        }),
      ),
    ).resolves.toEqual({
      state: "verification_required",
      email: "new-user@example.com",
      resend: "accepted",
    });
    expect(requestEmailVerificationResend).toHaveBeenCalledWith({
      request: expect.any(Request),
      context: expect.anything(),
      email: "new-user@example.com",
    });
  });

  it("redirects authenticated exempt users with the issued session", async () => {
    vi.stubEnv("MODE", "development");
    vi.mocked(createAuthRouteCaller).mockReturnValue(
      vi.fn().mockResolvedValue({
        type: "json",
        status: 200,
        data: {
          status: "authenticated",
          auth: {
            token: "session-token",
            kind: "session",
            expiresAt: "2026-08-21T12:00:00.000Z",
            activeOrganizationId: null,
          },
          userId: "admin_123",
          email: "admin@rejot.dev",
          role: "admin",
        },
        headers: new Headers([["set-cookie", "fragno_auth=session-token; Path=/; HttpOnly"]]),
      }) as never,
    );

    const result = await action(
      createActionArgs({
        ...validSignUpForm,
        email: "admin@rejot.dev",
      }),
    );
    assert(result instanceof Response);
    assert.equal(result.status, 302);
    assert.equal(result.headers.get("Location"), "/backoffice");
    assert.equal(result.headers.get("set-cookie"), "fragno_auth=session-token; Path=/; HttpOnly");
  });
});
