import { afterAll, assert, describe, expect, test } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import type {
  MarketplaceCreateDraftListingInput,
  MarketplaceListingMetadata,
  MarketplaceOwner,
} from "./contracts";
import {
  MarketplaceOwnerConflictError,
  marketplaceFragmentDefinition,
  MarketplaceVersionTransitionError,
} from "./definition";
import { marketplaceListingId } from "./owner";
import { MarketplaceListingCursorError } from "./pagination";

const organizationOwner = (orgId: string): MarketplaceOwner => ({
  scope: { kind: "org", orgId },
  publisherName: orgId === "org-acme" ? "Acme" : orgId,
});

const listingMetadata = (
  overrides: Partial<MarketplaceListingMetadata> = {},
): MarketplaceListingMetadata => ({
  name: "Daily operations brief",
  summary: "Build and deliver a concise daily operations report.",
  description:
    "Collects operational events and produces a daily report for the configured channel.",
  category: "operations",
  tags: ["reporting", "scheduled"],
  ...overrides,
});

const dailyOperationsListingId = marketplaceListingId({
  ownerScope: { kind: "org", orgId: "org-acme" },
  slug: "daily-operations-brief",
});

const draftInput = (input: {
  owner: MarketplaceOwner;
  slug?: string;
  version?: string;
  metadata?: Partial<MarketplaceListingMetadata>;
}): MarketplaceCreateDraftListingInput => ({
  owner: input.owner,
  slug: input.slug ?? "daily-operations-brief",
  version: input.version ?? "1.0.0",
  metadata: listingMetadata(input.metadata),
});

describe("marketplace fragment", async () => {
  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "marketplace",
      instantiate(marketplaceFragmentDefinition).withConfig({}).withRoutes([]),
    )
    .build();

  const marketplace = fragments.marketplace;
  const callServices = marketplace.fragment.callServices.bind(marketplace.fragment);

  afterAll(async () => {
    await testContext.cleanup();
  });

  test("inserts only missing static marketplace entries", async () => {
    const owner: MarketplaceOwner = {
      scope: { kind: "system" },
      publisherName: "Fragno",
    };
    const entry = draftInput({
      owner,
      slug: "static-operations-brief",
      version: "1.0.0",
    });
    const listingId = marketplaceListingId({ ownerScope: owner.scope, slug: entry.slug });

    await expect(
      callServices(() => marketplace.services.insertStaticEntries({ entries: [entry] })),
    ).resolves.toEqual({
      inserted: [{ listingId, slug: entry.slug, version: entry.version }],
      skipped: [],
    });
    await expect(
      callServices(() => marketplace.services.insertStaticEntries({ entries: [entry] })),
    ).resolves.toEqual({
      inserted: [],
      skipped: [{ listingId, slug: entry.slug, version: entry.version }],
    });

    const newestEntry = { ...entry, version: "2.0.0" };
    await expect(
      callServices(() => marketplace.services.insertStaticEntries({ entries: [newestEntry] })),
    ).resolves.toEqual({
      inserted: [{ listingId, slug: entry.slug, version: newestEntry.version }],
      skipped: [],
    });
    await expect(
      callServices(() => marketplace.services.getPublishedListing({ listingId })),
    ).resolves.toMatchObject({
      listing: { latestVersion: "2.0.0", status: "published" },
      versions: [
        { version: "2.0.0", publishedAt: expect.any(String) },
        { version: "1.0.0", publishedAt: expect.any(String) },
      ],
    });
  });

  test("rejects static entries that collide with unpublished versions", async () => {
    const owner: MarketplaceOwner = {
      scope: { kind: "system" },
      publisherName: "Fragno",
    };
    const entry = draftInput({
      owner,
      slug: "draft-static-operations-brief",
      version: "1.0.0",
    });
    const listingId = marketplaceListingId({ ownerScope: owner.scope, slug: entry.slug });

    await callServices(() => marketplace.services.createDraftListing(entry));
    await expect(
      callServices(() => marketplace.services.insertStaticEntries({ entries: [entry] })),
    ).rejects.toBeInstanceOf(MarketplaceVersionTransitionError);
    await expect(
      callServices(() => marketplace.services.getPublishedListing({ listingId })),
    ).resolves.toBeNull();
  });

  test("rejects owner-qualified identities that exceed the database id limit", async () => {
    const owner = organizationOwner("x".repeat(100));
    const input = draftInput({ owner, slug: "long-owner-listing" });

    await expect(
      callServices(() => marketplace.services.createDraftListing(input)),
    ).rejects.toThrow("longer than 128 characters");
  });

  test("keeps drafts private until an explicit version publication", async () => {
    const acme = organizationOwner("org-acme");
    const input = draftInput({ owner: acme });

    await expect(
      callServices(() => marketplace.services.createDraftListing(input)),
    ).resolves.toEqual({
      listingId: dailyOperationsListingId,
      slug: input.slug,
      version: input.version,
      created: true,
    });
    await expect(
      callServices(() => marketplace.services.createDraftListing(input)),
    ).resolves.toMatchObject({ created: false });
    const publishedBeforeRelease = await callServices(() =>
      marketplace.services.listPublishedListings(),
    );
    assert(!publishedBeforeRelease.listings.some((listing) => listing.slug === input.slug));

    const owned = await callServices(() =>
      marketplace.services.getOwnedListing({
        listingId: dailyOperationsListingId,
        ownerScope: acme.scope,
      }),
    );
    expect(owned).toMatchObject({
      listing: {
        status: "draft",
        latestPublishedVersion: null,
        summary: input.metadata.summary,
      },
      versions: [{ version: "1.0.0", status: "draft", publishedAt: null }],
    });

    await expect(
      callServices(() =>
        marketplace.services.publishVersion({
          listingId: dailyOperationsListingId,
          version: input.version,
          owner: acme,
        }),
      ),
    ).resolves.toEqual({
      listingId: dailyOperationsListingId,
      slug: input.slug,
      version: input.version,
      published: true,
    });

    await expect(
      callServices(() =>
        marketplace.services.getPublishedListing({ listingId: dailyOperationsListingId }),
      ),
    ).resolves.toMatchObject({
      listing: {
        status: "published",
        latestVersion: "1.0.0",
        publisherName: "Acme",
        description: input.metadata.description,
      },
      versions: [{ version: "1.0.0" }],
    });
  });

  test("adds draft versions and promotes one to the latest release", async () => {
    const acme = organizationOwner("org-acme");

    await expect(
      callServices(() =>
        marketplace.services.addDraftVersion({
          listingId: dailyOperationsListingId,
          version: "1.1.0",
          owner: acme,
        }),
      ),
    ).resolves.toEqual({
      listingId: dailyOperationsListingId,
      slug: "daily-operations-brief",
      version: "1.1.0",
      created: true,
    });
    await expect(
      callServices(() =>
        marketplace.services.addDraftVersion({
          listingId: dailyOperationsListingId,
          version: "1.1.0",
          owner: acme,
        }),
      ),
    ).resolves.toMatchObject({ created: false });

    await callServices(() =>
      marketplace.services.publishVersion({
        listingId: dailyOperationsListingId,
        version: "1.1.0",
        owner: acme,
      }),
    );

    const detail = await callServices(() =>
      marketplace.services.getPublishedListing({ listingId: dailyOperationsListingId }),
    );
    assert(detail?.listing.latestVersion === "1.1.0");
    expect(detail.versions.map(({ version }) => version)).toEqual(["1.1.0", "1.0.0"]);
  });

  test("updates metadata, archives a listing, and restores its latest release", async () => {
    const acme = organizationOwner("org-acme");
    await callServices(() =>
      marketplace.services.updateListing({
        listingId: dailyOperationsListingId,
        owner: acme,
        metadata: listingMetadata({
          name: "Operations briefing",
          summary: "Prepare and deliver a concise daily operations briefing.",
          category: "reporting",
          tags: ["daily"],
        }),
      }),
    );
    await expect(
      callServices(() =>
        marketplace.services.archiveListing({
          listingId: dailyOperationsListingId,
          owner: acme,
        }),
      ),
    ).resolves.toEqual({
      listingId: dailyOperationsListingId,
      slug: "daily-operations-brief",
      archived: true,
    });
    await expect(
      callServices(() =>
        marketplace.services.getPublishedListing({ listingId: dailyOperationsListingId }),
      ),
    ).resolves.toBeNull();

    await expect(
      callServices(() =>
        marketplace.services.publishVersion({
          listingId: dailyOperationsListingId,
          version: "1.1.0",
          owner: acme,
        }),
      ),
    ).resolves.toMatchObject({ published: true });
  });

  test("scopes listing identities to owners and rejects non-owners", async () => {
    const organization = organizationOwner("org-identity");
    const projectOwner: MarketplaceOwner = {
      scope: { kind: "project", orgId: "org-identity", projectId: "project-1" },
      publisherName: "Identity project",
    };
    const slug = "owner-scoped-automation";
    const organizationInput = draftInput({
      owner: organization,
      slug,
      metadata: { name: "Organization automation" },
    });
    const projectInput = draftInput({
      owner: projectOwner,
      slug,
      metadata: { name: "Project automation" },
    });
    const organizationListingId = marketplaceListingId({
      ownerScope: organization.scope,
      slug,
    });
    const projectListingId = marketplaceListingId({
      ownerScope: projectOwner.scope,
      slug,
    });

    await expect(
      callServices(() => marketplace.services.createDraftListing(organizationInput)),
    ).resolves.toMatchObject({ listingId: organizationListingId, created: true });
    await expect(
      callServices(() => marketplace.services.createDraftListing(projectInput)),
    ).resolves.toMatchObject({ listingId: projectListingId, created: true });
    await expect(
      callServices(() =>
        marketplace.services.getOwnedListing({
          listingId: projectListingId,
          ownerScope: projectOwner.scope,
        }),
      ),
    ).resolves.toMatchObject({ listing: { listingId: projectListingId, slug } });
    await expect(
      callServices(() =>
        marketplace.services.addDraftVersion({
          listingId: projectListingId,
          version: "2.0.0",
          owner: organization,
        }),
      ),
    ).rejects.toBeInstanceOf(MarketplaceOwnerConflictError);
  });

  test("cursor-paginates public and owned version histories", async () => {
    const owner = organizationOwner("org-history");
    const input = draftInput({
      owner,
      slug: "version-history-example",
      metadata: { name: "Version history example" },
    });
    const listingId = marketplaceListingId({ ownerScope: owner.scope, slug: input.slug });
    await callServices(() => marketplace.services.createDraftListing(input));
    await callServices(() =>
      marketplace.services.publishVersion({
        listingId,
        version: input.version,
        owner,
      }),
    );
    await callServices(() =>
      marketplace.services.addDraftVersion({
        listingId,
        version: "1.1.0",
        owner,
      }),
    );
    await callServices(() =>
      marketplace.services.publishVersion({ listingId, version: "1.1.0", owner }),
    );

    const firstPublicPage = await callServices(() =>
      marketplace.services.getPublishedListing({ listingId, versionPageSize: 1 }),
    );
    expect(firstPublicPage).toMatchObject({
      hasNextVersionPage: true,
      nextVersionCursor: expect.any(String),
    });
    assert(firstPublicPage?.nextVersionCursor);
    const secondPublicPage = await callServices(() =>
      marketplace.services.getPublishedListing({
        listingId,
        versionCursor: firstPublicPage.nextVersionCursor,
      }),
    );
    expect(secondPublicPage?.versions[0]?.version).not.toBe(firstPublicPage.versions[0]?.version);
    await expect(
      callServices(() =>
        marketplace.services.getPublishedListing({
          listingId: dailyOperationsListingId,
          versionCursor: firstPublicPage.nextVersionCursor,
        }),
      ),
    ).rejects.toBeInstanceOf(MarketplaceListingCursorError);

    const firstOwnedPage = await callServices(() =>
      marketplace.services.getOwnedListing({
        listingId,
        ownerScope: owner.scope,
        versionPageSize: 1,
      }),
    );
    expect(firstOwnedPage).toMatchObject({
      hasNextVersionPage: true,
      nextVersionCursor: expect.any(String),
    });
  });

  test("filters and cursor-paginates public and owner listing views", async () => {
    const beta = organizationOwner("org-beta");
    for (const [slug, category] of [
      ["telegram-inbox-triage", "communication"],
      ["weekly-report-builder", "reporting"],
    ] as const) {
      const input = draftInput({
        owner: beta,
        slug,
        metadata: {
          name:
            slug === "telegram-inbox-triage" ? "Telegram inbox triage" : "Weekly report builder",
          summary:
            slug === "telegram-inbox-triage"
              ? "Classify incoming Telegram messages and route urgent conversations."
              : "Collect operational metrics and prepare a weekly reporting package.",
          category,
        },
      });
      const listingId = marketplaceListingId({ ownerScope: beta.scope, slug });
      await callServices(() => marketplace.services.createDraftListing(input));
      await callServices(() =>
        marketplace.services.publishVersion({ listingId, version: input.version, owner: beta }),
      );
    }

    const communication = await callServices(() =>
      marketplace.services.listPublishedListings({ category: "communication" }),
    );
    expect(communication.listings.map(({ slug }) => slug)).toEqual(["telegram-inbox-triage"]);

    const firstOwnedPage = await callServices(() =>
      marketplace.services.listOwnedListings({ ownerScope: beta.scope, pageSize: 1 }),
    );
    expect(firstOwnedPage).toMatchObject({ hasNextPage: true, nextCursor: expect.any(String) });
    const secondOwnedPage = await callServices(() =>
      marketplace.services.listOwnedListings({
        ownerScope: beta.scope,
        cursor: firstOwnedPage.nextCursor,
      }),
    );
    expect(secondOwnedPage.listings[0]?.slug).not.toBe(firstOwnedPage.listings[0]?.slug);

    await expect(
      callServices(() =>
        marketplace.services.listOwnedListings({
          ownerScope: { kind: "org", orgId: "org-other" },
          cursor: firstOwnedPage.nextCursor,
        }),
      ),
    ).rejects.toBeInstanceOf(MarketplaceListingCursorError);
  });
});
