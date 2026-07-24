import { afterAll, assert, describe, expect, test } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { marketplaceFragmentDefinition } from "./definition";
import { marketplaceRoutes } from "./routes";

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
        slug: draftInput.slug,
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

    const detail = await fragment.callRoute("GET", "/listings/:slug", {
      pathParams: { slug: "daily-operations-brief" },
    });
    assert(detail.type === "json");
    expect(detail.data).toMatchObject({
      listing: { slug: "daily-operations-brief", latestVersion: "1.0.0" },
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

    const invalidSlug = await fragment.callRoute("GET", "/listings/:slug", {
      pathParams: { slug: "INVALID SLUG" },
    });
    assert(invalidSlug.type === "error");
    assert(invalidSlug.status === 400);
    expect(invalidSlug.error).toMatchObject({ code: "MARKETPLACE_INPUT_INVALID" });

    const missing = await fragment.callRoute("GET", "/listings/:slug", {
      pathParams: { slug: "missing-listing" },
    });
    assert(missing.type === "error");
    assert(missing.status === 404);
    expect(missing.error).toMatchObject({ code: "MARKETPLACE_LISTING_NOT_FOUND" });
  });
});
