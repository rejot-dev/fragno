import { column, idColumn, referenceColumn, schema, type Column } from "@fragno-dev/db/schema";

import type {
  MarketplaceCategory,
  MarketplaceListingContent,
  MarketplaceListingStatus,
  MarketplaceOwnerScope,
  MarketplaceVersionStatus,
} from "./contracts";

const jsonColumn = <T>() => column("json") as Column<"json", T, T>;
const categoryColumn = () =>
  column("string") as Column<"string", MarketplaceCategory, MarketplaceCategory>;
const listingStatusColumn = () =>
  column("string") as Column<"string", MarketplaceListingStatus, MarketplaceListingStatus>;
const versionStatusColumn = () =>
  column("string") as Column<"string", MarketplaceVersionStatus, MarketplaceVersionStatus>;

export const marketplaceFragmentSchema = schema("marketplace", (s) =>
  s
    .addTable("marketplace_listing", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("publisherName", column("string"))
        .addColumn("metadata", jsonColumn<MarketplaceListingContent>())
        .addColumn("category", categoryColumn())
        .addColumn("status", listingStatusColumn())
        .addColumn("latestPublishedVersion", column("string").nullable())
        .addColumn("publishedAt", column("timestamp").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_marketplace_listing_status_publishedAt_id", [
          "status",
          "publishedAt",
          "id",
        ])
        .createIndex("idx_marketplace_listing_status_category_publishedAt_id", [
          "status",
          "category",
          "publishedAt",
          "id",
        ]),
    )
    .addTable("marketplace_listing_owner", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("listingId", referenceColumn({ table: "marketplace_listing" }))
        .addColumn("ownerKey", column("string"))
        .addColumn("ownerScope", jsonColumn<MarketplaceOwnerScope>())
        .addColumn("listingStatus", listingStatusColumn())
        .addColumn("listingUpdatedAt", column("timestamp"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex(
          "idx_marketplace_listing_owner_listingId_ownerKey",
          ["listingId", "ownerKey"],
          { unique: true },
        )
        .createIndex("idx_marketplace_listing_owner_ownerKey_listingUpdatedAt_listingId", [
          "ownerKey",
          "listingUpdatedAt",
          "listingId",
        ])
        .createIndex(
          "idx_marketplace_listing_owner_ownerKey_listingStatus_listingUpdatedAt_listingId",
          ["ownerKey", "listingStatus", "listingUpdatedAt", "listingId"],
        ),
    )
    .addTable("marketplace_version", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("listingId", referenceColumn({ table: "marketplace_listing" }))
        .addColumn("version", column("string"))
        .addColumn("status", versionStatusColumn())
        .addColumn("publishedAt", column("timestamp").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_marketplace_version_listingId_status_publishedAt_id", [
          "listingId",
          "status",
          "publishedAt",
          "id",
        ])
        .createIndex("idx_marketplace_version_listingId_createdAt_id", [
          "listingId",
          "createdAt",
          "id",
        ]),
    )
    .alterTable("marketplace_version", (t) =>
      t.addColumn("artifactDirectory", column("string").nullable()),
    ),
);
