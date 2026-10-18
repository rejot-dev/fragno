import { afterEach, assert, describe, expect, test, vi } from "vitest";

import { getBackofficeMe } from "@/fragno/auth/auth-server";
import { exchangeBackofficeSessionForJwt } from "@/fragno/auth/session-exchange.client";

import { loader } from "./auth-bootstrap";
import { bootstrapBackofficePreferredOrganization } from "./auth-bootstrap.client";

vi.mock("@/fragno/auth/auth-server", () => ({
  getBackofficeMe: vi.fn(),
}));

const createLoaderArgs = (url: string, cookie?: string) =>
  ({
    request: new Request(url, { headers: cookie ? { cookie } : undefined }),
    url: new URL(url),
    context: {} as never,
    params: {},
  }) as unknown as Parameters<typeof loader>[0];

describe("Backoffice auth bootstrap", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  test("renders in production without reading the path-restricted Better Auth session cookie", async () => {
    vi.stubEnv("MODE", "production");
    vi.mocked(getBackofficeMe).mockResolvedValue({ status: "missing" });
    const result = await loader(
      createLoaderArgs(
        "https://example.com/backoffice/auth/bootstrap?returnTo=%2Fbackoffice%2Fsettings",
      ),
    );
    expect(result).toMatchObject({ data: { returnTo: "/backoffice/settings" } });
  });

  test("redirects immediately when the JWT is already valid", async () => {
    vi.stubEnv("MODE", "development");
    vi.mocked(getBackofficeMe).mockResolvedValue({
      status: "authenticated",
      me: {
        user: { id: "user-1" },
        activeOrganizationId: null,
        activeOrganization: null,
      } as never,
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    });

    const response = await loader(
      createLoaderArgs("https://example.com/backoffice/auth/bootstrap"),
    ).catch((error: unknown) => error);
    assert(response instanceof Response);
    assert(response.headers.get("location") === "/backoffice");
  });

  test("renders an exchange when the authenticated JWT targets another organization", async () => {
    vi.stubEnv("MODE", "development");
    vi.mocked(getBackofficeMe).mockResolvedValue({
      status: "authenticated",
      me: {
        activeOrganizationId: "org-current",
        activeOrganization: { organization: { id: "org-current" } },
      } as never,
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    });

    const result = await loader(
      createLoaderArgs(
        "https://example.com/backoffice/auth/bootstrap?organizationId=org-next&returnTo=%2Fbackoffice%2Forganizations%2Forg-next",
      ),
    );
    expect(result).toMatchObject({
      data: {
        organizationId: "org-next",
        returnTo: "/backoffice/organizations/org-next",
      },
    });
  });

  test("renders an exchange when JWT organization membership is stale", async () => {
    vi.stubEnv("MODE", "development");
    vi.mocked(getBackofficeMe).mockResolvedValue({
      status: "authenticated",
      me: {
        activeOrganizationId: "org-removed",
        activeOrganization: null,
      } as never,
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    });

    const result = await loader(
      createLoaderArgs(
        "https://example.com/backoffice/auth/bootstrap?returnTo=%2Fbackoffice%2Fsettings",
      ),
    );
    expect(result).toMatchObject({
      data: { organizationId: null, returnTo: "/backoffice/settings" },
    });
  });

  test("exchanges the preferred organization for an HttpOnly browser JWT", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        expiresAt: "2026-08-11T12:15:00.000Z",
        organization: { id: "org-1", slug: "acme" },
      }),
    );

    await expect(
      exchangeBackofficeSessionForJwt(
        { selection: "preferred", organizationId: "org-preferred" },
        fetchImplementation,
      ),
    ).resolves.toEqual({
      expiresAt: "2026-08-11T12:15:00.000Z",
      organization: { id: "org-1", slug: "acme" },
    });
    expect(fetchImplementation).toHaveBeenCalledWith("/api/auth/backoffice-token", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: "preferred", organizationId: "org-preferred" }),
    });
  });

  test("accepts the server fallback for a preferred organization left by another account", async () => {
    const writePreference = vi.fn();
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        expiresAt: "2026-08-11T12:15:00.000Z",
        organization: { id: "org-fallback", slug: "fallback" },
      }),
    );

    await bootstrapBackofficePreferredOrganization(
      "org-stale",
      writePreference,
      fetchImplementation,
    );

    expect(fetchImplementation).toHaveBeenCalledWith("/api/auth/backoffice-token", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: "preferred", organizationId: "org-stale" }),
    });
    expect(writePreference).toHaveBeenCalledWith("org-fallback");
  });
});
