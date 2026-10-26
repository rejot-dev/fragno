import { assert, describe, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { matchRoutes, type RouteObject } from "react-router";

import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import { marketplaceListingId } from "@/fragno/marketplace/owner";
import routes from "@/routes";

import { ApiObject } from "../../../../workers/api-object";
import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
import { FormsObject } from "../../../../workers/forms-object";
import { MarketplaceObject } from "../../../../workers/marketplace-object";
import { OtpObject } from "../../../../workers/otp-object";
import { TelegramObject } from "../../../../workers/telegram-object";
import { UploadObject } from "../../../../workers/upload-object";
import { loadMarketplaceListingRefs, resolveMarketplaceListingRoute } from "./listing-route.server";
import { marketplaceListingManagePath, marketplaceListingPath } from "./navigation";

const objects = {
  API: (input) => new ApiObject(input),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  UPLOAD: (input) => new UploadObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  MARKETPLACE: (input) => new MarketplaceObject(input),
  FORMS: (input) => new FormsObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  OTP: (input) => new OtpObject(input),
} satisfies LocalBackofficeObjects;

function routeParams(path: string) {
  const matches = matchRoutes(routes as RouteObject[], path);
  const match = matches?.at(-1);
  assert(match);
  return match.params;
}

describe("Marketplace listing navigation scenarios", () => {
  test("scoped slugs resolve the publisher independently of the browsing workspace", async () => {
    const publisherId = "engineering/platform";
    const slug = "daily-operations-brief";
    const listingId = marketplaceListingId({
      ownerScope: { kind: "org", orgId: publisherId },
      slug,
    });
    const systemListingId = marketplaceListingId({ ownerScope: { kind: "system" }, slug });
    const systemOrganizationListingId = marketplaceListingId({
      ownerScope: { kind: "org", orgId: "org-system" },
      slug,
    });
    const scope = {
      kind: "org",
      organization: { id: "reader-org", slug: "reader" },
      label: "Reader",
    } as const;

    await runBackofficeScenario(
      defineBackofficeScenario({
        objects,
        name: "Readable package routes retain owner-qualified identity",
        setup: ({ given }) => [
          given.organization.exists({ id: publisherId, slug: "acme", name: "Acme" }),
          given.organization.exists({
            id: "org-system",
            slug: "system",
            name: "System Organization",
          }),
          given.organization.exists({ id: "reader-org", slug: "reader", name: "Reader" }),
          given.marketplace.entries([
            {
              owner: { scope: { kind: "org", orgId: publisherId }, publisherName: "Acme" },
              slug,
              version: "1.0.0",
              metadata: {
                name: "Daily operations brief",
                summary: "A daily operations briefing for the team.",
                description:
                  "A published package that prepares the team's daily operations briefing.",
                category: "reporting",
                tags: [],
              },
            },
            {
              owner: { scope: { kind: "system" }, publisherName: "Fragno" },
              slug,
              version: "1.0.0",
              metadata: {
                name: "Bundled operations brief",
                summary: "A bundled daily operations briefing.",
                description:
                  "A bundled package that prepares the team's daily operations briefing.",
                category: "reporting",
                tags: [],
              },
            },
            {
              owner: {
                scope: { kind: "org", orgId: "org-system" },
                publisherName: "System Organization",
              },
              slug,
              version: "1.0.0",
              metadata: {
                name: "Organization operations brief",
                summary: "An organization daily operations briefing.",
                description:
                  "An organization package that prepares the team's daily operations briefing.",
                category: "reporting",
                tags: [],
              },
            },
          ]),
        ],
        steps: ({ then }) => [
          then.assert(
            "catalog links use publisher slugs, including publishers with slash-containing IDs",
            async (ctx) => {
              const { listings } = await ctx.runtime.objects.marketplace
                .singleton()
                .commands.listPublishedListings({});
              const refs = await loadMarketplaceListingRefs(
                ctx.runtime.objects,
                listings.map((listing) => listing.listingId),
              );
              expect(refs).toEqual({
                [listingId]: "@acme/daily-operations-brief",
                [systemListingId]: "system/daily-operations-brief",
                [systemOrganizationListingId]: "@system/daily-operations-brief",
              });
              for (const listing of listings) {
                const ref = refs[listing.listingId];
                const publicPath = `/marketplace/${ref}`;
                const catalogPath = marketplaceListingPath(ref, scope, "marketplace");
                expect(catalogPath).toBe(`/backoffice/marketplace/org/reader/marketplace/${ref}`);
                for (const path of [publicPath, catalogPath, `${catalogPath}/package-file`]) {
                  const resolved = await resolveMarketplaceListingRoute(
                    ctx.runtime.objects,
                    routeParams(path),
                  );
                  expect(resolved).toEqual({ listingId: listing.listingId, listingRef: ref });
                  const detail = await ctx.runtime.objects.marketplace
                    .singleton()
                    .commands.getPublishedListing({ listingId: resolved.listingId });
                  expect(detail?.listing.name).toBe(listing.name);
                }
              }
            },
          ),
          then.assert(
            "management links use the same scoped name and retain visibility and result parameters",
            async (ctx) => {
              const path = marketplaceListingManagePath({
                listingId,
                organizationSlug: "acme",
                visibility: "organization",
                result: { created: "1.0.0" },
              });
              expect(path).toBe(
                "/backoffice/marketplace/@acme/daily-operations-brief/manage?visibility=organization&created=1.0.0",
              );
              expect(
                await resolveMarketplaceListingRoute(ctx.runtime.objects, routeParams(path)),
              ).toEqual({ listingId, listingRef: "@acme/daily-operations-brief" });
            },
          ),
          then.assert(
            "unknown publishers and malformed routes are not interpreted as internal IDs",
            async (ctx) => {
              for (const params of [
                { publisher: "@missing", packageSlug: slug },
                { publisher: "org:engineering%2Fplatform", packageSlug: slug },
                { publisher: "@acme", packageSlug: "../daily-operations-brief" },
                { publisher: "@acme/other", packageSlug: slug },
              ]) {
                await expect(
                  resolveMarketplaceListingRoute(ctx.runtime.objects, params),
                ).rejects.toMatchObject({ status: 404 });
              }
            },
          ),
        ],
      }),
    );
  });
});
