import { afterEach, describe, expect, test, vi } from "vitest";

import { getSystemOtpDurableObject } from "@/worker-runtime/durable-objects";

import { action, loader } from "./verify-email";

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

const createActionArgs = (body: Record<string, string>) =>
  ({
    request: new Request("https://example.com/backoffice/verify-email", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams(body),
    }),
    context: {} as never,
    params: {},
  }) as unknown as Parameters<typeof action>[0];

describe("backoffice email verification route", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("loads a scanner-safe confirmation form from a complete link", () => {
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
    "https://example.com/backoffice/verify-email?result=verified",
  ])("shows an incomplete result for an untrusted result URL: %s", (url) => {
    expect(loader(createLoaderArgs(url))).toEqual({
      state: "result",
      result: "incomplete",
    });
  });

  test("confirms through the singleton OTP object and returns the result directly", async () => {
    const confirmEmailVerification = vi.fn().mockResolvedValue({ ok: true, userId: "user_123" });
    vi.mocked(getSystemOtpDurableObject).mockReturnValue({ confirmEmailVerification } as never);

    await expect(
      action(createActionArgs({ userId: "user_123", code: "ABC12345" })),
    ).resolves.toEqual({ state: "result", result: "verified" });
    expect(confirmEmailVerification).toHaveBeenCalledWith({
      userId: "user_123",
      code: "ABC12345",
    });
  });

  test.each([
    ["OTP_EXPIRED", "expired"],
    ["OTP_INVALID", "invalid"],
    ["INVALID_INPUT", "invalid"],
  ] as const)("maps %s to the %s result page", async (error, result) => {
    vi.mocked(getSystemOtpDurableObject).mockReturnValue({
      confirmEmailVerification: vi.fn().mockResolvedValue({ ok: false, error }),
    } as never);

    await expect(
      action(createActionArgs({ userId: "user_123", code: "ABC12345" })),
    ).resolves.toEqual({ state: "result", result });
  });

  test("rejects malformed form submissions before acquiring the OTP object", async () => {
    await expect(action(createActionArgs({ userId: "", code: "" }))).resolves.toEqual({
      state: "result",
      result: "incomplete",
    });
    expect(getSystemOtpDurableObject).not.toHaveBeenCalled();
  });
});
