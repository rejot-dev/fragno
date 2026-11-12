import { assert, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import { runtimeSiteHosts } from "@/artifacts/sites/site-hosts.server";
import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { blobsR2BucketsFromEnv } from "@/fragno/blobs-r2-buckets";
import { createFakeR2 } from "@/fragno/blobs-r2.test-utils";
import {
  behindBackofficeLayout,
  sessionUserId,
  withBackofficeAccessToken,
} from "@/layouts/backoffice-layout.test-support";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { loader } from "./artifacts";

const backoffice = "https://backoffice.example";

const buckets = blobsR2BucketsFromEnv(
  {
    BLOBS_R2_ENDPOINT: "https://account-1.r2.cloudflarestorage.com",
    BLOBS_R2_BUCKET: "backoffice-blobs",
    BLOBS_R2_ACCESS_KEY_ID: "access-key",
    BLOBS_R2_SECRET_ACCESS_KEY: "secret-key",
    DOCS_PUBLIC_BASE_URL: `${backoffice}/`,
  },
  "enforced",
);
assert(buckets);
const r2 = createFakeR2(buckets);

type Vars = { session: string };
type Ctx = BackofficeScenarioContext<Vars>;

/** The person's own scope, which their sign-up opened. */
async function ownScope(ctx: Ctx): Promise<BackofficeContextScope & { kind: "user" }> {
  return { kind: "user", userId: await sessionUserId(ctx, ctx.vars.session), jurisdiction: null };
}

/** Opens the Artifacts page of the person's own scope, as their browser does. */
async function openArtifacts(ctx: Ctx) {
  const scope = await ownScope(ctx);
  const cookie = await withBackofficeAccessToken(ctx, ctx.vars.session, null);
  const url = new URL(`/backoffice/artifacts/user/${scope.userId}`, backoffice);
  const request = new Request(url, { headers: { cookie } });
  const context = createBackofficeRouterContextProvider(request, {
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
  const { listing } = await behindBackofficeLayout(loader)({
    request,
    context,
    url,
    params: { scopeKind: "user", scopeId: scope.userId },
    pattern: "/backoffice/artifacts/:scopeKind/:scopeId",
  });
  return listing;
}

async function runInOwnScope(ctx: Ctx, code: string, assertToolCalls: readonly string[] = []) {
  return await ctx.runCodemode({ scope: await ownScope(ctx), code, assertToolCalls });
}

function writeFiles(files: Record<string, string>): string {
  return `async () => {
  for (const [path, content] of Object.entries(${JSON.stringify(files)})) {
    await state.writeFile({ path, content });
  }
}`;
}

test("Artifacts lists the workspace's pages, workflows, and sites as they are served", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario<Vars>({
      objects: allLocalObjects,
      name: "listing pages and sites",
      env: {
        AUTH_EMAIL_VERIFICATION_ENABLED: "false",
        SIGN_UP_ACCESS_CODES_REQUIRED: "false",
        SITES_ENABLED: "true",
        SITES_DOMAIN: "ley.run",
        DOCS_PUBLIC_BASE_URL: `${backoffice}/`,
        siteStorage: { buckets, fetch: r2.fetch },
      },
      vars: () => ({ session: "" }),
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "ada@example.test", captureSessionCookieAs: "session" }),
        then.assert("a new workspace has no pages, sites, or workflows", async (ctx) => {
          const listing = await openArtifacts(ctx);
          assert.deepEqual(listing, { kind: "listed", pages: [], sites: [], workflows: [] });
        }),
        then.assert(
          "each page and workflow is listed, and each site with what it serves",
          async (ctx) => {
            const before = Date.now();
            await runInOwnScope(
              ctx,
              writeFiles({
                "/workspace/reports/operations.page.js": "export default {};",
                "/workspace/automations/file-invoices.workflow.js": "export default {};",
                "/workspace/notes.site/public/index.html": "<title>Notes</title>",
                "/workspace/tools/form.site/public/index.html": "<title>Form</title>",
                "/workspace/tools/form.site/site.json": '{ "public": true }',
                "/workspace/drafts/idea.site/public/index.html": "<title>Idea</title>",
                // Named like a site, but a file, which no build reads as one.
                "/workspace/readme.site": "Not a site.",
              }),
            );
            for (const path of ["/workspace/notes.site", "/workspace/tools/form.site"]) {
              const built = await runInOwnScope(
                ctx,
                `async () => await artifacts.buildSite({ path: ${JSON.stringify(path)} })`,
                ["artifacts.buildSite"],
              );
              assert.equal((built.result as { status: string }).status, "built");
            }

            const listing = await openArtifacts(ctx);
            assert(listing.kind === "listed" && listing.sites !== null);
            const sites = runtimeSiteHosts(ctx.runtime.services);
            assert(sites);
            const host = await sites.hosts.hostFor(await ownScope(ctx));
            assert.deepEqual(
              listing.pages.map(({ sourcePath }) => sourcePath),
              ["/workspace/reports/operations.page.js"],
            );
            assert.deepEqual(
              listing.workflows.map(({ sourcePath }) => sourcePath),
              ["/workspace/automations/file-invoices.workflow.js"],
            );
            assert.deepEqual(
              listing.sites.map(({ sitePath, serving }) => ({ sitePath, serving })),
              [
                { sitePath: "/workspace/drafts/idea.site", serving: { kind: "unbuilt" } },
                {
                  sitePath: "/workspace/notes.site",
                  serving: {
                    kind: "built",
                    public: false,
                    url: `https://${host}.ley.run/notes.site/`,
                  },
                },
                {
                  sitePath: "/workspace/tools/form.site",
                  serving: {
                    kind: "built",
                    public: true,
                    url: `https://${host}-public.ley.run/tools/form.site/`,
                  },
                },
              ],
            );
            for (const { editedAt } of [...listing.pages, ...listing.workflows, ...listing.sites]) {
              assert.isAtLeast(editedAt, before - 1000);
            }
          },
        ),
      ],
    }),
  );
});
