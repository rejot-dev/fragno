import { assert, describe, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import type {
  MarketplaceCategory,
  MarketplaceOwner,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { z } from "zod";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { marketplaceListingId } from "@/fragno/marketplace/owner";
import { behindBackofficeLayout } from "@/layouts/backoffice-layout.test-support";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { InMemoryApiObject } from "../../../workers/api.do";
import { InMemoryAuthObject } from "../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../workers/forms.do";
import { InMemoryMarketplaceObject } from "../../../workers/marketplace.do";
import { InMemoryOtpObject } from "../../../workers/otp.do";
import { InMemoryTelegramObject } from "../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import { buildBackofficeLoginPath } from "../backoffice/auth-navigation";
import { loader as browseLoaderRaw } from "../backoffice/marketplace/browse";
import { loader as browseAllLoader } from "../backoffice/marketplace/browse-all";
import { loader as detailLoader } from "../backoffice/marketplace/detail";
import { loader as marketplaceIndexLoader } from "../backoffice/marketplace/index";
import {
  loader as manageLoaderRaw,
  action as manageActionRaw,
} from "../backoffice/marketplace/manage";
import { marketplaceInstallEntryPath } from "../backoffice/marketplace/navigation";
import { loadMarketplacePackageFile as packageFileLoader } from "../backoffice/marketplace/package-file.server";
import { loader as scopeLayoutLoaderRaw } from "../backoffice/marketplace/scope-layout";
import { loader as browseLoader } from "./index";
import { loader as listingLoader } from "./listing";

const loadMarketplacePackageFile = behindBackofficeLayout(packageFileLoader);
const catalogFeaturedLoader = behindBackofficeLayout(browseLoaderRaw);
const catalogAllLoader = behindBackofficeLayout(browseAllLoader);
const catalogListingLoader = behindBackofficeLayout(detailLoader);
const backofficeMarketplaceLoader = behindBackofficeLayout(marketplaceIndexLoader);
const manageLoader = behindBackofficeLayout(manageLoaderRaw);
const manageAction = behindBackofficeLayout(manageActionRaw);
const scopeLayoutLoader = behindBackofficeLayout(scopeLayoutLoaderRaw);

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  MARKETPLACE: (input) => new InMemoryMarketplaceObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const ORG_ID = "org-1";

function entry(input: {
  slug: string;
  name: string;
  summary: string;
  category: MarketplaceCategory;
  tags: string[];
}) {
  return {
    owner: { scope: { kind: "org", orgId: ORG_ID } as const, publisherName: "Ada Labs" },
    slug: input.slug,
    version: "1.0.0",
    metadata: {
      name: input.name,
      summary: input.summary,
      description: `${input.summary} Installs a workflow and its supporting skill.`,
      category: input.category,
      tags: input.tags,
    },
  };
}

const INVOICE_DIGEST = entry({
  slug: "invoice-digest",
  name: "Invoice digest",
  summary: "Summarizes open invoices every morning.",
  category: "reporting",
  tags: ["finance"],
});
const TELEGRAM_ALERTS = entry({
  slug: "telegram-alerts",
  name: "Telegram alerts",
  summary: "Forwards urgent incidents to a Telegram channel.",
  category: "communication",
  tags: ["incidents"],
});
const PAYROLL_SYNC = entry({
  slug: "payroll-sync",
  name: "Payroll sync",
  summary: "Reconciles payroll exports with the ledger.",
  category: "operations",
  tags: ["finance"],
});
const listingIdOf = (value: { owner: MarketplaceOwner; slug: string }) =>
  marketplaceListingId({ ownerScope: value.owner.scope, slug: value.slug });

function routeContext(ctx: BackofficeScenarioContext, request: Request) {
  return createBackofficeRouterContextProvider(request, {
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
}

async function browse(ctx: BackofficeScenarioContext, search: string) {
  const url = new URL(`https://backoffice.test/marketplace${search}`);
  const request = new Request(url);
  return await browseLoader({
    request,
    url,
    pattern: "/marketplace",
    params: {},
    context: routeContext(ctx, request),
  });
}

async function viewListing(ctx: BackofficeScenarioContext, listingRef: string) {
  const url = new URL(`https://backoffice.test/marketplace/${listingRef}`);
  const request = new Request(url);
  return await listingLoader({
    request,
    url,
    pattern: "/marketplace/:publisher/:packageSlug",
    params: {
      publisher: listingRef.split("/")[0],
      packageSlug: listingRef.split("/").slice(1).join("/"),
    },
    context: routeContext(ctx, request),
  });
}

async function openInstallEntry(
  ctx: BackofficeScenarioContext,
  listingRef: string,
  cookie: string,
) {
  const url = new URL(marketplaceInstallEntryPath(listingRef), "https://backoffice.test");
  const request = new Request(url, { headers: cookie ? { cookie } : {} });
  // The Backoffice layout throws its sign-in redirect; the route returns its own redirects.
  const response = await backofficeMarketplaceLoader({
    request,
    url,
    pattern: "/backoffice/marketplace",
    params: {},
    context: routeContext(ctx, request),
  }).catch((error: unknown) => error);
  assert(response instanceof Response);
  return response;
}

const ORG_SCOPE = { scopeKind: "org", scopeId: "ada-labs" } as const;
const SYSTEM_SCOPE = { scopeKind: "system", scopeId: "system" } as const;
type CatalogScope = typeof ORG_SCOPE | typeof SYSTEM_SCOPE;

function catalogRequest<TParams extends Record<string, string>>(
  ctx: BackofficeScenarioContext,
  scope: CatalogScope,
  path: string,
  params: TParams,
  cookie: string,
) {
  const url = new URL(
    `/backoffice/marketplace/${scope.scopeKind}/${scope.scopeId}${path}`,
    "https://backoffice.test",
  );
  const request = new Request(url, { headers: { cookie } });
  return {
    request,
    url,
    pattern: "/backoffice/marketplace/:scopeKind/:scopeId",
    params: { ...scope, ...params },
    context: routeContext(ctx, request),
  };
}

async function marketplaceWorkspace(
  ctx: BackofficeScenarioContext,
  scope: CatalogScope,
  cookie: string,
) {
  const data = await scopeLayoutLoader(catalogRequest(ctx, scope, "/marketplace", {}, cookie));
  assert(!(data instanceof Response));
  return data.selectedScope;
}

async function viewCatalogListing(
  ctx: BackofficeScenarioContext,
  scope: CatalogScope,
  listingRef: string,
  cookie: string,
) {
  const data = await catalogListingLoader(
    catalogRequest(
      ctx,
      scope,
      `/marketplace/${listingRef}`,
      {
        catalog: "marketplace",
        publisher: listingRef.split("/")[0],
        packageSlug: listingRef.split("/").slice(1).join("/"),
      },
      cookie,
    ),
  );
  assert(!(data instanceof Response));
  return data;
}

async function browseCatalog(
  ctx: BackofficeScenarioContext,
  scope: CatalogScope,
  catalog: "marketplace" | "organization",
  view: "featured" | "all",
  cookie: string,
) {
  const args = catalogRequest(
    ctx,
    scope,
    `/${catalog}${view === "all" ? "/all" : ""}`,
    { catalog },
    cookie,
  );
  const result =
    view === "featured"
      ? await catalogFeaturedLoader(args).then((data) => {
          assert(!(data instanceof Response));
          return data.listings.map(({ listing }) => listing.name);
        })
      : await catalogAllLoader(args).then((data) => {
          assert(!(data instanceof Response));
          return data.listings.map(
            ({ name, featured }) => `${name}${featured ? " (featured)" : ""}`,
          );
        });
  return result;
}

async function sessionUser(ctx: BackofficeScenarioContext) {
  const sessionCookie = ctx.vars.session;
  assert(typeof sessionCookie === "string");
  const session = await ctx.runtime.objects.auth.singleton().http.fetch(
    new Request("https://backoffice.test/api/auth/get-session", {
      headers: { cookie: sessionCookie },
    }),
  );
  return z
    .object({ user: z.object({ id: z.string(), email: z.string() }) })
    .parse(await session.json()).user;
}

/** Signs the captured session in as a member with the organization active. */
async function memberCookie(ctx: BackofficeScenarioContext): Promise<string> {
  const auth = ctx.runtime.objects.auth.singleton();
  const sessionCookie = ctx.vars.session;
  assert(typeof sessionCookie === "string");
  const userId = (await sessionUser(ctx)).id;
  await auth.commands.applyScenarioFixture({
    members: [{ organizationId: ORG_ID, userId, roles: ["member"] }],
  });
  const exchange = await auth.http.fetch(
    new Request("https://backoffice.test/api/auth/backoffice-token", {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: "https://backoffice.test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ selection: "required", organizationId: ORG_ID }),
    }),
  );
  assert(exchange.ok, await exchange.clone().text());
  return exchange.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

const CURATION = { startsAt: null, until: null, priority: 0, featuredBy: "system" } as const;

describe("Marketplace browsing scenarios", () => {
  test("scoped package links keep publisher identity through install handoff, management, and downloads", async () => {
    const external = {
      ...INVOICE_DIGEST,
      owner: {
        scope: { kind: "org" as const, orgId: "engineering/platform" },
        publisherName: "Other Labs",
      },
    };
    await runBackofficeScenario(
      defineBackofficeScenario<{ cookie: string }>({
        objects: scenarioObjects,
        name: "Publisher URLs are independent of the selected workspace",
        vars: () => ({ cookie: "" }),
        setup: ({ given }) => [
          given.organization.exists({ id: ORG_ID, slug: "ada-labs", name: "Ada Labs" }),
          given.organization.exists({
            id: "engineering/platform",
            slug: "other-labs",
            name: "Other Labs",
          }),
          given.marketplace.entries([INVOICE_DIGEST, external]),
        ],
        steps: ({ when, then }) => [
          then.assert(
            "public search links resolve distinct publishers with the same package slug",
            async (ctx) => {
              const page = await browse(ctx, "?q=invoice");
              expect(page.listingRefs).toEqual({
                [listingIdOf(INVOICE_DIGEST)]: "@ada-labs/invoice-digest",
                [listingIdOf(external)]: "@other-labs/invoice-digest",
              });
              expect((await viewListing(ctx, "@other-labs/invoice-digest")).listing.listingId).toBe(
                listingIdOf(external),
              );
              for (const ref of [
                "@missing/invoice-digest",
                "@ada-labs/missing-package",
                "@ada-labs/invalid/slug",
              ]) {
                await expect(viewListing(ctx, ref)).rejects.toMatchObject({ status: 404 });
              }
            },
          ),
          when.auth.signUp({ email: "publisher@example.test", captureSessionCookieAs: "session" }),
          then.assert(
            "a third-party package opens in the member's workspace without changing publishers",
            async (ctx) => {
              ctx.vars.cookie = await memberCookie(ctx);
              const response = await openInstallEntry(
                ctx,
                "@other-labs/invoice-digest",
                ctx.vars.cookie,
              );
              assert(
                response.headers.get("location") ===
                  "/backoffice/marketplace/org/ada-labs/marketplace/@other-labs/invoice-digest",
              );
              const detail = await viewCatalogListing(
                ctx,
                ORG_SCOPE,
                "@other-labs/invoice-digest",
                ctx.vars.cookie,
              );
              expect(detail.listing.listingId).toBe(listingIdOf(external));
              expect(detail.manageOrganizationSlug).toBeNull();
            },
          ),
          then.assert(
            "management reads and updates the URL's publisher, not a submitted organization override",
            async (ctx) => {
              const url = new URL(
                "https://backoffice.test/backoffice/marketplace/@ada-labs/invoice-digest/manage?visibility=public",
              );
              const request = new Request(url, { headers: { cookie: ctx.vars.cookie } });
              const args = {
                url,
                request,
                context: routeContext(ctx, request),
                pattern: "/backoffice/marketplace/:publisher/:packageSlug/manage",
                params: { publisher: "@ada-labs", packageSlug: "invoice-digest" },
              };
              const detail = await manageLoader(args);
              assert(!(detail instanceof Response));
              expect(detail.listing.listingId).toBe(listingIdOf(INVOICE_DIGEST));
              const form = new FormData();
              form.set("intent", "update");
              form.set("visibility", "public");
              form.set("organizationSlug", "other-labs");
              for (const [key, value] of Object.entries(INVOICE_DIGEST.metadata)) {
                form.set(key, Array.isArray(value) ? value.join(",") : value);
              }
              form.set("summary", "Updated through the scoped package management URL.");
              const post = new Request(url, {
                method: "POST",
                headers: { cookie: ctx.vars.cookie },
                body: form,
              });
              const result = await manageAction({
                ...args,
                request: post,
                context: routeContext(ctx, post),
              });
              assert(result instanceof Response);
              assert(
                result.headers.get("location") ===
                  "/backoffice/marketplace/@ada-labs/invoice-digest/manage?visibility=public&updated=1",
              );
              assert(
                (await viewListing(ctx, "@ada-labs/invoice-digest")).listing.summary ===
                  "Updated through the scoped package management URL.",
              );
              expect((await viewListing(ctx, "@other-labs/invoice-digest")).listing.summary).toBe(
                INVOICE_DIGEST.metadata.summary,
              );
              await expect(
                manageLoader({ ...args, params: { ...args.params, publisher: "@other-labs" } }),
              ).rejects.toMatchObject({ status: 404 });
            },
          ),
          then.assert(
            "package URLs download the selected publisher's bytes and still require sign-in",
            async (ctx) => {
              for (const [publisher, listingId, content] of [
                ["@ada-labs", listingIdOf(INVOICE_DIGEST), "Ada's package"],
                ["@other-labs", listingIdOf(external), "Other Labs' package"],
              ]) {
                const manifest = await ctx.runtime.objects.marketplace
                  .singleton()
                  .commands.getListingStorage({ listingId });
                assert(manifest);
                const uploadPackageFile = async (fileKey: string, text: string) => {
                  const form = new FormData();
                  form.set("provider", "database");
                  form.set("fileKey", fileKey);
                  form.set("file", new File([text], "README.md", { type: "text/markdown" }));
                  const uploaded = await ctx.runtime.objects.upload
                    .forName(manifest.uploadName)
                    .http.fetch(
                      new Request("https://backoffice.test/api/upload/files", {
                        method: "POST",
                        body: form,
                      }),
                    );
                  assert(uploaded.ok, await uploaded.clone().text());
                };
                const overviewPath = async () => {
                  const { packageFiles } = await viewCatalogListing(
                    ctx,
                    ORG_SCOPE,
                    `${publisher}/invoice-digest`,
                    ctx.vars.cookie,
                  );
                  assert(packageFiles.state === "ready");
                  return packageFiles.overviewPath;
                };
                assert((await overviewPath()) === null);
                await uploadPackageFile("1.0.0/README.md", content);
                // Without a listing README, the selected release's README is the overview.
                assert((await overviewPath()) === "/package/1.0.0/README.md");
                const args = catalogRequest(
                  ctx,
                  ORG_SCOPE,
                  `/marketplace/${publisher}/invoice-digest/package-file?packagePath=/package/1.0.0/README.md`,
                  { catalog: "marketplace", publisher, packageSlug: "invoice-digest" },
                  ctx.vars.cookie,
                );
                const response = await loadMarketplacePackageFile(args);
                assert(response.status === 200);
                expect(await response.text()).toBe(content);
                const anonymous = new Request(args.url);
                await expect(
                  loadMarketplacePackageFile({
                    ...args,
                    request: anonymous,
                    context: routeContext(ctx, anonymous),
                  }),
                ).rejects.toMatchObject({ status: 302 });
                await uploadPackageFile("README.md", `${content} listing`);
                assert((await overviewPath()) === "/package/README.md");
              }
            },
          ),
        ],
      }),
    );
  });
  test("visitors browse featured public listings, search everything public, and hand installs to Backoffice", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<{ cookie: string }>({
        objects: scenarioObjects,
        name: "The public Marketplace shows curated public listing metadata without signing in",
        vars: () => ({ cookie: "" }),
        setup: ({ given }) => [
          given.organization.exists({ id: ORG_ID, slug: "ada-labs", name: "Ada Labs" }),
          given.marketplace.entries([INVOICE_DIGEST, TELEGRAM_ALERTS]),
        ],
        steps: ({ when, then }) => [
          then.assert("the organization publishes a members-only package", async (ctx) => {
            const result = await ctx.runtime.objects.marketplace
              .forOrg(ORG_ID)
              .commands.insertStaticEntries({ entries: [PAYROLL_SYNC] });
            assert(result.ok);
          }),
          then.assert("each Marketplace features one of its listings", async (ctx) => {
            const publicFeature = await ctx.runtime.objects.marketplace
              .singleton()
              .commands.featureListing({
                ...CURATION,
                listingId: listingIdOf(INVOICE_DIGEST),
                note: "Staff pick",
              });
            assert(publicFeature.ok);
            const organizationFeature = await ctx.runtime.objects.marketplace
              .forOrg(ORG_ID)
              .commands.featureListing({
                ...CURATION,
                listingId: listingIdOf(PAYROLL_SYNC),
                note: null,
              });
            assert(organizationFeature.ok);
          }),
          then.assert("visitors see only featured public listings", async (ctx) => {
            const page = await browse(ctx, "");
            assert(page.kind === "featured");
            expect(page.listings).toMatchObject([
              { listing: { name: "Invoice digest", featured: true }, note: "Staff pick" },
            ]);
          }),
          then.assert("search matches every public listing, featured or not", async (ctx) => {
            const byTag = await browse(ctx, "?q=finance");
            assert(byTag.kind === "search");
            expect(byTag.listings).toMatchObject([{ name: "Invoice digest", featured: true }]);
            const byTerms = await browse(ctx, "?q=ada+telegram");
            assert(byTerms.kind === "search");
            expect(byTerms.listings).toMatchObject([{ name: "Telegram alerts", featured: false }]);
            const members = await browse(ctx, "?q=payroll");
            expect(members).toMatchObject({ query: "payroll", listings: [], hasNextPage: false });
            await expect(browse(ctx, `?q=${"x".repeat(241)}`)).rejects.toMatchObject({
              status: 400,
            });
          }),
          then.assert("public listing pages refuse members-only listings", async (ctx) => {
            const detail = await viewListing(ctx, "@ada-labs/invoice-digest");
            expect(detail).toMatchObject({
              listing: {
                name: "Invoice digest",
                publisherName: "Ada Labs",
                latestVersion: "1.0.0",
              },
              versions: [{ version: "1.0.0" }],
            });
            await expect(viewListing(ctx, "@ada-labs/payroll-sync")).rejects.toMatchObject({
              status: 404,
            });
          }),
          then.assert("installing sends anonymous visitors through sign-in", async (ctx) => {
            const listingRef = "@ada-labs/invoice-digest";
            const response = await openInstallEntry(ctx, listingRef, "");
            assert(response.status === 302);
            expect(response.headers.get("location")).toBe(
              buildBackofficeLoginPath(marketplaceInstallEntryPath(listingRef)),
            );
          }),
          when.auth.signUp({
            email: "member@example.test",
            captureSessionCookieAs: "session",
          }),
          then.assert("the member signs in with the organization active", async (ctx) => {
            ctx.vars.cookie = await memberCookie(ctx);
          }),
          then.assert(
            "signed-in members land on the listing in their active organization",
            async (ctx) => {
              const response = await openInstallEntry(
                ctx,
                "@ada-labs/invoice-digest",
                ctx.vars.cookie,
              );
              assert(
                response.headers.get("location") ===
                  "/backoffice/marketplace/org/ada-labs/marketplace/@ada-labs/invoice-digest",
              );
            },
          ),
          then.assert(
            "each catalog opens on its featured listings with every listing under All",
            async (ctx) => {
              const { cookie } = ctx.vars;
              expect(
                await browseCatalog(ctx, ORG_SCOPE, "marketplace", "featured", cookie),
              ).toEqual(["Invoice digest"]);
              expect(
                (await browseCatalog(ctx, ORG_SCOPE, "marketplace", "all", cookie)).sort(),
              ).toEqual(["Invoice digest (featured)", "Telegram alerts"]);
              expect(
                await browseCatalog(ctx, ORG_SCOPE, "organization", "featured", cookie),
              ).toEqual(["Payroll sync"]);
              expect(await browseCatalog(ctx, ORG_SCOPE, "organization", "all", cookie)).toEqual([
                "Payroll sync (featured)",
              ]);
            },
          ),
          then.assert("System scope is hidden from organization members", async (ctx) => {
            await expect(
              browseCatalog(ctx, SYSTEM_SCOPE, "marketplace", "featured", ctx.vars.cookie),
            ).rejects.toMatchObject({ status: 404 });
            await expect(
              marketplaceWorkspace(ctx, SYSTEM_SCOPE, ctx.vars.cookie),
            ).rejects.toMatchObject({ status: 404 });
          }),
          then.assert(
            "System administrators browse the public Marketplace they curate in System scope",
            async (ctx) => {
              const user = await sessionUser(ctx);
              await ctx.runtime.objects.auth.singleton().commands.applyScenarioFixture({
                users: [{ id: user.id, email: user.email, role: "admin", status: "active" }],
              });
              // The access token carries the role, so the new administrator signs in again.
              const cookie = await memberCookie(ctx);
              expect(await marketplaceWorkspace(ctx, SYSTEM_SCOPE, cookie)).toEqual({
                kind: "system",
                label: "System",
              });
              expect(
                await browseCatalog(ctx, SYSTEM_SCOPE, "marketplace", "featured", cookie),
              ).toEqual(["Invoice digest"]);
              expect(
                (await browseCatalog(ctx, SYSTEM_SCOPE, "marketplace", "all", cookie)).sort(),
              ).toEqual(["Invoice digest (featured)", "Telegram alerts"]);
              await expect(
                browseCatalog(ctx, SYSTEM_SCOPE, "organization", "featured", cookie),
              ).rejects.toMatchObject({ status: 404 });
              const detail = await viewCatalogListing(
                ctx,
                SYSTEM_SCOPE,
                "@ada-labs/telegram-alerts",
                cookie,
              );
              expect(detail).toMatchObject({
                listing: { name: "Telegram alerts", featured: false },
                installationCollectionSource: null,
                installationReference: null,
                installationUnavailableMessage: expect.stringContaining(
                  "System has no workspace to install into",
                ),
              });
            },
          ),
        ],
      }),
    );
  });
});
