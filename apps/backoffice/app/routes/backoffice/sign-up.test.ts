import { afterEach, assert, describe, expect, it, vi } from "vitest";

import { RouterContextProvider } from "react-router";

import { callBetterAuth } from "@/fragno/auth/auth-server";
import { requestEmailVerificationResend } from "@/fragno/auth/email-verification.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { action } from "./sign-up";

vi.mock("@/fragno/auth/auth-server", async (importOriginal) => ({
  ...(await importOriginal()),
  callBetterAuth: vi.fn(),
  getBackofficeMe: vi.fn(),
}));
vi.mock("@/fragno/auth/email-verification.server", () => ({
  requestEmailVerificationResend: vi.fn(),
}));

function createRouterContext(signUpAccessCodesRequired: boolean) {
  const context = new RouterContextProvider();
  context.set(BackofficeWorkerContext, {
    runtime: { config: { signUpAccessCodesRequired } },
  } as never);
  return context;
}

const createActionArgs = (
  body: Record<string, string>,
  url = "https://example.com/backoffice/sign-up",
  signUpAccessCodesRequired = true,
) =>
  ({
    request: new Request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ intent: "sign_up", ...body }),
    }),
    url: new URL(url),
    context: createRouterContext(signUpAccessCodesRequired),
    params: {},
  }) as unknown as Parameters<typeof action>[0];
const validSignUpForm = {
  email: "new-user@example.com",
  password: "password123",
  confirmPassword: "password123",
  accessCode: "ABCD2345EFGH6789",
};

describe("backoffice sign-up route", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("rejects registration without an access code", async () => {
    await expect(
      action(
        createActionArgs({
          email: "new-user@example.com",
          password: "password123",
          confirmPassword: "password123",
        }),
      ),
    ).resolves.toEqual({
      state: "error",
      message: "Enter your access code, a valid email, and a password with at least 8 characters.",
    });
    expect(callBetterAuth).not.toHaveBeenCalled();
  });

  it("allows registration without an access code when none is required", async () => {
    vi.mocked(callBetterAuth).mockResolvedValue(
      Response.json({ user: { id: "user_123", email: "new-user@example.com" } }),
    );

    await expect(
      action(
        createActionArgs(
          {
            email: "new-user@example.com",
            password: "password123",
            confirmPassword: "password123",
          },
          "https://example.com/backoffice/sign-up",
          false,
        ),
      ),
    ).resolves.toEqual({
      state: "verification_required",
      email: "new-user@example.com",
      resend: "available",
    });
    expect(callBetterAuth).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      "/sign-up/email",
      {
        method: "POST",
        body: JSON.stringify({
          name: "new-user",
          email: "new-user@example.com",
          password: "password123",
          callbackURL: "/backoffice/login",
        }),
      },
    );
  });

  it("allows registration with an access code in production", async () => {
    vi.stubEnv("MODE", "production");
    vi.mocked(callBetterAuth).mockResolvedValue(
      Response.json({ user: { id: "user_123", email: "new-user@example.com" } }),
    );

    await expect(action(createActionArgs(validSignUpForm))).resolves.toEqual({
      state: "verification_required",
      email: "new-user@example.com",
      resend: "available",
    });
  });

  it("shows verification-required when Better Auth does not issue a session", async () => {
    vi.stubEnv("MODE", "development");
    vi.mocked(callBetterAuth).mockResolvedValue(
      Response.json({ user: { id: "user_123", email: "new-user@example.com" } }),
    );

    await expect(action(createActionArgs(validSignUpForm))).resolves.toEqual({
      state: "verification_required",
      email: "new-user@example.com",
      resend: "available",
    });
    expect(callBetterAuth).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      "/sign-up/email",
      {
        method: "POST",
        body: JSON.stringify({
          name: "new-user",
          email: "new-user@example.com",
          password: "password123",
          accessCode: "ABCD2345EFGH6789",
          callbackURL: "/backoffice/login",
        }),
      },
    );
  });

  it("requests another verification email without exposing account state", async () => {
    vi.stubEnv("MODE", "development");
    vi.mocked(requestEmailVerificationResend).mockResolvedValue({
      status: "accepted",
      email: "new-user@example.com",
    });

    await expect(
      action(createActionArgs({ intent: "resend", email: "new-user@example.com" })),
    ).resolves.toEqual({
      state: "verification_required",
      email: "new-user@example.com",
      resend: "accepted",
    });
  });

  it("preserves an invitation return path when account creation issues a session", async () => {
    vi.stubEnv("MODE", "development");
    vi.mocked(callBetterAuth).mockResolvedValue(
      Response.json(
        { user: { id: "user_123" } },
        { headers: { "set-cookie": "session=abc; Path=/; HttpOnly" } },
      ),
    );
    const returnTo =
      "/backoffice/invitations/AYFpGE1yoCO3H2epFjXSVOdk2tjn4UNt?token=AYFpGE1yoCO3H2epFjXSVOdk2tjn4UNt";
    const signUpUrl = new URL("https://example.com/backoffice/sign-up");
    signUpUrl.searchParams.set("returnTo", returnTo);

    const result = await action(createActionArgs(validSignUpForm, signUpUrl.toString()));

    assert(result instanceof Response);
    assert(result.headers.get("Location") === returnTo);
    expect(callBetterAuth).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      "/sign-up/email",
      expect.objectContaining({
        body: expect.stringContaining(
          `"callbackURL":"/backoffice/login?returnTo=${encodeURIComponent(returnTo)}"`,
        ),
      }),
    );
  });

  it("redirects when Better Auth issues a session", async () => {
    vi.stubEnv("MODE", "development");
    vi.mocked(callBetterAuth).mockResolvedValue(
      Response.json(
        { user: { id: "admin_123" } },
        { headers: { "set-cookie": "better-auth.session_token=session; Path=/; HttpOnly" } },
      ),
    );

    const result = await action(createActionArgs({ ...validSignUpForm, email: "admin@rejot.dev" }));
    assert(result instanceof Response);
    assert(result.headers.get("Location") === "/backoffice");
    expect(result.headers.getSetCookie()).toEqual([
      "better-auth.session_token=session; Path=/; HttpOnly",
      "fragno-backoffice.access_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
      "__Host-fragno-backoffice.access_token=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    ]);
  });
});
