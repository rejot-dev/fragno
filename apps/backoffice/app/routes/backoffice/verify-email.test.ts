import { afterEach, assert, describe, expect, test, vi } from "vitest";

import {
  beginEmailVerificationLogin,
  completeEmailVerificationLogin,
} from "@/fragno/auth/email-verification-login.server";
import { requestEmailVerificationResend } from "@/fragno/auth/email-verification.server";
import { getSystemOtpDurableObject } from "@/worker-runtime/durable-objects";

import { action, loader } from "./verify-email";

vi.mock("@/fragno/auth/email-verification-login.server", () => ({
  beginEmailVerificationLogin: vi.fn(),
  completeEmailVerificationLogin: vi.fn(),
}));

vi.mock("@/fragno/auth/email-verification.server", () => ({
  requestEmailVerificationResend: vi.fn(),
}));

vi.mock("@/worker-runtime/durable-objects", () => ({
  getSystemOtpDurableObject: vi.fn(),
}));

const createLoaderArgs = (url: string) =>
  ({
    request: new Request(url),
    url: new URL(url),
    context: {} as never,
    params: {},
  }) as unknown as Parameters<typeof loader>[0];

const createActionArgs = (body: Record<string, string>, cookie?: string) =>
  ({
    request: new Request("https://example.com/backoffice/verify-email", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        ...(cookie ? { cookie } : {}),
      },
      body: new URLSearchParams(body),
    }),
    context: {} as never,
    params: {},
  }) as unknown as Parameters<typeof action>[0];

describe("backoffice email verification route", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("loads confirmation input without mutating during the GET request", () => {
    expect(
      loader(
        createLoaderArgs(
          "https://example.com/backoffice/verify-email?userId=user_123&code=ABC12345",
        ),
      ),
    ).toEqual({
      state: "ready",
      userId: "user_123",
      code: "ABC12345",
    });
    expect(getSystemOtpDurableObject).not.toHaveBeenCalled();
  });

  test.each([
    "https://example.com/backoffice/verify-email",
    "https://example.com/backoffice/verify-email?result=confirmation_recorded",
  ])("shows an incomplete result for an untrusted result URL: %s", (url) => {
    expect(loader(createLoaderArgs(url))).toEqual({
      state: "result",
      result: "incomplete",
    });
  });

  test("records confirmation through the singleton OTP object", async () => {
    const confirmEmailVerificationChallenge = vi.fn().mockResolvedValue({
      status: "confirmation_recorded",
      requestId: "verification_request_123",
      userId: "user_123",
    });
    vi.mocked(beginEmailVerificationLogin).mockResolvedValue([
      ["Set-Cookie", "verification_login=grant; Path=/; HttpOnly"],
    ]);
    vi.mocked(getSystemOtpDurableObject).mockReturnValue({
      confirmEmailVerificationChallenge,
    } as never);

    const result = await action(
      createActionArgs({ intent: "confirm", userId: "user_123", code: "ABC12345" }),
    );
    assert(result instanceof Response);
    const response = result;
    await expect(response.json()).resolves.toEqual({
      state: "result",
      result: "confirmation_recorded",
    });
    assert(response.headers.get("set-cookie") === "verification_login=grant; Path=/; HttpOnly");
    expect(confirmEmailVerificationChallenge).toHaveBeenCalledWith({
      userId: "user_123",
      code: "ABC12345",
    });
    expect(beginEmailVerificationLogin).toHaveBeenCalledWith({
      context: expect.anything(),
      userId: "user_123",
    });
  });

  test("does not create another automatic login grant for an already confirmed link", async () => {
    vi.mocked(getSystemOtpDurableObject).mockReturnValue({
      confirmEmailVerificationChallenge: vi.fn().mockResolvedValue({
        status: "already_confirmed",
      }),
    } as never);

    await expect(
      action(createActionArgs({ intent: "confirm", userId: "user_123", code: "ABC12345" })),
    ).resolves.toEqual({ state: "result", result: "already_confirmed" });
    expect(beginEmailVerificationLogin).not.toHaveBeenCalled();
  });

  test.each([
    ["expired", "expired"],
    ["invalid", "invalid"],
    ["invalid_input", "invalid"],
  ] as const)("maps %s to the %s result page", async (reason, result) => {
    vi.mocked(getSystemOtpDurableObject).mockReturnValue({
      confirmEmailVerificationChallenge: vi.fn().mockResolvedValue({ status: "rejected", reason }),
    } as never);

    await expect(
      action(createActionArgs({ intent: "confirm", userId: "user_123", code: "ABC12345" })),
    ).resolves.toEqual({ state: "result", result });
  });

  test("returns pending while Auth finishes verification", async () => {
    vi.mocked(completeEmailVerificationLogin).mockResolvedValue({
      status: "pending",
      headers: [],
    });

    const args = createActionArgs({ intent: "complete_login" }, "verification_login=grant");
    const result = await action(args);
    assert(result instanceof Response);
    const response = result;
    assert(response.status === 202);
    await expect(response.json()).resolves.toEqual({ state: "login", status: "pending" });
    expect(completeEmailVerificationLogin).toHaveBeenCalledWith({
      request: args.request,
      context: args.context,
    });
  });

  test("returns authentication cookies when automatic login completes", async () => {
    vi.mocked(completeEmailVerificationLogin).mockResolvedValue({
      status: "authenticated",
      headers: [
        ["Set-Cookie", "fragno_auth=access; Path=/; HttpOnly"],
        ["Set-Cookie", "fragno_auth_refresh=refresh; Path=/; HttpOnly"],
      ],
    });

    const result = await action(createActionArgs({ intent: "complete_login" }));
    assert(result instanceof Response);
    const response = result;
    await expect(response.json()).resolves.toEqual({
      state: "login",
      status: "authenticated",
    });
    expect(
      (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.(),
    ).toEqual([
      "fragno_auth=access; Path=/; HttpOnly",
      "fragno_auth_refresh=refresh; Path=/; HttpOnly",
    ]);
  });

  test("requests a replacement email through Auth", async () => {
    vi.mocked(requestEmailVerificationResend).mockResolvedValue({
      status: "accepted",
      email: "user@example.com",
    });

    const args = createActionArgs({ intent: "resend", email: "USER@example.com" });
    await expect(action(args)).resolves.toEqual({ state: "result", result: "resent" });
    expect(requestEmailVerificationResend).toHaveBeenCalledWith({
      request: args.request,
      context: args.context,
      email: "user@example.com",
    });
    expect(getSystemOtpDurableObject).not.toHaveBeenCalled();
  });

  test("rejects malformed form submissions before acquiring the OTP object", async () => {
    await expect(
      action(createActionArgs({ intent: "confirm", userId: "", code: "" })),
    ).resolves.toEqual({
      state: "result",
      result: "incomplete",
    });
    expect(getSystemOtpDurableObject).not.toHaveBeenCalled();
  });
});
