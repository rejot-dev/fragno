import { assert, describe, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import {
  marketplaceListingDetailSchema,
  type MarketplaceStaticEntry,
} from "@/fragno/marketplace/contracts";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { InMemoryApiObject } from "../../../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../../workers/forms.do";
import { InMemoryMarketplaceObject } from "../../../../workers/marketplace.do";
import { InMemoryMcpObject } from "../../../../workers/mcp.do";
import { InMemoryResendObject } from "../../../../workers/resend.do";
import { InMemoryTelegramObject } from "../../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../../workers/upload.do";
import { marketplaceSearchResultSchema } from "./marketplace-runtime";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  MARKETPLACE: (input) => new InMemoryMarketplaceObject(input),
  MCP: (input) => new InMemoryMcpObject(input),
  RESEND: (input) => new InMemoryResendObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const OWNER = { scope: { kind: "system" }, publisherName: "Fragno" } as const;
const REPORT: MarketplaceStaticEntry = {
  owner: OWNER,
  slug: "finance-report",
  version: "1.0.0",
  metadata: {
    name: "Daily finance brief",
    summary: "Collect finance events and produce a daily report.",
    description: "Prepare an account overview and send the report to the configured channel.",
    category: "reporting",
    tags: ["scheduled", "accounting"],
  },
};
const OTHER: MarketplaceStaticEntry = {
  ...REPORT,
  slug: "another-package",
  metadata: {
    ...REPORT.metadata,
    name: "Inventory snapshot",
    summary: "Generate an inventory snapshot from warehouse events.",
    description: "Observe stock levels and notify the operations team about changes.",
    category: "operations",
    tags: ["warehouse"],
  },
};

describe("Marketplace discovery runtime scenarios", () => {
  test("codemode searches published metadata across candidate pages and inspects releases", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Discover published packages through the runtime catalog",
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.marketplace.entries([REPORT, OTHER]),
        ],
        steps: ({ then }) => [
          then.assert(
            "search does not expose drafts and cursors do not skip metadata matches",
            async (ctx) => {
              await ctx.runtime.objects.marketplace
                .singleton()
                .commands.createDraftListing({ ...REPORT, slug: "finance-draft" });
              const found: string[] = [];
              let cursor: string | null = null;
              let emptyCandidatePage = false;
              do {
                const run = await ctx.runCodemode({
                  scope: { kind: "org", orgId: "org-1" },
                  code: `async () => await marketplace.search(${JSON.stringify({ query: "ACCOUNTING daily", pageSize: 1, ...(cursor ? { cursor } : {}) })})`,
                  assertToolCalls: ["marketplace.search"],
                });
                const page = marketplaceSearchResultSchema.parse(run.result);
                found.push(...page.listings.map((listing) => listing.listingId));
                emptyCandidatePage ||= page.listings.length === 0;
                cursor = page.hasNextPage ? page.nextCursor : null;
              } while (cursor);
              expect(found).toEqual(["system#finance-report"]);
              assert(emptyCandidatePage);

              await ctx.runtime.objects.marketplace
                .singleton()
                .commands.insertStaticEntries({ entries: [{ ...REPORT, version: "1.1.0" }] });
              const run = await ctx.runCodemode({
                scope: { kind: "user", userId: "reader-1" },
                code: 'async () => await marketplace.view({ listingId: "system#finance-report", versionPageSize: 1 })',
                assertToolCalls: ["marketplace.view"],
              });
              const detail = marketplaceListingDetailSchema.parse(run.result);
              expect(detail).toMatchObject({
                listing: { name: REPORT.metadata.name, latestVersion: "1.1.0" },
                versions: [{ version: "1.1.0" }],
                hasNextVersionPage: true,
              });
              assert(detail.nextVersionCursor);
              const next = await ctx.runCodemode({
                scope: { kind: "org", orgId: "org-1" },
                code: `async () => await marketplace.view(${JSON.stringify({ listingId: "system#finance-report", versionCursor: detail.nextVersionCursor })})`,
              });
              expect(next.result).toMatchObject({
                versions: [{ version: "1.0.0" }],
                hasNextVersionPage: false,
              });
              await expect(
                ctx.runCodemode({
                  scope: { kind: "org", orgId: "org-1" },
                  code: 'async () => await marketplace.view({ listingId: "system#finance-draft" })',
                }),
              ).rejects.toThrow("was not found");
              await expect(
                ctx.runCodemode({
                  scope: { kind: "org", orgId: "org-1" },
                  code: 'async () => await marketplace.search({ query: "finance", cursor: "invalid" })',
                }),
              ).rejects.toThrow("cursor is invalid");
            },
          ),
        ],
      }),
    );
  });

  test("terminal commands expose metadata, categories, cursors, help and JSON selectors", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Marketplace discovery through generated terminal commands",
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.marketplace.entries([REPORT, OTHER]),
        ],
        steps: ({ then }) => [
          then.assert("terminal discovery shares registry data with codemode", async (ctx) => {
            const { bash } = createInteractiveBashHost({
              context: createCodemodeRouteBackedRuntimeContext({
                runtime: ctx.runtime.services,
                kernel: new BackofficeKernel(ctx.runtime.services),
                execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                billingOrganizationId: null,
              }),
            });
            const search = await bash.exec(
              "marketplace.search --query finance --category reporting --format json",
            );
            assert(search.exitCode === 0, search.stderr);
            expect(JSON.parse(search.stdout)).toMatchObject({
              listings: [{ listingId: "system#finance-report", tags: ["scheduled", "accounting"] }],
              hasNextPage: false,
            });
            const text = await bash.exec("marketplace.search --query finance");
            expect(text.stdout).toContain("system#finance-report@1.0.0");
            const view = await bash.exec("marketplace.view --listing-id 'system#finance-report'");
            expect(view.stdout).toContain(REPORT.metadata.description);
            const version = await bash.exec(
              "marketplace.view --listing-id 'system#finance-report' --print listing.latest-version",
            );
            assert(version.stdout === "1.0.0\n", version.stdout);
            const help = await bash.exec("marketplace.search --help");
            expect(help.stdout).toContain("candidate cursor");
            const invalid = await bash.exec("marketplace.search --query finance --page-size 61");
            expect(invalid.exitCode).not.toBe(0);
            const unknown = await bash.exec(
              "marketplace.view --listing-id 'system#finance-report' --force",
            );
            expect(unknown.exitCode).not.toBe(0);
          }),
        ],
      }),
    );
  });
});
