import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthRouteCaller, getAuthMe } from "@/fragno/auth-server";
import { BACKOFFICE_HOME_PATH } from "./auth-navigation";
import { action, loader } from "./login";

vi.mock("@/components/backoffice", () => ({
  FormContainer: ({ children }: { children: unknown }) => children,
  FormField: ({ children }: { children: unknown }) => children,
}));

vi.mock("@/fragno/auth-client", () => ({
  authClient: {
    defaultOrganization: {
      read: vi.fn(() => null),
    },
    oauth: {
      getAuthorizationUrl: vi.fn(),
    },
  },
}));

vi.mock("@/fragno/auth-server", () => ({
  createAuthRouteCaller: vi.fn(),
  getAuthMe: vi.fn(),
}));

describe("backoffice login route", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  const createLoaderArgs = (url: string) =>
    ({
      request: new Request(url),
      context: {} as never,
      params: {},
    }) as unknown as Parameters<typeof loader>[0];

  const createActionArgs = (url: string, body?: Record<string, string>) =>
    ({
      request: new Request(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: new URLSearchParams(body),
      }),
      context: {} as never,
      params: {},
    }) as unknown as Parameters<typeof action>[0];

  const toResponse = (
    result: Awaited<ReturnType<typeof action>> | Awaited<ReturnType<typeof loader>>,
  ): Response => {
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      throw new TypeError("Expected action to return a Response.");
    }
    return result;
  };

  it("redirects authenticated users straight to the requested backoffice destination", async () => {
    vi.stubEnv("MODE", "development");

    vi.mocked(getAuthMe).mockResolvedValue({
      user: { id: "user_123", email: "dev@fragno.test", role: "admin" },
      organizations: [
        {
          organization: { id: "org_123", name: "Fragno" },
          member: { organizationId: "org_123" },
        },
      ],
      activeOrganization: {
        organization: { id: "org_123", name: "Fragno" },
        member: { organizationId: "org_123" },
      },
      invitations: [],
    } as never);

    const result = toResponse(
      await loader(
        createLoaderArgs("https://example.com/backoffice/login?returnTo=%2Fbackoffice%2Fsettings"),
      ),
    );

    expect(result.status).toBe(302);
    expect(result.headers.get("Location")).toBe("/backoffice/settings");
    expect(createAuthRouteCaller).not.toHaveBeenCalled();
  });

  it("initializes the active organization on the server before redirecting authenticated users", async () => {
    vi.stubEnv("MODE", "development");

    vi.mocked(getAuthMe).mockResolvedValue({
      user: { id: "user_123", email: "dev@fragno.test", role: "admin" },
      organizations: [
        {
          organization: { id: "org_123", name: "Fragno" },
          member: { organizationId: "org_123" },
        },
      ],
      activeOrganization: null,
      invitations: [],
    } as never);

    const callAuthRoute = vi.fn().mockResolvedValue({
      type: "empty",
      headers: new Headers([["set-cookie", "session=bootstrapped; Path=/; HttpOnly"]]),
    });
    vi.mocked(createAuthRouteCaller).mockReturnValue(callAuthRoute as never);

    const result = toResponse(
      await loader(createLoaderArgs("https://example.com/backoffice/login")),
    );

    expect(result.status).toBe(302);
    expect(result.headers.get("Location")).toBe(BACKOFFICE_HOME_PATH);
    expect(result.headers.get("set-cookie")).toBe("session=bootstrapped; Path=/; HttpOnly");
    expect(callAuthRoute).toHaveBeenCalledWith("POST", "/organizations/active", {
      body: { organizationId: "org_123" },
    });
  });

  it("returns a bootstrap error when server-side organization initialization fails", async () => {
    vi.stubEnv("MODE", "development");

    vi.mocked(getAuthMe).mockResolvedValue({
      user: { id: "user_123", email: "dev@fragno.test", role: "admin" },
      organizations: [
        {
          organization: { id: "org_123", name: "Fragno" },
          member: { organizationId: "org_123" },
        },
      ],
      activeOrganization: null,
      invitations: [],
    } as never);

    const callAuthRoute = vi.fn().mockResolvedValue({
      type: "error",
      error: { message: "Cannot activate organization." },
    });
    vi.mocked(createAuthRouteCaller).mockReturnValue(callAuthRoute as never);

    const result = await loader(createLoaderArgs("https://example.com/backoffice/login"));

    expect(result).toEqual({
      authenticated: true,
      returnTo: BACKOFFICE_HOME_PATH,
      defaultOrganizationId: "",
      bootstrapError: "Cannot activate organization.",
    });
  });

  it("redirects successful sign-ins to the requested backoffice destination", async () => {
    vi.stubEnv("MODE", "development");

    const callAuthRoute = vi.fn().mockResolvedValue({
      type: "json",
      data: { ok: true },
      headers: new Headers([["set-cookie", "session=abc; Path=/; HttpOnly"]]),
    });
    vi.mocked(createAuthRouteCaller).mockReturnValue(callAuthRoute as never);

    const result = toResponse(
      await action(
        createActionArgs("https://example.com/backoffice/login?returnTo=%2Fbackoffice%2Fsettings", {
          email: "dev@fragno.test",
          password: "password123",
          activeOrganizationId: "org_123",
        }),
      ),
    );

    expect(result.status).toBe(302);
    expect(result.headers.get("Location")).toBe("/backoffice/settings");
    expect(result.headers.get("set-cookie")).toBe("session=abc; Path=/; HttpOnly");
    expect(callAuthRoute).toHaveBeenCalledWith("POST", "/sign-in", {
      body: {
        email: "dev@fragno.test",
        password: "password123",
        session: { activeOrganizationId: "org_123" },
      },
    });
  });

  it("falls back to the backoffice home when no returnTo is present", async () => {
    vi.stubEnv("MODE", "development");

    vi.mocked(createAuthRouteCaller).mockReturnValue(
      vi.fn().mockResolvedValue({
        type: "empty",
        headers: new Headers([["set-cookie", "session=xyz; Path=/; HttpOnly"]]),
      }) as never,
    );

    const result = toResponse(
      await action(
        createActionArgs("https://example.com/backoffice/login", {
          email: "dev@fragno.test",
          password: "password123",
          activeOrganizationId: "",
        }),
      ),
    );

    expect(result.status).toBe(302);
    expect(result.headers.get("Location")).toBe(BACKOFFICE_HOME_PATH);
    expect(result.headers.get("set-cookie")).toBe("session=xyz; Path=/; HttpOnly");
  });
});
