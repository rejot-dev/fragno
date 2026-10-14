import { assert, beforeEach, describe, expect, test, vi } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

const { findBackofficeMeMock, listPublishedListingsMock, marketplaceForMock } = vi.hoisted(() => ({
  findBackofficeMeMock: vi.fn(),
  listPublishedListingsMock: vi.fn(),
  marketplaceForMock: vi.fn(),
}));

vi.mock("@/fragno/auth/auth-server", () => ({ findBackofficeMe: findBackofficeMeMock }));

import BackofficeMarketplaceBrowse, { loader } from "./browse";

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

describe("Marketplace featured browse", () => {
  test("ignores legacy category filters and always requests the unfiltered Marketplace", async () => {
    const url = new URL(
      "https://example.test/backoffice/marketplace/org/ada-labs/marketplace?category=communication",
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
        `https://example.test/backoffice/marketplace/${scopeKind}/${scopeId}/organization`,
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

  test("presents published packages as featured items without filter controls", () => {
    const router = createMemoryRouter(
      [
        {
          element: createElement(Outlet, {
            context: {
              selectedScope: {
                kind: "org",
                organization: { id: "org-1", slug: "ada-labs" },
                label: "Ada Labs",
              },
            },
          }),
          children: [
            {
              path: "*",
              element: createElement(BackofficeMarketplaceBrowse, {
                loaderData: {
                  basePath: "/backoffice/marketplace/org/ada-labs/marketplace",
                  catalog: "marketplace",
                  listings,
                  hasNextPage: false,
                },
              } as never),
            },
          ],
        },
      ],
      { initialEntries: ["/backoffice/marketplace/org/ada-labs/marketplace"] },
    );

    const markup = renderToStaticMarkup(createElement(RouterProvider, { router }));

    assert(markup.includes("Featured packages"));
    assert(markup.includes("Featured"));
    assert(!markup.includes("Ready to add to Ada Labs."));
    assert(!markup.includes("Apply filter"));
    assert(!markup.includes("<select"));
  });
});
