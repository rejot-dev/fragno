import { assert, beforeEach, describe, expect, test, vi } from "vitest";

import { RouterContextProvider } from "react-router";

import type { BackofficeResolvedScope } from "@/backoffice-runtime/resolved-scope";
import type { BackofficeMeData, Organization } from "@/fragno/auth/contracts";
import { provideBackofficeShellRequest } from "@/layouts/backoffice-layout.test-support";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

const { listPublishedListingsMock, marketplaceForMock } = vi.hoisted(() => ({
  listPublishedListingsMock: vi.fn(),
  marketplaceForMock: vi.fn(),
}));

import { loader } from "./browse-all";

const authenticatedUser = {
  user: { id: "user-1", email: "ada@example.com" },
  organizations: [{ organization: { id: "org-1", slug: "ada-labs", name: "Ada Labs" } }],
  activeOrganization: {
    organization: { id: "org-1", slug: "ada-labs", name: "Ada Labs" },
  },
};
const marketplace = { listPublishedListings: listPublishedListingsMock };
function routeContext(routeScope: BackofficeResolvedScope<Organization>) {
  const context = new RouterContextProvider();
  context.set(BackofficeWorkerContext, {
    runtime: { objects: { marketplace: { for: marketplaceForMock } } },
  } as never);
  provideBackofficeShellRequest(context, {
    me: authenticatedUser as unknown as BackofficeMeData,
    routeScope,
  });
  return context;
}
const adaLabs = { kind: "org", organization: authenticatedUser.organizations[0]!.organization };
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
  listPublishedListingsMock.mockReset();
  marketplaceForMock.mockReset();
  marketplaceForMock.mockReturnValue({ commands: marketplace });
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
      context: routeContext(adaLabs as never),
      url,
    } as never);

    assert(!(result instanceof Response));
    expect(listPublishedListingsMock).toHaveBeenCalledWith({});
    assert(!("category" in result));
  });

  test("the organization catalog reads the route organization's Marketplace", async () => {
    const runCatalog = (routeScope: BackofficeResolvedScope<Organization>, scopeId: string) => {
      const url = new URL(
        `https://example.test/backoffice/marketplace/${routeScope.kind}/${scopeId}/organization/all`,
      );
      return loader({
        request: new Request(url),
        params: { scopeKind: routeScope.kind, scopeId, catalog: "organization" },
        context: routeContext(routeScope),
        url,
      } as never);
    };

    const result = await runCatalog(adaLabs as never, "ada-labs");
    assert(!(result instanceof Response));
    assert(result.catalog === "organization");
    expect(marketplaceForMock).toHaveBeenCalledWith({ kind: "org", orgId: "org-1" });

    // Personal workspaces have no organization Marketplace.
    marketplaceForMock.mockClear();
    const rejected = await runCatalog({ kind: "user", userId: "user-1" }, "user-1").catch(
      (error: unknown) => error,
    );
    assert(rejected instanceof Response);
    assert(rejected.status === 404);
    expect(marketplaceForMock).not.toHaveBeenCalled();
  });
});
