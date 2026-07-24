import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { getAuthMeMock, createDraftListingMock } = vi.hoisted(() => ({
  getAuthMeMock: vi.fn(),
  createDraftListingMock: vi.fn(),
}));

vi.mock("@/fragno/auth/auth-server", () => ({ getAuthMe: getAuthMeMock }));

import { action } from "./publish";

const authenticatedUser = {
  user: { id: "user-1" },
  organizations: [{ organization: { id: "org-1", name: "Acme" } }],
  activeOrganization: { organization: { id: "org-1", name: "Acme" } },
};

const marketplace = { createDraftListing: createDraftListingMock };
const context = {
  get: () => ({
    runtime: {
      objects: { marketplace: { singleton: () => marketplace } },
    },
  }),
};

const publishRequest = (organizationId = "org-1") => {
  const formData = new FormData();
  formData.set("ownerOrgId", organizationId);
  formData.set("slug", "daily-operations-brief");
  formData.set("version", "1.0.0");
  formData.set("name", "Daily operations brief");
  formData.set("summary", "Build and deliver a concise daily operations report.");
  formData.set(
    "description",
    "Collects operational events and produces a daily report for the configured channel.",
  );
  formData.set("category", "operations");
  formData.set("tags", "reporting, scheduled");
  return new Request("https://example.test/backoffice/marketplace/publish", {
    method: "POST",
    body: formData,
  });
};

beforeEach(() => {
  getAuthMeMock.mockReset();
  createDraftListingMock.mockReset();
  getAuthMeMock.mockResolvedValue(authenticatedUser);
  createDraftListingMock.mockResolvedValue({
    ok: true,
    value: {
      slug: "daily-operations-brief",
      version: "1.0.0",
      created: true,
    },
  });
});

describe("marketplace draft creation action", () => {
  test("creates a metadata-only draft using authenticated publisher identity", async () => {
    const response = await action({
      request: publishRequest(),
      context,
      url: new URL("https://example.test/backoffice/marketplace/publish"),
    } as never);

    assert(response instanceof Response);
    assert(response.status === 302);
    assert(
      response.headers.get("location") ===
        "/backoffice/marketplace/daily-operations-brief/manage?organizationId=org-1&created=1.0.0",
    );
    expect(createDraftListingMock).toHaveBeenCalledWith({
      owner: {
        scope: { kind: "org", orgId: "org-1" },
        publisherName: "Acme",
      },
      slug: "daily-operations-brief",
      version: "1.0.0",
      metadata: {
        name: "Daily operations brief",
        summary: "Build and deliver a concise daily operations report.",
        description:
          "Collects operational events and produces a daily report for the configured channel.",
        category: "operations",
        tags: ["reporting", "scheduled"],
      },
    });
  });

  test("returns stable marketplace operation failures", async () => {
    createDraftListingMock.mockResolvedValue({
      ok: false,
      error: {
        code: "MARKETPLACE_LISTING_CONFLICT",
        message: "Marketplace listing daily-operations-brief already exists.",
      },
    });

    const result = await action({
      request: publishRequest(),
      context,
      url: new URL("https://example.test/backoffice/marketplace/publish"),
    } as never);

    expect(result).toEqual({
      ok: false,
      message: "Marketplace listing daily-operations-brief already exists.",
    });
  });

  test("rejects an organisation outside the authenticated memberships", async () => {
    const result = await action({
      request: publishRequest("org-other"),
      context,
      url: new URL("https://example.test/backoffice/marketplace/publish"),
    } as never);

    expect(result).toEqual({
      ok: false,
      message: "Select an organisation you are allowed to publish for.",
    });
    expect(createDraftListingMock).not.toHaveBeenCalled();
  });
});
