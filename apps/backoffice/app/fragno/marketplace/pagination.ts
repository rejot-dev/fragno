import { decodeCursor, type Cursor } from "@fragno-dev/db";

import {
  MARKETPLACE_MAX_PAGE_SIZE,
  type MarketplaceListingStatus,
  type MarketplaceOwnerScope,
} from "./contracts";
import { marketplaceOwnerKey } from "./owner";

export const MARKETPLACE_LISTING_INDEX = "idx_marketplace_listing_status_publishedAt_id";
export const MARKETPLACE_CATEGORY_LISTING_INDEX =
  "idx_marketplace_listing_status_category_publishedAt_id";
export const MARKETPLACE_OWNED_LISTING_INDEX =
  "idx_marketplace_listing_owner_ownerKey_listingUpdatedAt_listingId";
export const MARKETPLACE_OWNED_LISTING_STATUS_INDEX =
  "idx_marketplace_listing_owner_ownerKey_listingStatus_listingUpdatedAt_listingId";
export const MARKETPLACE_PUBLISHED_VERSION_INDEX =
  "idx_marketplace_version_listingId_status_publishedAt_id";
export const MARKETPLACE_OWNED_VERSION_INDEX = "idx_marketplace_version_listingId_createdAt_id";

export class MarketplaceListingCursorError extends Error {
  readonly code = "MARKETPLACE_LISTING_CURSOR_INVALID";

  constructor() {
    super("Marketplace listing cursor is invalid.");
    this.name = "MarketplaceListingCursorError";
  }
}

const decodeMarketplaceCursor = (
  encodedCursor: string | undefined,
  isExpectedCursor: (cursor: Cursor) => boolean,
): Cursor | undefined => {
  if (!encodedCursor) {
    return undefined;
  }

  try {
    const cursor = decodeCursor(encodedCursor);
    if (
      cursor.orderDirection !== "desc" ||
      cursor.pageSize > MARKETPLACE_MAX_PAGE_SIZE ||
      !isExpectedCursor(cursor)
    ) {
      throw new MarketplaceListingCursorError();
    }
    return cursor;
  } catch (error) {
    if (error instanceof MarketplaceListingCursorError) {
      throw error;
    }
    throw new MarketplaceListingCursorError();
  }
};

export const decodeMarketplaceListingCursor = (input: {
  encodedCursor?: string;
  category?: string;
}): Cursor | undefined =>
  decodeMarketplaceCursor(input.encodedCursor, (cursor) => {
    const expectedIndex = input.category
      ? MARKETPLACE_CATEGORY_LISTING_INDEX
      : MARKETPLACE_LISTING_INDEX;

    return (
      cursor.indexName === expectedIndex &&
      cursor.indexValues.status === "published" &&
      (!input.category || cursor.indexValues.category === input.category)
    );
  });

export const decodeMarketplaceOwnedListingCursor = (input: {
  encodedCursor?: string;
  ownerScope: MarketplaceOwnerScope;
  status?: MarketplaceListingStatus;
}): Cursor | undefined => {
  const ownerKey = marketplaceOwnerKey(input.ownerScope);
  return decodeMarketplaceCursor(input.encodedCursor, (cursor) => {
    const expectedIndex = input.status
      ? MARKETPLACE_OWNED_LISTING_STATUS_INDEX
      : MARKETPLACE_OWNED_LISTING_INDEX;

    return (
      cursor.indexName === expectedIndex &&
      cursor.indexValues.ownerKey === ownerKey &&
      (!input.status || cursor.indexValues.listingStatus === input.status)
    );
  });
};

type MarketplaceVersionCursorKind = "published" | "owned";

type MarketplaceVersionCursorEnvelope = {
  v: 1;
  kind: MarketplaceVersionCursorKind;
  listingSlug: string;
  databaseCursor: string;
};

const encodeMarketplaceVersionCursorEnvelope = (
  envelope: MarketplaceVersionCursorEnvelope,
): string => {
  const json = JSON.stringify(envelope);
  return typeof Buffer !== "undefined" ? Buffer.from(json, "utf-8").toString("base64") : btoa(json);
};

const decodeMarketplaceVersionCursorEnvelope = (
  encodedCursor: string,
): MarketplaceVersionCursorEnvelope => {
  try {
    const json =
      typeof Buffer !== "undefined"
        ? Buffer.from(encodedCursor, "base64").toString("utf-8")
        : atob(encodedCursor);
    const value = JSON.parse(json) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      !("v" in value) ||
      value.v !== 1 ||
      !("kind" in value) ||
      (value.kind !== "published" && value.kind !== "owned") ||
      !("listingSlug" in value) ||
      typeof value.listingSlug !== "string" ||
      !("databaseCursor" in value) ||
      typeof value.databaseCursor !== "string"
    ) {
      throw new MarketplaceListingCursorError();
    }
    return value as MarketplaceVersionCursorEnvelope;
  } catch (error) {
    if (error instanceof MarketplaceListingCursorError) {
      throw error;
    }
    throw new MarketplaceListingCursorError();
  }
};

const decodeMarketplaceVersionCursor = (input: {
  encodedCursor?: string;
  listingSlug: string;
  kind: MarketplaceVersionCursorKind;
  isExpectedCursor: (cursor: Cursor) => boolean;
}): Cursor | undefined => {
  if (!input.encodedCursor) {
    return undefined;
  }

  const envelope = decodeMarketplaceVersionCursorEnvelope(input.encodedCursor);
  if (envelope.kind !== input.kind || envelope.listingSlug !== input.listingSlug) {
    throw new MarketplaceListingCursorError();
  }
  return decodeMarketplaceCursor(envelope.databaseCursor, input.isExpectedCursor);
};

export const encodeMarketplacePublishedVersionCursor = (
  cursor: Cursor,
  listingSlug: string,
): string =>
  encodeMarketplaceVersionCursorEnvelope({
    v: 1,
    kind: "published",
    listingSlug,
    databaseCursor: cursor.encode(),
  });

export const decodeMarketplacePublishedVersionCursor = (input: {
  encodedCursor?: string;
  listingSlug: string;
}): Cursor | undefined =>
  decodeMarketplaceVersionCursor({
    ...input,
    kind: "published",
    isExpectedCursor: (cursor) =>
      cursor.indexName === MARKETPLACE_PUBLISHED_VERSION_INDEX &&
      cursor.indexValues.status === "published",
  });

export const encodeMarketplaceOwnedVersionCursor = (cursor: Cursor, listingSlug: string): string =>
  encodeMarketplaceVersionCursorEnvelope({
    v: 1,
    kind: "owned",
    listingSlug,
    databaseCursor: cursor.encode(),
  });

export const decodeMarketplaceOwnedVersionCursor = (input: {
  encodedCursor?: string;
  listingSlug: string;
}): Cursor | undefined =>
  decodeMarketplaceVersionCursor({
    ...input,
    kind: "owned",
    isExpectedCursor: (cursor) => cursor.indexName === MARKETPLACE_OWNED_VERSION_INDEX,
  });
