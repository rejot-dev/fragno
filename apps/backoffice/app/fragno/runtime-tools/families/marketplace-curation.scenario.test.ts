import { assert, describe, expect, test, vi } from "vitest";

import {
  MARKETPLACE_FEATURED_LIMIT,
  marketplaceFeaturedResultSchema,
  type MarketplaceCategory,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));

import {
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { marketplaceListingId } from "@/fragno/marketplace/owner";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { ApiObject } from "../../../../workers/api.do";
import { AuthObject } from "../../../../workers/auth.do";
import { AutomationsObject } from "../../../../workers/automations.do";
import { FormsObject } from "../../../../workers/forms.do";
import { MarketplaceObject } from "../../../../workers/marketplace.do";
import { McpObject } from "../../../../workers/mcp.do";
import { TelegramObject } from "../../../../workers/telegram.do";
import { UploadObject } from "../../../../workers/upload.do";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  FORMS: (input) => new FormsObject(input),
  MARKETPLACE: (input) => new MarketplaceObject(input),
  MCP: (input) => new McpObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const SYSTEM = { kind: "system" } as const;
const ORG_SCOPE = { kind: "org", orgId: "org-1" } as const;
const HOUR_MS = 60 * 60 * 1000;

function entry(slug: string, category: MarketplaceCategory = "reporting") {
  return {
    owner: { scope: { kind: "org", orgId: "org-1" } as const, publisherName: "Ada Labs" },
    slug,
    version: "1.0.0",
    metadata: {
      name: slug
        .split("-")
        .map((word) => word[0].toUpperCase() + word.slice(1))
        .join(" "),
      summary: `The ${slug} package for scenario curation.`,
      description: `The ${slug} package installs a workflow and its supporting skill.`,
      category,
      tags: [],
    },
  };
}

const listingIdOf = (slug: string) =>
  marketplaceListingId({ ownerScope: { kind: "org", orgId: "org-1" }, slug });

const SYSTEM_EXECUTION = createBackofficeSystemExecution(SYSTEM);

const userExecution = (scope: BackofficeContextScope, userId: string) =>
  createBackofficeUserExecution({ scope, userId });

/** Runs a bash command whose curation authority comes from the given execution. */
async function curate(
  ctx: BackofficeScenarioContext,
  execution: BackofficeExecutionContext,
  command: string,
) {
  const context = createRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution,
  });
  assert(context.stateBackend);
  return await (
    await createInteractiveBashHost({
      context: { ...context, stateBackend: context.stateBackend },
    })
  ).bash.exec(`${command} --format json`);
}

async function featuredEntries(
  ctx: BackofficeScenarioContext,
  execution: BackofficeExecutionContext,
) {
  const result = await curate(ctx, execution, "marketplace.featured");
  assert(result.exitCode === 0, result.stderr);
  return marketplaceFeaturedResultSchema.parse(JSON.parse(result.stdout));
}

async function featuredNames(ctx: BackofficeScenarioContext, marketplace: "public" | "org-1") {
  const object =
    marketplace === "public"
      ? ctx.runtime.objects.marketplace.singleton()
      : ctx.runtime.objects.marketplace.forOrg("org-1");
  const { listings } = await object.commands.listFeaturedListings();
  return listings.map(({ listing, note }) => ({ name: listing.name, note }));
}

/** Feature windows are expressed in the scenario's controllable clock. */
const isoFromNow = (ctx: BackofficeScenarioContext, offsetMs: number) =>
  new Date(ctx.runtime.now() + offsetMs).toISOString();

describe("Marketplace curation scenarios", () => {
  test("System administrators curate the public Marketplace and organization admins curate their own", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Featuring is scoped to the Marketplace the curator administers",
        setup: ({ given }) => [
          given.auth.user({ id: "admin-1", role: "admin" }),
          given.auth.user({ id: "user-1" }),
          given.organization.exists({
            id: "org-1",
            slug: "ada-labs",
            name: "Ada Labs",
            ownerUserId: "owner-1",
          }),
          given.auth.user({ id: "member-1" }),
          given.auth.member({ orgId: "org-1", userId: "member-1", roles: ["member"] }),
          given.marketplace.entries([entry("invoice-digest"), entry("telegram-alerts")]),
        ],
        steps: ({ then }) => [
          then.assert("the organization publishes a members-only package", async (ctx) => {
            const result = await ctx.runtime.objects.marketplace
              .forOrg("org-1")
              .commands.insertStaticEntries({ entries: [entry("payroll-sync")] });
            assert(result.ok);
          }),
          then.assert("a System administrator features public listings in order", async (ctx) => {
            for (const command of [
              `admin.marketplace.feature --listing-id '${listingIdOf("telegram-alerts")}'`,
              `admin.marketplace.feature --listing-id '${listingIdOf("invoice-digest")}' --priority 5 --note 'Staff pick'`,
            ]) {
              const result = await curate(ctx, userExecution(SYSTEM, "admin-1"), command);
              assert(result.exitCode === 0, result.stderr);
            }
            expect(await featuredNames(ctx, "public")).toEqual([
              { name: "Invoice Digest", note: "Staff pick" },
              { name: "Telegram Alerts", note: null },
            ]);
            const { listings } = await ctx.runtime.objects.marketplace
              .singleton()
              .commands.listPublishedListings();
            assert(listings.every((listing) => listing.featured));
            expect(
              (await featuredEntries(ctx, userExecution(SYSTEM, "admin-1"))).entries,
            ).toMatchObject([
              {
                listingId: listingIdOf("invoice-digest"),
                state: "active",
                featuredBy: "user:admin-1",
              },
              { listingId: listingIdOf("telegram-alerts"), state: "active", priority: 0 },
            ]);
          }),
          then.assert("users without curation authority are rejected", async (ctx) => {
            const ordinary = await curate(
              ctx,
              userExecution(SYSTEM, "user-1"),
              `admin.marketplace.unfeature --listing-id '${listingIdOf("invoice-digest")}'`,
            );
            assert(ordinary.exitCode !== 0);
            const member = await curate(
              ctx,
              userExecution(ORG_SCOPE, "member-1"),
              `admin.marketplace.feature --listing-id '${listingIdOf("payroll-sync")}'`,
            );
            assert(member.exitCode !== 0);
            expect(await featuredNames(ctx, "public")).toHaveLength(2);
            expect(await featuredNames(ctx, "org-1")).toEqual([]);
          }),
          then.assert(
            "an organization owner features only its own Marketplace's listings",
            async (ctx) => {
              const result = await curate(
                ctx,
                userExecution(ORG_SCOPE, "owner-1"),
                `admin.marketplace.feature --listing-id '${listingIdOf("payroll-sync")}' --note 'Month-end close'`,
              );
              assert(result.exitCode === 0, result.stderr);
              expect(await featuredNames(ctx, "org-1")).toEqual([
                { name: "Payroll Sync", note: "Month-end close" },
              ]);
              // Organization scope never reaches the public Marketplace, even for public listing ids.
              const publicListing = await curate(
                ctx,
                userExecution(ORG_SCOPE, "owner-1"),
                `admin.marketplace.unfeature --listing-id '${listingIdOf("invoice-digest")}'`,
              );
              assert(publicListing.exitCode === 0, publicListing.stderr);
              expect(JSON.parse(publicListing.stdout)).toEqual({
                listingId: listingIdOf("invoice-digest"),
                removed: false,
              });
              expect(await featuredNames(ctx, "public")).toHaveLength(2);
            },
          ),
          then.assert("unfeaturing removes a listing from the featured set", async (ctx) => {
            const result = await curate(
              ctx,
              userExecution(SYSTEM, "admin-1"),
              `admin.marketplace.unfeature --listing-id '${listingIdOf("telegram-alerts")}'`,
            );
            assert(result.exitCode === 0, result.stderr);
            expect(await featuredNames(ctx, "public")).toEqual([
              { name: "Invoice Digest", note: "Staff pick" },
            ]);
          }),
        ],
      }),
    );
  });

  test("feature windows open and close with time, and unpublished listings drop out", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Feature entries follow their schedule and listing lifecycle",
        setup: ({ given }) => [
          given.organization.exists({
            id: "org-1",
            slug: "ada-labs",
            name: "Ada Labs",
            ownerUserId: "owner-1",
          }),
          given.marketplace.entries([
            entry("invoice-digest"),
            entry("telegram-alerts"),
            entry("payroll-sync"),
          ]),
        ],
        steps: ({ then, when }) => [
          then.assert("System schedules one feature and limits another", async (ctx) => {
            for (const command of [
              `admin.marketplace.feature --listing-id '${listingIdOf("invoice-digest")}' --until ${isoFromNow(ctx, HOUR_MS)}`,
              `admin.marketplace.feature --listing-id '${listingIdOf("telegram-alerts")}' --starts-at ${isoFromNow(ctx, 2 * HOUR_MS)}`,
              `admin.marketplace.feature --listing-id '${listingIdOf("payroll-sync")}'`,
            ]) {
              const result = await curate(ctx, SYSTEM_EXECUTION, command);
              assert(result.exitCode === 0, result.stderr);
            }
          }),
          then.assert("only open windows are featured", async (ctx) => {
            expect((await featuredNames(ctx, "public")).map(({ name }) => name)).toEqual([
              "Payroll Sync",
              "Invoice Digest",
            ]);
            expect(
              (await featuredEntries(ctx, SYSTEM_EXECUTION)).entries.map(({ state }) => state),
            ).toEqual(["scheduled", "active", "active"]);
          }),
          when.time.advance(1.5 * HOUR_MS),
          then.assert(
            "the limited feature expires before the scheduled one starts",
            async (ctx) => {
              expect((await featuredNames(ctx, "public")).map(({ name }) => name)).toEqual([
                "Payroll Sync",
              ]);
            },
          ),
          when.time.advance(HOUR_MS),
          then.assert("the scheduled feature opens", async (ctx) => {
            expect((await featuredNames(ctx, "public")).map(({ name }) => name)).toEqual([
              "Telegram Alerts",
              "Payroll Sync",
            ]);
            const { listing } =
              (await ctx.runtime.objects.marketplace
                .singleton()
                .commands.getPublishedListing({ listingId: listingIdOf("telegram-alerts") })) ?? {};
            assert(listing?.featured);
          }),
          then.assert("archived listings are hidden and cannot be featured again", async (ctx) => {
            const archived = await ctx.runtime.objects.marketplace
              .singleton()
              .commands.archiveListing({
                owner: { scope: { kind: "org", orgId: "org-1" }, publisherName: "Ada Labs" },
                listingId: listingIdOf("payroll-sync"),
              });
            assert(archived.ok);
            expect((await featuredNames(ctx, "public")).map(({ name }) => name)).toEqual([
              "Telegram Alerts",
            ]);
            expect(
              (await featuredEntries(ctx, SYSTEM_EXECUTION)).entries.map(({ name, state }) => [
                name,
                state,
              ]),
            ).toEqual([
              ["Telegram Alerts", "active"],
              ["Payroll Sync", "hidden"],
              ["Invoice Digest", "expired"],
            ]);
            const refeature = await ctx.runtime.objects.marketplace
              .singleton()
              .commands.featureListing({
                listingId: listingIdOf("payroll-sync"),
                startsAt: null,
                until: null,
                priority: 0,
                note: null,
                featuredBy: "system",
              });
            expect(refeature).toMatchObject({
              ok: false,
              error: { code: "MARKETPLACE_LISTING_NOT_PUBLISHED" },
            });
          }),
          then.assert("windows that already ended are rejected", async (ctx) => {
            const result = await curate(
              ctx,
              SYSTEM_EXECUTION,
              `admin.marketplace.feature --listing-id '${listingIdOf("invoice-digest")}' --until ${isoFromNow(ctx, -HOUR_MS)}`,
            );
            assert(result.exitCode !== 0);
            expect(result.stderr).toContain("must end after it starts");
          }),
        ],
      }),
    );
  });

  test("a full featured set rejects new entries until expired ones give up their slots", async () => {
    const slugs = Array.from(
      { length: MARKETPLACE_FEATURED_LIMIT + 1 },
      (_, index) => `package-${String(index).padStart(2, "0")}`,
    );
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "The featured set holds at most the limit of entries",
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
          given.marketplace.entries(slugs.map((slug) => entry(slug))),
        ],
        steps: ({ then, when }) => [
          then.assert("System fills every slot, one of them for an hour", async (ctx) => {
            const marketplace = ctx.runtime.objects.marketplace.singleton().commands;
            for (const [index, slug] of slugs.slice(0, MARKETPLACE_FEATURED_LIMIT).entries()) {
              const result = await marketplace.featureListing({
                listingId: listingIdOf(slug),
                startsAt: null,
                until: index === 0 ? new Date(ctx.runtime.now() + HOUR_MS) : null,
                priority: 0,
                note: null,
                featuredBy: "system",
              });
              assert(result.ok, result.ok ? "" : result.error.message);
            }
          }),
          then.assert("another feature is rejected while every slot is in use", async (ctx) => {
            const result = await curate(
              ctx,
              SYSTEM_EXECUTION,
              `admin.marketplace.feature --listing-id '${listingIdOf(slugs[MARKETPLACE_FEATURED_LIMIT])}'`,
            );
            assert(result.exitCode !== 0);
            expect(result.stderr).toContain(`already has ${MARKETPLACE_FEATURED_LIMIT}`);
          }),
          when.time.advance(2 * HOUR_MS),
          then.assert("the expired entry is removed to make room", async (ctx) => {
            const result = await curate(
              ctx,
              SYSTEM_EXECUTION,
              `admin.marketplace.feature --listing-id '${listingIdOf(slugs[MARKETPLACE_FEATURED_LIMIT])}'`,
            );
            assert(result.exitCode === 0, result.stderr);
            const { entries } = await featuredEntries(ctx, SYSTEM_EXECUTION);
            expect(entries).toHaveLength(MARKETPLACE_FEATURED_LIMIT);
            expect(entries.map(({ listingId }) => listingId)).not.toContain(listingIdOf(slugs[0]));
          }),
        ],
      }),
    );
  });
});
