import { assert, describe, expect, test } from "vitest";

import { matchRoutes } from "react-router";

import { marketplaceListingId } from "@/fragno/marketplace/owner";

import {
  marketplaceListingManagePath,
  marketplaceListingPath,
  marketplaceListingRef,
  marketplaceListingRefSchema,
} from "./navigation";

describe("marketplace listing navigation", () => {
  test("preserves listing ids whose owner ids contain path separators", () => {
    const listingId = marketplaceListingId({
      ownerScope: { kind: "org", orgId: "engineering/platform" },
      slug: "daily-operations-brief",
    });
    const path = marketplaceListingPath(listingId);
    const matches = matchRoutes([{ path: "/backoffice/marketplace/:listingRef" }], path);
    const routeParam = matches?.[0]?.params.listingRef;

    assert(routeParam);
    expect(marketplaceListingRefSchema.parse(routeParam)).toBe(listingId);
  });

  test("rejects malformed and non-listing references at the route boundary", () => {
    assert(!marketplaceListingRefSchema.safeParse("not%base64").success);
    assert(
      !marketplaceListingRefSchema.safeParse(marketplaceListingRef("not-a-listing-id")).success,
    );
  });

  test("builds manage paths with their required organization context", () => {
    const listingId = marketplaceListingId({
      ownerScope: { kind: "org", orgId: "org-1" },
      slug: "daily-operations-brief",
    });

    expect(
      marketplaceListingManagePath({
        listingId,
        organizationId: "org-1",
        result: { created: "1.0.0" },
      }),
    ).toBe(`${marketplaceListingPath(listingId)}/manage?organizationId=org-1&created=1.0.0`);
  });
});
