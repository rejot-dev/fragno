import { afterEach, assert, describe, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  class MockRpcTarget {}
  class MockWorkerEntrypoint {}

  return {
    DurableObject: MockDurableObject,
    RpcTarget: MockRpcTarget,
    WorkerEntrypoint: MockWorkerEntrypoint,
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import type { InMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import type { MarketplaceCreateDraftListingInput } from "@/fragno/marketplace/contracts";

let runtime: InMemoryBackofficeRuntime | null = null;

const draftInput: MarketplaceCreateDraftListingInput = {
  owner: {
    scope: { kind: "org", orgId: "org-1" },
    publisherName: "Acme",
  },
  slug: "daily-operations-brief",
  version: "1.0.0",
  metadata: {
    name: "Daily operations brief",
    summary: "Build and deliver a concise daily operations report.",
    description:
      "Collects operational events and produces a daily report for the configured channel.",
    category: "operations",
    tags: ["reporting"],
  },
};

afterEach(async () => {
  await runtime?.cleanup();
  runtime = null;
});

describe("Marketplace Durable Object", () => {
  test("serves the public metadata routes through the production object host", async () => {
    runtime = await createInMemoryBackofficeRuntime();
    const marketplace = runtime.objects.marketplace.singleton();
    await runtime.drain();

    await marketplace.createDraftListing(draftInput);
    await marketplace.publishVersion({
      slug: draftInput.slug,
      version: draftInput.version,
      owner: draftInput.owner,
    });

    const browseResponse = await marketplace.fetch(
      new Request("https://example.test/api/marketplace/listings"),
    );
    assert(browseResponse.status === 200);
    await expect(browseResponse.json()).resolves.toMatchObject({
      listings: [
        expect.objectContaining({
          slug: "daily-operations-brief",
          summary: "Build and deliver a concise daily operations report.",
        }),
      ],
    });

    const detailResponse = await marketplace.fetch(
      new Request("https://example.test/api/marketplace/listings/daily-operations-brief"),
    );
    assert(detailResponse.status === 200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      listing: { slug: "daily-operations-brief", latestVersion: "1.0.0" },
      versions: [{ version: "1.0.0" }],
    });
  });

  test("runs owner mutations through the explicit RPC interface", async () => {
    runtime = await createInMemoryBackofficeRuntime();
    const marketplace = runtime.objects.marketplace.singleton();
    await runtime.drain();

    await expect(marketplace.createDraftListing(draftInput)).resolves.toEqual({
      ok: true,
      value: {
        slug: "daily-operations-brief",
        version: "1.0.0",
        created: true,
      },
    });
    await expect(marketplace.listPublishedListings()).resolves.toMatchObject({ listings: [] });
    await expect(
      marketplace.listOwnedListings({ ownerScope: draftInput.owner.scope }),
    ).resolves.toMatchObject({
      listings: [expect.objectContaining({ slug: "daily-operations-brief", status: "draft" })],
    });

    await marketplace.publishVersion({
      slug: draftInput.slug,
      version: draftInput.version,
      owner: draftInput.owner,
    });
    await expect(marketplace.listPublishedListings()).resolves.toMatchObject({
      listings: [
        expect.objectContaining({
          slug: "daily-operations-brief",
          latestVersion: "1.0.0",
          publisherName: "Acme",
        }),
      ],
      hasNextPage: false,
    });

    await marketplace.archiveListing({
      slug: draftInput.slug,
      owner: draftInput.owner,
    });
    await expect(marketplace.getPublishedListing({ slug: draftInput.slug })).resolves.toBeNull();
  });

  test("returns domain failures as RPC-safe results", async () => {
    runtime = await createInMemoryBackofficeRuntime();
    const marketplace = runtime.objects.marketplace.singleton();
    await runtime.drain();

    await marketplace.createDraftListing(draftInput);
    await expect(
      marketplace.addDraftVersion({
        listingSlug: draftInput.slug,
        version: "2.0.0",
        owner: {
          scope: { kind: "org", orgId: "org-other" },
          publisherName: "Other",
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "MARKETPLACE_OWNER_CONFLICT",
        message: "Marketplace listing daily-operations-brief has a different owner.",
      },
    });
  });
});
