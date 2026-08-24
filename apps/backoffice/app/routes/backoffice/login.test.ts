import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";

import { callBetterAuth, getBackofficeMe } from "@/fragno/auth/auth-server";
import { requestEmailVerificationResend } from "@/fragno/auth/email-verification.server";

import { action, loader } from "./login";

vi.mock("@/fragno/auth/auth-server", async (importOriginal) => ({
  ...(await importOriginal()),
  callBetterAuth: vi.fn(),
  getBackofficeMe: vi.fn(),
}));
vi.mock("@/fragno/auth/email-verification.server", () => ({
  requestEmailVerificationResend: vi.fn(),
}));

const createLoaderArgs = (url: string) =>
  ({
    request: new Request(url),
    url: new URL(url),
    context: {} as never,
    params: {},
  }) as unknown as Parameters<typeof loader>[0];
const createActionArgs = (url: string, body: Record<string, string>) =>
  ({
    request: new Request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ intent: "sign_in", ...body }),
    }),
    url: new URL(url),
    context: {} as never,
    params: {},
  }) as unknown as Parameters<typeof action>[0];
const requireResponse = (result: unknown): Response => {
  assert(result instanceof Response);
  return result;
};
describe("backoffice login route", () => {
  beforeEach(() => {
    vi.mocked(getBackofficeMe).mockResolvedValue({ status: "missing" });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("redirects an authenticated JWT user", async () => {
    vi.stubEnv("MODE", "development");
    vi.mocked(getBackofficeMe).mockResolvedValue({
      status: "authenticated",
      me: {} as never,
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    });

    const response = requireResponse(
      await loader(
        createLoaderArgs("https://example.com/backoffice/login?returnTo=%2Fbackoffice%2Fsettings"),
      ),
    );
    assert(response.headers.get("Location") === "/backoffice/settings");
    expect(callBetterAuth).not.toHaveBeenCalled();
  });

  it("renders sign-in for device authorization even when a Backoffice JWT exists", async () => {
    vi.stubEnv("MODE", "development");
    vi.mocked(getBackofficeMe).mockResolvedValue({
      status: "authenticated",
      me: {} as never,
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    });

    await expect(
      loader(
        createLoaderArgs(
          "https://example.com/backoffice/login?returnTo=%2Fbackoffice%2Fdevice%3Fuser_code%3DME7L-5UAH",
        ),
      ),
    ).resolves.toEqual({
      authenticated: false,
      returnTo: "/backoffice/device?user_code=ME7L-5UAH",
      bootstrapError: null,
    });
    expect(getBackofficeMe).not.toHaveBeenCalled();
  });

  it("redirects a successful Better Auth email sign-in", async () => {
    vi.stubEnv("MODE", "development");
    vi.mocked(callBetterAuth).mockResolvedValue(
      Response.json(
        { user: { id: "user_123" } },
        { headers: { "set-cookie": "session=abc; Path=/; HttpOnly" } },
      ),
    );

    const response = requireResponse(
      await action(
        createActionArgs("https://example.com/backoffice/login?returnTo=%2Fbackoffice%2Fsettings", {
          email: "dev@fragno.test",
          password: "password123",
        }),
      ),
    );
    assert(
      response.headers.get("Location") ===
        "/backoffice/auth/bootstrap?returnTo=%2Fbackoffice%2Fsettings",
    );
    expect(response.headers.getSetCookie()).toEqual([
      "session=abc; Path=/; HttpOnly",
      "fragno-backoffice.access_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
      "__Host-fragno-backoffice.access_token=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    ]);
    expect(callBetterAuth).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      "/sign-in/email",
      {
        method: "POST",
        body: JSON.stringify({ email: "dev@fragno.test", password: "password123" }),
      },
    );
  });

  it("preserves Better Auth's verification-required response", async () => {
    vi.stubEnv("MODE", "development");
    vi.mocked(callBetterAuth).mockResolvedValue(
      Response.json(
        { code: "EMAIL_NOT_VERIFIED", message: "Verify your email before signing in." },
        { status: 403 },
      ),
    );

    await expect(
      action(
        createActionArgs("https://example.com/backoffice/login", {
          email: "dev@fragno.test",
          password: "password123",
        }),
      ),
    ).resolves.toEqual({
      state: "verification_required",
      email: "dev@fragno.test",
      resend: "available",
      message: "Verify your email before signing in.",
    });
  });

  it("requests another verification email", async () => {
    vi.stubEnv("MODE", "development");
    vi.mocked(requestEmailVerificationResend).mockResolvedValue({
      status: "accepted",
      email: "dev@fragno.test",
    });

    await expect(
      action(
        createActionArgs("https://example.com/backoffice/login", {
          intent: "resend",
          email: "dev@fragno.test",
        }),
      ),
    ).resolves.toMatchObject({ state: "verification_required", resend: "accepted" });
  });
});
