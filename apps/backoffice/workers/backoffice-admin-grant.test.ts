import { describe, expect, it, vi, assert } from "vitest";

import { handleBackofficeAdminGrantRequest } from "./backoffice-admin-grant";

const createRequest = (token = "grant-secret", body: unknown = { email: "Admin@Rejot.dev" }) =>
  new Request("https://backoffice.example.com/api/admin/grant", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

describe("Backoffice administrator grant endpoint", () => {
  it("is unavailable when the grant token is not configured", async () => {
    const grantBackofficeAdminByEmail = vi.fn();

    const response = await handleBackofficeAdminGrantRequest(createRequest(), {
      configuredToken: undefined,
      auth: { grantBackofficeAdminByEmail },
    });

    assert(response.status === 404);
    expect(grantBackofficeAdminByEmail).not.toHaveBeenCalled();
  });

  it("rejects an invalid grant token", async () => {
    const grantBackofficeAdminByEmail = vi.fn();

    const response = await handleBackofficeAdminGrantRequest(createRequest("wrong-secret"), {
      configuredToken: "grant-secret",
      auth: { grantBackofficeAdminByEmail },
    });

    assert(response.status === 401);
    expect(grantBackofficeAdminByEmail).not.toHaveBeenCalled();
  });

  it("rejects administrator access outside rejot.dev", async () => {
    const grantBackofficeAdminByEmail = vi.fn();

    const response = await handleBackofficeAdminGrantRequest(
      createRequest("grant-secret", { email: "admin@example.com" }),
      {
        configuredToken: "grant-secret",
        auth: { grantBackofficeAdminByEmail },
      },
    );

    assert(response.status === 400);
    await expect(response.json()).resolves.toEqual({
      error: "Administrator access requires a @rejot.dev email address.",
    });
    expect(grantBackofficeAdminByEmail).not.toHaveBeenCalled();
  });

  it("grants administrator access to the normalized email", async () => {
    const grantBackofficeAdminByEmail = vi
      .fn()
      .mockResolvedValue({ status: "granted", userId: "user-1" });

    const response = await handleBackofficeAdminGrantRequest(createRequest(), {
      configuredToken: "grant-secret",
      auth: { grantBackofficeAdminByEmail },
    });

    assert(response.status === 200);
    await expect(response.json()).resolves.toEqual({ status: "granted", userId: "user-1" });
    expect(grantBackofficeAdminByEmail).toHaveBeenCalledWith({ email: "admin@rejot.dev" });
  });

  it("rejects invalid input before calling Auth", async () => {
    const grantBackofficeAdminByEmail = vi.fn();

    const response = await handleBackofficeAdminGrantRequest(createRequest("grant-secret", {}), {
      configuredToken: "grant-secret",
      auth: { grantBackofficeAdminByEmail },
    });

    assert(response.status === 400);
    expect(grantBackofficeAdminByEmail).not.toHaveBeenCalled();
  });
});
