import { assert, describe, expect, test, vi } from "vitest";

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

import { marketplaceListingId } from "@/fragno/marketplace/owner";

import { defineBackofficeScenario, runBackofficeScenario } from "./scenario";

describe("marketplace scenarios", () => {
  test("pushes bundled marketplace entries idempotently through the internal runtime tool", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "push bundled marketplace entries",

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.codemode.run({
            orgId: "org-1",
            label: "push bundled marketplace entries twice",
            code: `async () => {
  const first = await internal.marketplacePush({});
  const second = await internal.marketplacePush({});
  return { first, second };
}`,
            assertToolCalls: ["internal.marketplace.push"],
          }),

          then.assert("the first push inserts and the second push skips the entry", (ctx) => {
            const result = ctx.codemodeRuns.at(-1)?.result.result as {
              first: {
                inserted: Array<{ slug: string; version: string }>;
                skipped: Array<{ slug: string; version: string }>;
              };
              second: {
                inserted: Array<{ slug: string; version: string }>;
                skipped: Array<{ slug: string; version: string }>;
              };
            };
            const identity = {
              listingId: marketplaceListingId({
                ownerScope: { kind: "system" },
                slug: "telegram-test-command",
              }),
              slug: "telegram-test-command",
              version: "1.0.0",
            };

            expect(result.first).toEqual({ inserted: [identity], skipped: [] });
            expect(result.second).toEqual({ inserted: [], skipped: [identity] });
          }),

          then.assert("the bundled listing is publicly visible", async (ctx) => {
            const detail = await ctx.runtime.objects.marketplace.singleton().getPublishedListing({
              listingId: marketplaceListingId({
                ownerScope: { kind: "system" },
                slug: "telegram-test-command",
              }),
            });

            assert(detail);
            expect(detail.listing).toMatchObject({
              slug: "telegram-test-command",
              publisherName: "Fragno",
              name: "Telegram test command",
              latestVersion: "1.0.0",
              status: "published",
            });
          }),
        ],
      }),
    );
  });

  test("inserts marketplace entries through scenario setup", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "insert scenario marketplace entries",

        setup: ({ given }) => [
          given.marketplace.entries([
            {
              owner: {
                scope: { kind: "system" },
                publisherName: "Scenario publisher",
              },
              slug: "scenario-download-entry",
              version: "2.0.0",
              metadata: {
                name: "Scenario download entry",
                summary: "A marketplace fixture for exercising scenario download behavior.",
                description:
                  "This entry is inserted directly by the scenario runner so download scenarios can attach and retrieve fixture artifacts later.",
                category: "developer-tools",
                tags: ["scenario", "download"],
              },
            },
          ]),
        ],

        steps: ({ then }) => [
          then.assert("the scenario listing is publicly visible", async (ctx) => {
            const detail = await ctx.runtime.objects.marketplace.singleton().getPublishedListing({
              listingId: marketplaceListingId({
                ownerScope: { kind: "system" },
                slug: "scenario-download-entry",
              }),
            });

            assert(detail);
            expect(detail.listing).toMatchObject({
              slug: "scenario-download-entry",
              publisherName: "Scenario publisher",
              latestVersion: "2.0.0",
              status: "published",
            });
          }),
        ],
      }),
    );
  });
});
