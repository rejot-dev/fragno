import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import { marketplaceArtifactUploadName } from "./artifacts";
import {
  marketplaceAddDraftVersionInputSchema,
  marketplaceArchiveListingInputSchema,
  marketplaceArtifactManifestInputSchema,
  marketplaceCreateDraftListingInputSchema,
  marketplaceInsertStaticEntriesInputSchema,
  marketplaceListingPageInputSchema,
  marketplaceOwnedListingInputSchema,
  marketplaceOwnedListingPageInputSchema,
  marketplacePublishedListingInputSchema,
  marketplacePublishVersionInputSchema,
  marketplaceUpdateListingInputSchema,
  type MarketplaceArchiveResult,
  type MarketplaceArtifactManifest,
  type MarketplaceDraftResult,
  type MarketplaceInsertStaticEntriesResult,
  type MarketplaceListingDetail,
  type MarketplaceListingPage,
  type MarketplaceListingPageInput,
  type MarketplaceListingUpdateResult,
  type MarketplaceOwnedListingDetail,
  type MarketplaceOwnedListingPage,
  type MarketplaceOwnedListingPageInput,
  type MarketplaceOperationErrorCode,
  type MarketplaceOwner,
  type MarketplacePublishedListingInput,
  type MarketplacePublishVersionResult,
} from "./contracts";
import {
  marketplaceListingId,
  marketplaceListingSlug,
  marketplaceOwnerKey,
  marketplaceVersionId,
} from "./owner";
import {
  decodeMarketplaceListingCursor,
  decodeMarketplaceOwnedListingCursor,
  decodeMarketplaceOwnedVersionCursor,
  decodeMarketplacePublishedVersionCursor,
  encodeMarketplaceOwnedVersionCursor,
  encodeMarketplacePublishedVersionCursor,
  MARKETPLACE_CATEGORY_LISTING_INDEX,
  MARKETPLACE_LISTING_INDEX,
  MARKETPLACE_OWNED_LISTING_INDEX,
  MARKETPLACE_OWNED_LISTING_STATUS_INDEX,
  MARKETPLACE_OWNED_VERSION_INDEX,
  MARKETPLACE_PUBLISHED_VERSION_INDEX,
} from "./pagination";
import { marketplaceFragmentSchema } from "./schema";

export class MarketplaceDomainError extends Error {
  constructor(
    readonly code: MarketplaceOperationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class MarketplaceOwnerConflictError extends MarketplaceDomainError {
  constructor(slug: string) {
    super("MARKETPLACE_OWNER_CONFLICT", `Marketplace listing ${slug} has a different owner.`);
    this.name = "MarketplaceOwnerConflictError";
  }
}

export class MarketplaceListingConflictError extends MarketplaceDomainError {
  constructor(slug: string) {
    super("MARKETPLACE_LISTING_CONFLICT", `Marketplace listing ${slug} already exists.`);
    this.name = "MarketplaceListingConflictError";
  }
}

export class MarketplaceListingArchivedError extends MarketplaceDomainError {
  constructor(slug: string) {
    super("MARKETPLACE_LISTING_ARCHIVED", `Marketplace listing ${slug} is archived.`);
    this.name = "MarketplaceListingArchivedError";
  }
}

export class MarketplaceListingNotFoundError extends MarketplaceDomainError {
  constructor(slug: string) {
    super("MARKETPLACE_LISTING_NOT_FOUND", `Marketplace listing ${slug} was not found.`);
    this.name = "MarketplaceListingNotFoundError";
  }
}

export class MarketplaceVersionNotFoundError extends MarketplaceDomainError {
  constructor(slug: string, version: string) {
    super("MARKETPLACE_VERSION_NOT_FOUND", `Marketplace version ${slug}@${version} was not found.`);
    this.name = "MarketplaceVersionNotFoundError";
  }
}

export class MarketplaceVersionTransitionError extends MarketplaceDomainError {
  constructor(slug: string, version: string) {
    super(
      "MARKETPLACE_VERSION_TRANSITION_INVALID",
      `Marketplace version ${slug}@${version} cannot become the latest published version.`,
    );
    this.name = "MarketplaceVersionTransitionError";
  }
}

const assertOwnerOwnsListing = (
  owners: readonly { ownerKey: string }[],
  owner: MarketplaceOwner,
  slug: string,
) => {
  if (!owners.some((candidate) => candidate.ownerKey === marketplaceOwnerKey(owner.scope))) {
    throw new MarketplaceOwnerConflictError(slug);
  }
};

export const marketplaceFragmentDefinition = defineFragment("marketplace")
  .extend(withDatabase(marketplaceFragmentSchema))
  .providesBaseService(({ defineService }) =>
    defineService({
      listPublishedListings: function (rawInput: MarketplaceListingPageInput = {}) {
        const input = marketplaceListingPageInputSchema.parse(rawInput);
        const category = input.category;
        const cursor = decodeMarketplaceListingCursor({
          encodedCursor: input.cursor,
          category,
        });
        const effectivePageSize = cursor?.pageSize ?? input.pageSize;

        return this.serviceTx(marketplaceFragmentSchema)
          .retrieve((uow) =>
            uow.findWithCursor("marketplace_listing", (b) => {
              if (category) {
                const categoryQuery = b
                  .whereIndex(MARKETPLACE_CATEGORY_LISTING_INDEX, (eb) =>
                    eb.and(eb("status", "=", "published"), eb("category", "=", category)),
                  )
                  .orderByIndex(MARKETPLACE_CATEGORY_LISTING_INDEX, "desc")
                  .pageSize(effectivePageSize);
                return cursor ? categoryQuery.after(cursor) : categoryQuery;
              }

              const listingQuery = b
                .whereIndex(MARKETPLACE_LISTING_INDEX, (eb) => eb("status", "=", "published"))
                .orderByIndex(MARKETPLACE_LISTING_INDEX, "desc")
                .pageSize(effectivePageSize);
              return cursor ? listingQuery.after(cursor) : listingQuery;
            }),
          )
          .transformRetrieve(
            ([page]) =>
              ({
                listings: page.items.map((listing) => {
                  if (!listing.latestPublishedVersion || !listing.publishedAt) {
                    throw new Error(
                      `Published marketplace listing ${listing.id.externalId} is incomplete.`,
                    );
                  }

                  return {
                    listingId: listing.id.externalId,
                    slug: marketplaceListingSlug(listing.id.externalId),
                    publisherName: listing.publisherName,
                    ...listing.metadata,
                    category: listing.category,
                    status: "published" as const,
                    latestVersion: listing.latestPublishedVersion,
                    publishedAt: listing.publishedAt.toISOString(),
                    updatedAt: listing.updatedAt.toISOString(),
                  };
                }),
                ...(page.cursor ? { nextCursor: page.cursor.encode() } : {}),
                hasNextPage: page.hasNextPage,
              }) satisfies MarketplaceListingPage,
          )
          .build();
      },

      getPublishedListing: function (rawInput: MarketplacePublishedListingInput) {
        const input = marketplacePublishedListingInputSchema.parse(rawInput);
        const versionCursor = decodeMarketplacePublishedVersionCursor({
          encodedCursor: input.versionCursor,
          listingId: input.listingId,
        });
        const effectiveVersionPageSize = versionCursor?.pageSize ?? input.versionPageSize;

        return this.serviceTx(marketplaceFragmentSchema)
          .retrieve((uow) =>
            uow
              .findFirst("marketplace_listing", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", input.listingId)),
              )
              .findWithCursor("marketplace_version", (b) => {
                const versionQuery = b
                  .whereIndex(MARKETPLACE_PUBLISHED_VERSION_INDEX, (eb) =>
                    eb.and(eb("listingId", "=", input.listingId), eb("status", "=", "published")),
                  )
                  .orderByIndex(MARKETPLACE_PUBLISHED_VERSION_INDEX, "desc")
                  .pageSize(effectiveVersionPageSize);
                return versionCursor ? versionQuery.after(versionCursor) : versionQuery;
              }),
          )
          .transformRetrieve(([listing, versionPage]): MarketplaceListingDetail | null => {
            if (
              listing?.status !== "published" ||
              !listing.latestPublishedVersion ||
              !listing.publishedAt
            ) {
              return null;
            }

            return {
              listing: {
                listingId: listing.id.externalId,
                slug: marketplaceListingSlug(listing.id.externalId),
                publisherName: listing.publisherName,
                ...listing.metadata,
                category: listing.category,
                status: "published",
                latestVersion: listing.latestPublishedVersion,
                publishedAt: listing.publishedAt.toISOString(),
                updatedAt: listing.updatedAt.toISOString(),
              },
              versions: versionPage.items.map((version) => {
                if (!version.publishedAt) {
                  throw new Error(
                    `Published marketplace version ${version.version} is incomplete.`,
                  );
                }
                return {
                  version: version.version,
                  publishedAt: version.publishedAt.toISOString(),
                };
              }),
              ...(versionPage.cursor
                ? {
                    nextVersionCursor: encodeMarketplacePublishedVersionCursor(
                      versionPage.cursor,
                      input.listingId,
                    ),
                  }
                : {}),
              hasNextVersionPage: versionPage.hasNextPage,
            };
          })
          .build();
      },

      getArtifactManifest: function (rawInput: unknown) {
        const input = marketplaceArtifactManifestInputSchema.parse(rawInput);

        return this.serviceTx(marketplaceFragmentSchema)
          .retrieve((uow) =>
            uow
              .findFirst("marketplace_listing", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", input.listingId)),
              )
              .find("marketplace_version", (b) =>
                b
                  .whereIndex(MARKETPLACE_PUBLISHED_VERSION_INDEX, (eb) =>
                    eb.and(eb("listingId", "=", input.listingId), eb("status", "=", "published")),
                  )
                  .orderByIndex(MARKETPLACE_PUBLISHED_VERSION_INDEX, "desc"),
              ),
          )
          .transformRetrieve(([listing, versions]): MarketplaceArtifactManifest | null => {
            if (!listing) {
              return null;
            }

            return {
              listingId: listing.id.externalId,
              slug: marketplaceListingSlug(listing.id.externalId),
              listingStatus: listing.status,
              uploadName: marketplaceArtifactUploadName(listing.id.externalId),
              versions: versions.flatMap((version) =>
                version.artifactDirectory
                  ? [{ version: version.version, directory: version.artifactDirectory }]
                  : [],
              ),
            };
          })
          .build();
      },

      listOwnedListings: function (rawInput: MarketplaceOwnedListingPageInput) {
        const input = marketplaceOwnedListingPageInputSchema.parse(rawInput);
        const ownerKey = marketplaceOwnerKey(input.ownerScope);
        const status = input.status;
        const cursor = decodeMarketplaceOwnedListingCursor({
          encodedCursor: input.cursor,
          ownerScope: input.ownerScope,
          status,
        });
        const effectivePageSize = cursor?.pageSize ?? input.pageSize;

        return this.serviceTx(marketplaceFragmentSchema)
          .retrieve((uow) =>
            uow.findWithCursor("marketplace_listing_owner", (b) => {
              const ownership = b.joinOne("listing", "marketplace_listing", (listing) =>
                listing.onIndex("primary", (eb) => eb("id", "=", eb.parent("listingId"))),
              );
              if (status) {
                const statusQuery = ownership
                  .whereIndex(MARKETPLACE_OWNED_LISTING_STATUS_INDEX, (eb) =>
                    eb.and(eb("ownerKey", "=", ownerKey), eb("listingStatus", "=", status)),
                  )
                  .orderByIndex(MARKETPLACE_OWNED_LISTING_STATUS_INDEX, "desc")
                  .pageSize(effectivePageSize);
                return cursor ? statusQuery.after(cursor) : statusQuery;
              }

              const listingQuery = ownership
                .whereIndex(MARKETPLACE_OWNED_LISTING_INDEX, (eb) => eb("ownerKey", "=", ownerKey))
                .orderByIndex(MARKETPLACE_OWNED_LISTING_INDEX, "desc")
                .pageSize(effectivePageSize);
              return cursor ? listingQuery.after(cursor) : listingQuery;
            }),
          )
          .transformRetrieve(
            ([page]) =>
              ({
                listings: page.items.map((ownership) => {
                  const listing = ownership.listing;
                  if (!listing) {
                    throw new Error(`Marketplace owner ${ownership.id.externalId} has no listing.`);
                  }
                  return {
                    listingId: listing.id.externalId,
                    slug: marketplaceListingSlug(listing.id.externalId),
                    publisherName: listing.publisherName,
                    ...listing.metadata,
                    category: listing.category,
                    status: listing.status,
                    latestPublishedVersion: listing.latestPublishedVersion,
                    publishedAt: listing.publishedAt?.toISOString() ?? null,
                    createdAt: listing.createdAt.toISOString(),
                    updatedAt: listing.updatedAt.toISOString(),
                  };
                }),
                ...(page.cursor ? { nextCursor: page.cursor.encode() } : {}),
                hasNextPage: page.hasNextPage,
              }) satisfies MarketplaceOwnedListingPage,
          )
          .build();
      },

      getOwnedListing: function (rawInput: unknown) {
        const input = marketplaceOwnedListingInputSchema.parse(rawInput);
        const ownerKey = marketplaceOwnerKey(input.ownerScope);
        const versionCursor = decodeMarketplaceOwnedVersionCursor({
          encodedCursor: input.versionCursor,
          listingId: input.listingId,
        });
        const effectiveVersionPageSize = versionCursor?.pageSize ?? input.versionPageSize;

        return this.serviceTx(marketplaceFragmentSchema)
          .retrieve((uow) =>
            uow
              .findFirst("marketplace_listing_owner", (b) =>
                b
                  .whereIndex("idx_marketplace_listing_owner_listingId_ownerKey", (eb) =>
                    eb.and(eb("listingId", "=", input.listingId), eb("ownerKey", "=", ownerKey)),
                  )
                  .joinOne("listing", "marketplace_listing", (listing) =>
                    listing.onIndex("primary", (eb) => eb("id", "=", eb.parent("listingId"))),
                  ),
              )
              .findWithCursor("marketplace_version", (b) => {
                const versionQuery = b
                  .whereIndex(MARKETPLACE_OWNED_VERSION_INDEX, (eb) =>
                    eb("listingId", "=", input.listingId),
                  )
                  .orderByIndex(MARKETPLACE_OWNED_VERSION_INDEX, "desc")
                  .pageSize(effectiveVersionPageSize);
                return versionCursor ? versionQuery.after(versionCursor) : versionQuery;
              }),
          )
          .transformRetrieve(([ownership, versionPage]): MarketplaceOwnedListingDetail | null => {
            const listing = ownership?.listing;
            if (!listing) {
              return null;
            }

            return {
              listing: {
                listingId: listing.id.externalId,
                slug: marketplaceListingSlug(listing.id.externalId),
                publisherName: listing.publisherName,
                ...listing.metadata,
                category: listing.category,
                status: listing.status,
                latestPublishedVersion: listing.latestPublishedVersion,
                publishedAt: listing.publishedAt?.toISOString() ?? null,
                createdAt: listing.createdAt.toISOString(),
                updatedAt: listing.updatedAt.toISOString(),
              },
              versions: versionPage.items.map((version) => ({
                version: version.version,
                status: version.status,
                createdAt: version.createdAt.toISOString(),
                publishedAt: version.publishedAt?.toISOString() ?? null,
              })),
              ...(versionPage.cursor
                ? {
                    nextVersionCursor: encodeMarketplaceOwnedVersionCursor(
                      versionPage.cursor,
                      input.listingId,
                    ),
                  }
                : {}),
              hasNextVersionPage: versionPage.hasNextPage,
            };
          })
          .build();
      },

      insertStaticEntries: function (rawInput: unknown) {
        const input = marketplaceInsertStaticEntriesInputSchema.parse(rawInput);
        const entries = input.entries.map((entry) => {
          const listingId = marketplaceListingId({
            ownerScope: entry.owner.scope,
            slug: entry.slug,
          });
          return {
            entry,
            listingId,
            versionId: marketplaceVersionId({ listingId, version: entry.version }),
          };
        });
        const listingIds = entries.map((entry) => entry.listingId);
        const versionIds = entries.map((entry) => entry.versionId);

        return this.serviceTx(marketplaceFragmentSchema)
          .retrieve((uow) =>
            uow
              .find("marketplace_listing", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "in", listingIds)),
              )
              .find("marketplace_version", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "in", versionIds)),
              )
              .find("marketplace_listing_owner", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "in", listingIds)),
              ),
          )
          .mutate(
            ({
              uow,
              retrieveResult: [existingListings, existingVersions, existingOwners],
            }): MarketplaceInsertStaticEntriesResult => {
              const listingsById = new Map(
                existingListings.map((listing) => [listing.id.externalId, listing]),
              );
              const versionsById = new Map(
                existingVersions.map((version) => [version.id.externalId, version]),
              );
              const ownersById = new Map(
                existingOwners.map((owner) => [owner.id.externalId, owner]),
              );
              const inserted: MarketplaceInsertStaticEntriesResult["inserted"] = [];
              const skipped: MarketplaceInsertStaticEntriesResult["skipped"] = [];
              const now = uow.now();

              for (const { entry, listingId, versionId } of entries) {
                const identity = { listingId, slug: entry.slug, version: entry.version };
                const ownerKey = marketplaceOwnerKey(entry.owner.scope);
                const listing = listingsById.get(listingId);
                const owner = ownersById.get(listingId);
                const version = versionsById.get(versionId);
                const { category, ...metadata } = entry.metadata;

                if (listing) {
                  if (!owner) {
                    throw new MarketplaceOwnerConflictError(entry.slug);
                  }
                  if (version) {
                    if (version.status !== "published" || listing.status !== "published") {
                      throw new MarketplaceVersionTransitionError(entry.slug, entry.version);
                    }
                    skipped.push(identity);
                    continue;
                  }

                  uow.update("marketplace_listing", listing.id, (b) =>
                    b
                      .set({
                        publisherName: entry.owner.publisherName,
                        metadata,
                        category,
                        status: "published",
                        latestPublishedVersion: entry.version,
                        publishedAt: now,
                        updatedAt: now,
                      })
                      .check(),
                  );
                  uow.update("marketplace_listing_owner", owner.id, (b) =>
                    b.set({ listingStatus: "published", listingUpdatedAt: now }).check(),
                  );
                } else {
                  if (version) {
                    throw new MarketplaceListingConflictError(entry.slug);
                  }

                  uow.create("marketplace_listing", {
                    id: listingId,
                    publisherName: entry.owner.publisherName,
                    metadata,
                    category,
                    status: "published",
                    latestPublishedVersion: entry.version,
                    publishedAt: now,
                    createdAt: now,
                    updatedAt: now,
                  });
                  uow.create("marketplace_listing_owner", {
                    id: listingId,
                    listingId,
                    ownerKey,
                    ownerScope: entry.owner.scope,
                    listingStatus: "published",
                    listingUpdatedAt: now,
                    createdAt: now,
                  });
                }

                uow.create("marketplace_version", {
                  id: versionId,
                  listingId,
                  version: entry.version,
                  status: "published",
                  publishedAt: now,
                  createdAt: now,
                });
                inserted.push(identity);
              }

              return { inserted, skipped };
            },
          )
          .build();
      },

      createDraftListing: function (rawInput: unknown) {
        const input = marketplaceCreateDraftListingInputSchema.parse(rawInput);
        const ownerKey = marketplaceOwnerKey(input.owner.scope);
        const listingId = marketplaceListingId({
          ownerScope: input.owner.scope,
          slug: input.slug,
        });
        const versionId = marketplaceVersionId({ listingId, version: input.version });

        return this.serviceTx(marketplaceFragmentSchema)
          .retrieve((uow) =>
            uow
              .findFirst("marketplace_listing", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", listingId)),
              )
              .findFirst("marketplace_version", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", versionId)),
              )
              .find("marketplace_listing_owner", (b) =>
                b.whereIndex("idx_marketplace_listing_owner_listingId_ownerKey", (eb) =>
                  eb("listingId", "=", listingId),
                ),
              ),
          )
          .mutate(({ uow, retrieveResult: [existingListing, existingVersion, owners] }) => {
            if (existingListing) {
              assertOwnerOwnsListing(owners, input.owner, input.slug);
              if (existingVersion) {
                return {
                  listingId,
                  slug: input.slug,
                  version: input.version,
                  created: false,
                } satisfies MarketplaceDraftResult;
              }
              throw new MarketplaceListingConflictError(input.slug);
            }

            const { category, ...metadata } = input.metadata;
            const now = uow.now();
            uow.create("marketplace_listing", {
              id: listingId,
              publisherName: input.owner.publisherName,
              metadata,
              category,
              status: "draft",
              latestPublishedVersion: null,
              publishedAt: null,
              createdAt: now,
              updatedAt: now,
            });
            uow.create("marketplace_listing_owner", {
              id: listingId,
              listingId,
              ownerKey,
              ownerScope: input.owner.scope,
              listingStatus: "draft",
              listingUpdatedAt: now,
              createdAt: now,
            });
            uow.create("marketplace_version", {
              id: versionId,
              listingId,
              version: input.version,
              status: "draft",
              publishedAt: null,
              createdAt: now,
            });

            return {
              listingId,
              slug: input.slug,
              version: input.version,
              created: true,
            } satisfies MarketplaceDraftResult;
          })
          .build();
      },

      addDraftVersion: function (rawInput: unknown) {
        const input = marketplaceAddDraftVersionInputSchema.parse(rawInput);
        const slug = marketplaceListingSlug(input.listingId);
        const versionId = marketplaceVersionId({
          listingId: input.listingId,
          version: input.version,
        });

        return this.serviceTx(marketplaceFragmentSchema)
          .retrieve((uow) =>
            uow
              .findFirst("marketplace_listing", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", input.listingId)),
              )
              .findFirst("marketplace_version", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", versionId)),
              )
              .find("marketplace_listing_owner", (b) =>
                b.whereIndex("idx_marketplace_listing_owner_listingId_ownerKey", (eb) =>
                  eb("listingId", "=", input.listingId),
                ),
              ),
          )
          .mutate(({ uow, retrieveResult: [listing, existingVersion, owners] }) => {
            if (!listing) {
              throw new MarketplaceListingNotFoundError(slug);
            }
            assertOwnerOwnsListing(owners, input.owner, slug);

            if (existingVersion) {
              return {
                listingId: input.listingId,
                slug,
                version: input.version,
                created: false,
              } satisfies MarketplaceDraftResult;
            }

            const now = uow.now();
            uow.create("marketplace_version", {
              id: versionId,
              listingId: input.listingId,
              version: input.version,
              status: "draft",
              publishedAt: null,
              createdAt: now,
            });
            uow.update("marketplace_listing", listing.id, (b) =>
              b.set({ publisherName: input.owner.publisherName, updatedAt: now }).check(),
            );
            for (const ownership of owners) {
              uow.update("marketplace_listing_owner", ownership.id, (b) =>
                b.set({ listingUpdatedAt: now }).check(),
              );
            }

            return {
              listingId: input.listingId,
              slug,
              version: input.version,
              created: true,
            } satisfies MarketplaceDraftResult;
          })
          .build();
      },

      updateListing: function (rawInput: unknown) {
        const input = marketplaceUpdateListingInputSchema.parse(rawInput);
        const slug = marketplaceListingSlug(input.listingId);

        return this.serviceTx(marketplaceFragmentSchema)
          .retrieve((uow) =>
            uow
              .findFirst("marketplace_listing", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", input.listingId)),
              )
              .find("marketplace_listing_owner", (b) =>
                b.whereIndex("idx_marketplace_listing_owner_listingId_ownerKey", (eb) =>
                  eb("listingId", "=", input.listingId),
                ),
              ),
          )
          .mutate(({ uow, retrieveResult: [listing, owners] }): MarketplaceListingUpdateResult => {
            if (!listing) {
              throw new MarketplaceListingNotFoundError(slug);
            }
            assertOwnerOwnsListing(owners, input.owner, slug);

            const { category, ...metadata } = input.metadata;
            const now = uow.now();
            uow.update("marketplace_listing", listing.id, (b) =>
              b
                .set({
                  metadata,
                  category,
                  publisherName: input.owner.publisherName,
                  updatedAt: now,
                })
                .check(),
            );
            for (const ownership of owners) {
              uow.update("marketplace_listing_owner", ownership.id, (b) =>
                b.set({ listingUpdatedAt: now }).check(),
              );
            }

            return { listingId: input.listingId, slug, ...input.metadata };
          })
          .build();
      },

      publishVersion: function (rawInput: unknown) {
        const input = marketplacePublishVersionInputSchema.parse(rawInput);
        const slug = marketplaceListingSlug(input.listingId);
        const versionId = marketplaceVersionId({
          listingId: input.listingId,
          version: input.version,
        });

        return this.serviceTx(marketplaceFragmentSchema)
          .retrieve((uow) =>
            uow
              .findFirst("marketplace_listing", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", input.listingId)),
              )
              .findFirst("marketplace_version", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", versionId)),
              )
              .find("marketplace_listing_owner", (b) =>
                b.whereIndex("idx_marketplace_listing_owner_listingId_ownerKey", (eb) =>
                  eb("listingId", "=", input.listingId),
                ),
              ),
          )
          .mutate(({ uow, retrieveResult: [listing, version, owners] }) => {
            if (!listing) {
              throw new MarketplaceListingNotFoundError(slug);
            }
            assertOwnerOwnsListing(owners, input.owner, slug);
            if (!version) {
              throw new MarketplaceVersionNotFoundError(slug, input.version);
            }

            if (version.status === "published") {
              if (listing.latestPublishedVersion !== input.version) {
                throw new MarketplaceVersionTransitionError(slug, input.version);
              }
              if (
                input.artifactDirectory &&
                version.artifactDirectory &&
                version.artifactDirectory !== input.artifactDirectory
              ) {
                throw new MarketplaceVersionTransitionError(slug, input.version);
              }

              const attachesArtifact =
                Boolean(input.artifactDirectory) && version.artifactDirectory === null;
              if (listing.status === "published" && !attachesArtifact) {
                return {
                  listingId: input.listingId,
                  slug,
                  version: input.version,
                  published: false,
                } satisfies MarketplacePublishVersionResult;
              }

              const now = uow.now();
              if (attachesArtifact) {
                uow.update("marketplace_version", version.id, (b) =>
                  b.set({ artifactDirectory: input.artifactDirectory ?? null }).check(),
                );
              }
              uow.update("marketplace_listing", listing.id, (b) =>
                b
                  .set({
                    publisherName: input.owner.publisherName,
                    status: "published",
                    updatedAt: now,
                  })
                  .check(),
              );
              for (const ownership of owners) {
                uow.update("marketplace_listing_owner", ownership.id, (b) =>
                  b.set({ listingStatus: "published", listingUpdatedAt: now }).check(),
                );
              }
              return {
                listingId: input.listingId,
                slug,
                version: input.version,
                published: true,
              } satisfies MarketplacePublishVersionResult;
            }

            const now = uow.now();
            uow.update("marketplace_version", version.id, (b) =>
              b
                .set({
                  status: "published",
                  publishedAt: now,
                  artifactDirectory: input.artifactDirectory ?? version.artifactDirectory,
                })
                .check(),
            );
            uow.update("marketplace_listing", listing.id, (b) =>
              b
                .set({
                  publisherName: input.owner.publisherName,
                  status: "published",
                  latestPublishedVersion: input.version,
                  publishedAt: now,
                  updatedAt: now,
                })
                .check(),
            );
            for (const ownership of owners) {
              uow.update("marketplace_listing_owner", ownership.id, (b) =>
                b.set({ listingStatus: "published", listingUpdatedAt: now }).check(),
              );
            }

            return {
              listingId: input.listingId,
              slug,
              version: input.version,
              published: true,
            } satisfies MarketplacePublishVersionResult;
          })
          .build();
      },

      archiveListing: function (rawInput: unknown) {
        const input = marketplaceArchiveListingInputSchema.parse(rawInput);
        const slug = marketplaceListingSlug(input.listingId);

        return this.serviceTx(marketplaceFragmentSchema)
          .retrieve((uow) =>
            uow
              .findFirst("marketplace_listing", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", input.listingId)),
              )
              .find("marketplace_listing_owner", (b) =>
                b.whereIndex("idx_marketplace_listing_owner_listingId_ownerKey", (eb) =>
                  eb("listingId", "=", input.listingId),
                ),
              ),
          )
          .mutate(({ uow, retrieveResult: [listing, owners] }) => {
            if (!listing) {
              throw new MarketplaceListingNotFoundError(slug);
            }
            assertOwnerOwnsListing(owners, input.owner, slug);
            if (listing.status === "archived") {
              return {
                listingId: input.listingId,
                slug,
                archived: false,
              } satisfies MarketplaceArchiveResult;
            }

            const now = uow.now();
            uow.update("marketplace_listing", listing.id, (b) =>
              b.set({ status: "archived", updatedAt: now }).check(),
            );
            for (const ownership of owners) {
              uow.update("marketplace_listing_owner", ownership.id, (b) =>
                b.set({ listingStatus: "archived", listingUpdatedAt: now }).check(),
              );
            }
            return {
              listingId: input.listingId,
              slug,
              archived: true,
            } satisfies MarketplaceArchiveResult;
          })
          .build();
      },
    }),
  )
  .build();
