import { afterAll, assert, describe, expect, test } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import type {
  MarketplaceCreateDraftListingInput,
  MarketplaceListingMetadata,
  MarketplaceOwner,
} from "./contracts";
import { MarketplaceOwnerConflictError, marketplaceFragmentDefinition } from "./definition";
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

  test("keeps drafts private until an explicit version publication", async () => {
    const acme = organizationOwner("org-acme");
    const input = draftInput({ owner: acme });

    await expect(
      callServices(() => marketplace.services.createDraftListing(input)),
    ).resolves.toEqual({ slug: input.slug, version: input.version, created: true });
    await expect(
      callServices(() => marketplace.services.createDraftListing(input)),
    ).resolves.toMatchObject({ created: false });
    await expect(callServices(() => marketplace.services.listPublishedListings())).resolves.toEqual(
      expect.objectContaining({ listings: [] }),
    );

    const owned = await callServices(() =>
      marketplace.services.getOwnedListing({
        slug: input.slug,
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
          slug: input.slug,
          version: input.version,
          owner: acme,
        }),
      ),
    ).resolves.toEqual({ slug: input.slug, version: input.version, published: true });

    await expect(
      callServices(() => marketplace.services.getPublishedListing({ slug: input.slug })),
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
          listingSlug: "daily-operations-brief",
          version: "1.1.0",
          owner: acme,
        }),
      ),
    ).resolves.toEqual({ slug: "daily-operations-brief", version: "1.1.0", created: true });
    await expect(
      callServices(() =>
        marketplace.services.addDraftVersion({
          listingSlug: "daily-operations-brief",
          version: "1.1.0",
          owner: acme,
        }),
      ),
    ).resolves.toMatchObject({ created: false });

    await callServices(() =>
      marketplace.services.publishVersion({
        slug: "daily-operations-brief",
        version: "1.1.0",
        owner: acme,
      }),
    );

    const detail = await callServices(() =>
      marketplace.services.getPublishedListing({ slug: "daily-operations-brief" }),
    );
    assert(detail?.listing.latestVersion === "1.1.0");
    expect(detail.versions.map(({ version }) => version)).toEqual(["1.1.0", "1.0.0"]);
  });

  test("updates metadata, archives a listing, and restores its latest release", async () => {
    const acme = organizationOwner("org-acme");
    await callServices(() =>
      marketplace.services.updateListing({
        slug: "daily-operations-brief",
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
        marketplace.services.archiveListing({ slug: "daily-operations-brief", owner: acme }),
      ),
    ).resolves.toEqual({ slug: "daily-operations-brief", archived: true });
    await expect(
      callServices(() =>
        marketplace.services.getPublishedListing({ slug: "daily-operations-brief" }),
      ),
    ).resolves.toBeNull();

    await expect(
      callServices(() =>
        marketplace.services.publishVersion({
          slug: "daily-operations-brief",
          version: "1.1.0",
          owner: acme,
        }),
      ),
    ).resolves.toMatchObject({ published: true });
  });

  test("supports arbitrary owner scopes and rejects non-owners", async () => {
    const projectOwner: MarketplaceOwner = {
      scope: { kind: "project", orgId: "org-acme", projectId: "project-1" },
      publisherName: "Acme project",
    };
    const input = draftInput({
      owner: projectOwner,
      slug: "project-owned-automation",
      metadata: { name: "Project owned automation" },
    });

    await callServices(() => marketplace.services.createDraftListing(input));
    await expect(
      callServices(() =>
        marketplace.services.getOwnedListing({ slug: input.slug, ownerScope: projectOwner.scope }),
      ),
    ).resolves.toMatchObject({ listing: { slug: input.slug } });
    await expect(
      callServices(() =>
        marketplace.services.findListingOwner({
          slug: input.slug,
          candidateScopes: [{ kind: "org", orgId: "org-acme" }, projectOwner.scope],
        }),
      ),
    ).resolves.toEqual(projectOwner.scope);
    await expect(
      callServices(() =>
        marketplace.services.addDraftVersion({
          listingSlug: input.slug,
          version: "2.0.0",
          owner: organizationOwner("org-acme"),
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
    await callServices(() => marketplace.services.createDraftListing(input));
    await callServices(() =>
      marketplace.services.publishVersion({
        slug: input.slug,
        version: input.version,
        owner,
      }),
    );
    await callServices(() =>
      marketplace.services.addDraftVersion({
        listingSlug: input.slug,
        version: "1.1.0",
        owner,
      }),
    );
    await callServices(() =>
      marketplace.services.publishVersion({ slug: input.slug, version: "1.1.0", owner }),
    );

    const firstPublicPage = await callServices(() =>
      marketplace.services.getPublishedListing({ slug: input.slug, versionPageSize: 1 }),
    );
    expect(firstPublicPage).toMatchObject({
      hasNextVersionPage: true,
      nextVersionCursor: expect.any(String),
    });
    assert(firstPublicPage?.nextVersionCursor);
    const secondPublicPage = await callServices(() =>
      marketplace.services.getPublishedListing({
        slug: input.slug,
        versionCursor: firstPublicPage.nextVersionCursor,
      }),
    );
    expect(secondPublicPage?.versions[0]?.version).not.toBe(firstPublicPage.versions[0]?.version);
    await expect(
      callServices(() =>
        marketplace.services.getPublishedListing({
          slug: "daily-operations-brief",
          versionCursor: firstPublicPage.nextVersionCursor,
        }),
      ),
    ).rejects.toBeInstanceOf(MarketplaceListingCursorError);

    const firstOwnedPage = await callServices(() =>
      marketplace.services.getOwnedListing({
        slug: input.slug,
        ownerScope: owner.scope,
        versionPageSize: 1,
      }),
    );
    expect(firstOwnedPage).toMatchObject({
      hasNextVersionPage: true,
      nextVersionCursor: expect.any(String),
    });
  });

  test("accepts ownership checks across more than one hundred candidate scopes", async () => {
    const candidateScopes = Array.from({ length: 100 }, (_, index) => ({
      kind: "org" as const,
      orgId: `org-candidate-${index}`,
    }));
    candidateScopes.push({ kind: "org", orgId: "org-acme" });

    await expect(
      callServices(() =>
        marketplace.services.findListingOwner({
          slug: "daily-operations-brief",
          candidateScopes,
        }),
      ),
    ).resolves.toEqual({ kind: "org", orgId: "org-acme" });
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
      await callServices(() => marketplace.services.createDraftListing(input));
      await callServices(() =>
        marketplace.services.publishVersion({ slug, version: input.version, owner: beta }),
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
