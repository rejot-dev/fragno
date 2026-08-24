import { afterEach, assert, describe, expect, test, vi } from "vitest";

import { getBackofficeMe } from "@/fragno/auth/auth-server";
import {
  exchangeBackofficeSessionForJwt,
  waitForPreferredBackofficeSessionForJwt,
} from "@/fragno/auth/session-exchange.client";

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

  test("renders without reading the path-restricted Better Auth session cookie", async () => {
    vi.stubEnv("MODE", "development");
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
      me: { user: { id: "user-1" } } as never,
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
      me: { activeOrganizationId: "org-current" } as never,
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    });

    const result = await loader(
      createLoaderArgs(
        "https://example.com/backoffice/auth/bootstrap?organizationId=org-next&returnTo=%2Fbackoffice%2Forganisations%2Forg-next",
      ),
    );
    expect(result).toMatchObject({
      data: {
        organizationId: "org-next",
        returnTo: "/backoffice/organisations/org-next",
      },
    });
  });

  test("exchanges the preferred organization for an HttpOnly browser JWT", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ expiresAt: "2026-08-11T12:15:00.000Z", organizationId: "org-1" }),
      );

    await expect(
      exchangeBackofficeSessionForJwt(
        { selection: "preferred", organizationId: "org-preferred" },
        fetchImplementation,
      ),
    ).resolves.toEqual({ expiresAt: "2026-08-11T12:15:00.000Z", organizationId: "org-1" });
    expect(fetchImplementation).toHaveBeenCalledWith("/api/auth/backoffice-token", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: "preferred", organizationId: "org-preferred" }),
    });
  });

  test("waits for initial organization provisioning", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ status: "organization_provisioning", retryAfterMs: 250 }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        Response.json({ status: "organization_provisioning", retryAfterMs: 250 }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        Response.json({ expiresAt: "2026-08-21T12:15:00.000Z", organizationId: "org-created" }),
      );
    const sleep = vi.fn(async () => {});

    await expect(
      waitForPreferredBackofficeSessionForJwt(null, fetchImplementation, sleep),
    ).resolves.toEqual({
      expiresAt: "2026-08-21T12:15:00.000Z",
      organizationId: "org-created",
    });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  test("reports when initial organization provisioning times out", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ status: "organization_provisioning", retryAfterMs: 250 }, { status: 202 }),
      );
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(15_000);

    await expect(
      waitForPreferredBackofficeSessionForJwt(
        null,
        fetchImplementation,
        async () => {},
        15_000,
        now,
      ),
    ).rejects.toThrow("Your organisation could not be created in time");
  });

  test("accepts the server fallback for a preferred organization left by another account", async () => {
    const writePreference = vi.fn();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ expiresAt: "2026-08-11T12:15:00.000Z", organizationId: "org-fallback" }),
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
