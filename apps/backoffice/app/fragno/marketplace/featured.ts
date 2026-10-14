import type { MarketplaceFeatureState } from "@fragno-dev/backoffice-api/v0/marketplace";

import type { MarketplaceListingStatus } from "./contracts";

type MarketplaceFeatureWindow = {
  priority: number;
  startsAt: Date;
  until: Date | null;
};

/** Windows are evaluated when read, so entries expire and start without scheduled work. */
export function marketplaceFeatureState(
  entry: MarketplaceFeatureWindow,
  listingStatus: MarketplaceListingStatus | null,
  now: Date,
): MarketplaceFeatureState {
  if (listingStatus !== "published") {
    return "hidden";
  }
  if (entry.until && entry.until <= now) {
    return "expired";
  }
  return entry.startsAt > now ? "scheduled" : "active";
}

/** Higher priority first; equal priorities show the most recently started entry first. */
export function compareMarketplaceFeatureEntries(
  left: MarketplaceFeatureWindow,
  right: MarketplaceFeatureWindow,
): number {
  return right.priority - left.priority || right.startsAt.getTime() - left.startsAt.getTime();
}
