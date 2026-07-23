import { afterEach, assert, describe, expect, it, vi } from "vitest";

import { RouterContextProvider } from "react-router";

import { getAuthDurableObject } from "@/worker-runtime/durable-objects";
import { getSetCookieHeaders } from "@/worker-runtime/http-headers";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import {
  beginEmailVerificationLogin,
  completeEmailVerificationLogin,
} from "./email-verification-login.server";

vi.mock("@/worker-runtime/durable-objects", () => ({
  getAuthDurableObject: vi.fn(),
}));

const createContext = () => {
  const context = new RouterContextProvider();
  context.set(BackofficeWorkerContext, {
    runtime: {} as never,
    env: { AUTH_ACCESS_TOKEN_SECRET: "test-email-verification-login-secret" } as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
  return context;
};

const createLoginGrantCookie = async (context: RouterContextProvider): Promise<string> => {
  const headers = await beginEmailVerificationLogin({ context, userId: "user_123" });
  const setCookie = headers[0]?.[1];
  if (!setCookie) {
    throw new Error("Expected verification login grant cookie.");
  }
  return setCookie.split(";", 1)[0] ?? "";
};

const completeLogin = async (input: {
  context: RouterContextProvider;
  cookie: string;
  issueVerifiedEmailCredential?: ReturnType<typeof vi.fn>;
  fetch?: ReturnType<typeof vi.fn>;
}) => {
  const issueVerifiedEmailCredential =
    input.issueVerifiedEmailCredential ??
    vi.fn().mockResolvedValue({ status: "issued", credentialToken: "credential-token" });
  const fetch = input.fetch ?? vi.fn();
  vi.mocked(getAuthDurableObject).mockReturnValue({ issueVerifiedEmailCredential, fetch } as never);

  return completeEmailVerificationLogin({
    request: new Request("https://backoffice.example/backoffice/verify-email.data", {
      method: "POST",
      headers: { cookie: input.cookie },
    }),
    context: input.context,
  });
};

describe("email verification login completion", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requests credential issuance using only the verified user", async () => {
    const context = createContext();
    const cookie = await createLoginGrantCookie(context);
    const issueVerifiedEmailCredential = vi.fn().mockResolvedValue({ status: "pending" });

    await expect(completeLogin({ context, cookie, issueVerifiedEmailCredential })).resolves.toEqual(
      { status: "pending", headers: [] },
    );
    expect(issueVerifiedEmailCredential).toHaveBeenCalledExactlyOnceWith({ userId: "user_123" });
  });

  it.each([
    [400, "credential_invalid"],
    [401, "credential_invalid"],
    [404, "access_tokens_disabled"],
    [409, "unexpected_client_error"],
  ])("treats permanent Auth refresh rejection %s/%s as terminal", async (status, code) => {
    const context = createContext();
    const cookie = await createLoginGrantCookie(context);
    const result = await completeLogin({
      context,
      cookie,
      fetch: vi.fn().mockResolvedValue(Response.json({ code }, { status })),
    });

    assert(result.status === "unavailable");
    expect(getSetCookieHeaders(new Headers(result.headers))).toEqual([
      expect.stringContaining("Max-Age=0"),
    ]);
  });

  it.each([408, 425, 429, 502, 503, 504])(
    "retries explicitly transient Auth refresh status %s",
    async (status) => {
      const context = createContext();
      const cookie = await createLoginGrantCookie(context);
      await expect(
        completeLogin({
          context,
          cookie,
          fetch: vi.fn().mockResolvedValue(new Response(null, { status })),
        }),
      ).resolves.toEqual({ status: "pending", headers: [] });
    },
  );

  it("propagates unexpected Auth refresh failures", async () => {
    const context = createContext();
    const cookie = await createLoginGrantCookie(context);

    await expect(
      completeLogin({
        context,
        cookie,
        fetch: vi
          .fn()
          .mockResolvedValue(Response.json({ code: "internal_error" }, { status: 500 })),
      }),
    ).rejects.toThrow("Unexpected Auth refresh response: 500 (internal_error)");
  });

  it("propagates credential issuance exceptions", async () => {
    const context = createContext();
    const cookie = await createLoginGrantCookie(context);

    await expect(
      completeLogin({
        context,
        cookie,
        issueVerifiedEmailCredential: vi.fn().mockRejectedValue(new Error("Auth RPC failed")),
      }),
    ).rejects.toThrow("Auth RPC failed");
  });

  it("propagates refresh RPC exceptions", async () => {
    const context = createContext();
    const cookie = await createLoginGrantCookie(context);

    await expect(
      completeLogin({
        context,
        cookie,
        fetch: vi.fn().mockRejectedValue(new Error("Auth fetch failed")),
      }),
    ).rejects.toThrow("Auth fetch failed");
  });
});
