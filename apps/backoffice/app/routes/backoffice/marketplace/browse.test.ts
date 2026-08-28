import { assert, beforeEach, describe, expect, test, vi } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

const { findBackofficeMeMock, listPublishedListingsMock } = vi.hoisted(() => ({
  findBackofficeMeMock: vi.fn(),
  listPublishedListingsMock: vi.fn(),
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
      objects: { marketplace: { singleton: () => ({ commands: marketplace }) } },
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

    const result = await loader({ request: new Request(url), context, url } as never);

    assert(!(result instanceof Response));
    expect(listPublishedListingsMock).toHaveBeenCalledWith({});
    assert(!("category" in result));
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
