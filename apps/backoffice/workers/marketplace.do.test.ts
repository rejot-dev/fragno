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
import { marketplaceListingId } from "@/fragno/marketplace/owner";

let runtime: InMemoryBackofficeRuntime | null = null;

const listingId = marketplaceListingId({
  ownerScope: { kind: "org", orgId: "org-1" },
  slug: "daily-operations-brief",
});

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

    await marketplace.commands.createDraftListing(draftInput);
    await marketplace.commands.publishVersion({
      listingId,
      version: draftInput.version,
      owner: draftInput.owner,
    });

    const browseResponse = await marketplace.http.fetch(
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

    const detailResponse = await marketplace.http.fetch(
      new Request(`https://example.test/api/marketplace/listings/${encodeURIComponent(listingId)}`),
    );
    assert(detailResponse.status === 200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      listing: { listingId, slug: "daily-operations-brief", latestVersion: "1.0.0" },
      versions: [{ version: "1.0.0" }],
    });
  });

  test("runs owner mutations through the explicit RPC interface", async () => {
    runtime = await createInMemoryBackofficeRuntime();
    const marketplace = runtime.objects.marketplace.singleton();
    await runtime.drain();

    await expect(marketplace.commands.createDraftListing(draftInput)).resolves.toEqual({
      ok: true,
      value: {
        listingId,
        slug: "daily-operations-brief",
        version: "1.0.0",
        created: true,
      },
    });
    await expect(marketplace.commands.listPublishedListings()).resolves.toMatchObject({
      listings: [],
    });
    await expect(
      marketplace.commands.listOwnedListings({ ownerScope: draftInput.owner.scope }),
    ).resolves.toMatchObject({
      listings: [expect.objectContaining({ slug: "daily-operations-brief", status: "draft" })],
    });

    await marketplace.commands.publishVersion({
      listingId,
      version: draftInput.version,
      owner: draftInput.owner,
    });
    await expect(marketplace.commands.listPublishedListings()).resolves.toMatchObject({
      listings: [
        expect.objectContaining({
          slug: "daily-operations-brief",
          latestVersion: "1.0.0",
          publisherName: "Acme",
        }),
      ],
      hasNextPage: false,
    });

    await marketplace.commands.archiveListing({
      listingId,
      owner: draftInput.owner,
    });
    await expect(marketplace.commands.getPublishedListing({ listingId })).resolves.toBeNull();
  });

  test("returns domain failures as RPC-safe results", async () => {
    runtime = await createInMemoryBackofficeRuntime();
    const marketplace = runtime.objects.marketplace.singleton();
    await runtime.drain();

    await marketplace.commands.createDraftListing(draftInput);
    await expect(
      marketplace.commands.addDraftVersion({
        listingId,
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
