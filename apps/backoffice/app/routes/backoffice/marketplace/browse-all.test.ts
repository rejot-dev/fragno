import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { findBackofficeMeMock, listPublishedListingsMock, marketplaceForMock } = vi.hoisted(() => ({
  findBackofficeMeMock: vi.fn(),
  listPublishedListingsMock: vi.fn(),
  marketplaceForMock: vi.fn(),
}));

vi.mock("@/fragno/auth/auth-server", () => ({ findBackofficeMe: findBackofficeMeMock }));

import { loader } from "./browse-all";

const authenticatedUser = {
  user: { id: "user-1", email: "ada@example.com" },
  organizations: [{ organization: { id: "org-1", slug: "ada-labs", name: "Ada Labs" } }],
  activeOrganization: {
    organization: { id: "org-1", slug: "ada-labs", name: "Ada Labs" },
  },
};
const marketplace = { listPublishedListings: listPublishedListingsMock };
const context = {
  get: () => ({
    runtime: {
      objects: { marketplace: { for: marketplaceForMock } },
    },
  }),
};
const listings = [
  {
    listingId: "system#telegram-channel",
    slug: "telegram-channel",
    name: "Telegram channel",
    summary: "Publish operational updates to a Telegram channel from a durable workflow.",
    description: "A published Marketplace package for Telegram channel updates.",
    tags: ["telegram", "notifications"],
    category: "communication",
    publisherName: "Fragno",
    status: "published",
    latestVersion: "1.0.0",
    publishedAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  },
];

beforeEach(() => {
  findBackofficeMeMock.mockReset();
  listPublishedListingsMock.mockReset();
  marketplaceForMock.mockReset();
  marketplaceForMock.mockReturnValue({ commands: marketplace });
  findBackofficeMeMock.mockResolvedValue(authenticatedUser);
  listPublishedListingsMock.mockResolvedValue({
    listings,
    hasNextPage: false,
  });
});

describe("Marketplace catalog listing", () => {
  test("ignores legacy category filters and always requests the unfiltered Marketplace", async () => {
    const url = new URL(
      "https://example.test/backoffice/marketplace/org/ada-labs/marketplace/all?category=communication",
    );

    const result = await loader({
      request: new Request(url),
      params: { scopeKind: "org", scopeId: "ada-labs", catalog: "marketplace" },
      context,
      url,
    } as never);

    assert(!(result instanceof Response));
    expect(listPublishedListingsMock).toHaveBeenCalledWith({});
    assert(!("category" in result));
  });

  test("the organization catalog reads the route organization's Marketplace", async () => {
    const runCatalog = (scopeKind: string, scopeId: string) => {
      const url = new URL(
        `https://example.test/backoffice/marketplace/${scopeKind}/${scopeId}/organization/all`,
      );
      return loader({
        request: new Request(url),
        params: { scopeKind, scopeId, catalog: "organization" },
        context,
        url,
      } as never);
    };

    const result = await runCatalog("org", "ada-labs");
    assert(!(result instanceof Response));
    assert(result.catalog === "organization");
    expect(marketplaceForMock).toHaveBeenCalledWith({ kind: "org", orgId: "org-1" });

    // Personal workspaces have no organization Marketplace, and non-members cannot resolve one.
    for (const [scopeKind, scopeId] of [
      ["user", "user-1"],
      ["org", "other-labs"],
    ]) {
      marketplaceForMock.mockClear();
      const rejected = await runCatalog(scopeKind, scopeId).catch((error: unknown) => error);
      assert(rejected instanceof Response);
      assert(rejected.status === 404);
      expect(marketplaceForMock).not.toHaveBeenCalled();
    }
  });
});
