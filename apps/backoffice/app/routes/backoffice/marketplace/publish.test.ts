import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { findBackofficeMeMock, createDraftListingMock } = vi.hoisted(() => ({
  findBackofficeMeMock: vi.fn(),
  createDraftListingMock: vi.fn(),
}));

vi.mock("@/fragno/auth/auth-server", () => ({ findBackofficeMe: findBackofficeMeMock }));

import { marketplaceListingId } from "@/fragno/marketplace/owner";

import { marketplaceListingManagePath } from "./navigation";
import { action, loader } from "./publish";

const authenticatedUser = {
  user: { id: "user-1" },
  organizations: [{ organization: { id: "org-1", slug: "acme", name: "Acme" } }],
  activeOrganization: { organization: { id: "org-1", slug: "acme", name: "Acme" } },
};

const listingId = marketplaceListingId({
  ownerScope: { kind: "org", orgId: "org-1" },
  slug: "daily-operations-brief",
});

const marketplace = { createDraftListing: createDraftListingMock };
const context = {
  get: () => ({
    runtime: {
      objects: { marketplace: { singleton: () => ({ commands: marketplace }) } },
    },
  }),
};

const publishRequest = (organizationSlug = "acme") => {
  const formData = new FormData();
  formData.set("ownerOrgSlug", organizationSlug);
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
  findBackofficeMeMock.mockReset();
  createDraftListingMock.mockReset();
  findBackofficeMeMock.mockResolvedValue(authenticatedUser);
  createDraftListingMock.mockResolvedValue({
    ok: true,
    value: {
      listingId,
      slug: "daily-operations-brief",
      version: "1.0.0",
      created: true,
    },
  });
});

describe("marketplace draft loader", () => {
  test("rejects a requested organization outside the authenticated memberships", async () => {
    const url = new URL(
      "https://example.test/backoffice/marketplace/publish?ownerOrgSlug=org-other",
    );

    const response = await loader({
      request: new Request(url),
      context,
      url,
    } as never).catch((error: unknown) => error);

    expect(response).toBeInstanceOf(Response);
    assert((response as Response).status === 404);
    await expect((response as Response).text()).resolves.toBe(
      "Publisher organization was not found.",
    );
  });

  test("uses the active organization when no owner is requested", async () => {
    const url = new URL("https://example.test/backoffice/marketplace/publish");

    const result = await loader({
      request: new Request(url),
      context,
      url,
    } as never);

    assert(!(result instanceof Response));
    assert(result.activeOrganization?.id === "org-1");
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
        marketplaceListingManagePath({
          listingId,
          organizationSlug: "acme",
          result: { created: "1.0.0" },
        }),
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

  test("rejects an organization outside the authenticated memberships", async () => {
    const result = await action({
      request: publishRequest("org-other"),
      context,
      url: new URL("https://example.test/backoffice/marketplace/publish"),
    } as never);

    expect(result).toEqual({
      ok: false,
      message: "Select an organization you are allowed to publish for.",
    });
    expect(createDraftListingMock).not.toHaveBeenCalled();
  });
});
