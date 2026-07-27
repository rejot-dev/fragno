import { afterAll, assert, describe, expect, test } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { marketplaceFragmentDefinition } from "./definition";
import { marketplaceListingId } from "./owner";
import { marketplaceRoutes } from "./routes";

const listingId = marketplaceListingId({
  ownerScope: { kind: "org", orgId: "org-1" },
  slug: "daily-operations-brief",
});

const draftInput = {
  owner: {
    scope: { kind: "org" as const, orgId: "org-1" },
    publisherName: "Acme",
  },
  slug: "daily-operations-brief",
  version: "1.0.0",
  metadata: {
    name: "Daily operations brief",
    summary: "Build and deliver a concise daily operations report.",
    description:
      "Collects operational events and produces a daily report for the configured channel.",
    category: "operations" as const,
    tags: ["reporting"],
  },
};

describe("marketplace public routes", async () => {
  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "marketplace",
      instantiate(marketplaceFragmentDefinition).withConfig({}).withRoutes([marketplaceRoutes]),
    )
    .build();

  const fragment = fragments.marketplace.fragment;

  afterAll(async () => {
    await testContext.cleanup();
  });

  test("lists and retrieves published marketplace metadata", async () => {
    await fragment.callServices(() => fragment.services.createDraftListing(draftInput));
    await fragment.callServices(() =>
      fragment.services.publishVersion({
        listingId,
        version: draftInput.version,
        owner: draftInput.owner,
      }),
    );

    const listings = await fragment.callRoute("GET", "/listings");
    assert(listings.type === "json");
    expect(listings.data.listings).toEqual([
      expect.objectContaining({
        slug: "daily-operations-brief",
        summary: "Build and deliver a concise daily operations report.",
      }),
    ]);

    const detail = await fragment.callRoute("GET", "/listings/:listingId", {
      pathParams: { listingId },
    });
    assert(detail.type === "json");
    expect(detail.data).toMatchObject({
      listing: { listingId, slug: "daily-operations-brief", latestVersion: "1.0.0" },
      versions: [{ version: "1.0.0" }],
    });
  });

  test("maps invalid query metadata and missing listings", async () => {
    const invalidQuery = await fragment.callRoute("GET", "/listings", {
      query: { category: "not-a-category" },
    });
    assert(invalidQuery.type === "error");
    assert(invalidQuery.status === 400);
    expect(invalidQuery.error).toMatchObject({ code: "MARKETPLACE_INPUT_INVALID" });

    const invalidListingId = await fragment.callRoute("GET", "/listings/:listingId", {
      pathParams: { listingId: "INVALID LISTING ID" },
    });
    assert(invalidListingId.type === "error");
    assert(invalidListingId.status === 400);
    expect(invalidListingId.error).toMatchObject({ code: "MARKETPLACE_INPUT_INVALID" });

    const missing = await fragment.callRoute("GET", "/listings/:listingId", {
      pathParams: { listingId: "system#missing-listing" },
    });
    assert(missing.type === "error");
    assert(missing.status === 404);
    expect(missing.error).toMatchObject({ code: "MARKETPLACE_LISTING_NOT_FOUND" });
  });
});
