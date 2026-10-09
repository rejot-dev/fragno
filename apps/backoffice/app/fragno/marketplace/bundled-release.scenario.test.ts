import { assert, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class DurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }
  class RpcTarget {}
  class WorkerEntrypoint {}
  return { DurableObject, RpcTarget, WorkerEntrypoint };
});
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import {
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME } from "@/fragno/automation/marketplace-package-publish-workflow";
import { createWorkflowsRouteCaller } from "@/fragno/automation/route-callers";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createRouteBackedAutomationWorkflowRuntime } from "@/fragno/automation/workflow-route-runtime";
import { createUploadRouteCaller } from "@/fragno/upload-server";

import { InMemoryAuthObject } from "../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../workers/automations.do";
import { InMemoryMarketplaceObject } from "../../../workers/marketplace.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import { marketplaceArtifactUploadName, type MarketplaceStaticArtifactEntry } from "./artifacts";
import {
  captureBundledMarketplaceRelease,
  initializeMarketplaceListingRootFiles,
} from "./bundled-release";
import {
  marketplacePackagePublishRequestSchema,
  marketplacePackagePublishWorkflowInstanceId,
  type MarketplacePackagePublishRequest,
} from "./package-publishing";
import {
  MARKETPLACE_RELEASE_GUARD_PATH,
  marketplaceReleaseArtifactFiles,
} from "./release-snapshot";

const scenarioObjects = {
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  MARKETPLACE: (input) => new InMemoryMarketplaceObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const LISTING_ID = "system#unified-release-probe";
const CONTEXT = {
  execution: createBackofficeSystemExecution({ kind: "system" }),
  propagationContext: null,
};

function bundledEntry(): MarketplaceStaticArtifactEntry & {
  rootFiles: Readonly<Record<string, string>>;
} {
  return {
    owner: { scope: { kind: "system" }, publisherName: "Fragno" },
    slug: "unified-release-probe",
    version: "1.0.0",
    metadata: {
      name: "Captured release",
      summary: "A bundled release exercises the common publishing lifecycle.",
      description:
        "This package verifies captured bytes, metadata replacements, atomic file deletion, and stale workflow restart protection.",
      category: "developer-tools",
      tags: [],
    },
    files: { "README.md": "Captured bytes", "obsolete.txt": "Remove on replacement" },
    rootFiles: { "README.md": "Listing documentation" },
  };
}

function artifactRoutes(ctx: BackofficeScenarioContext) {
  return createUploadRouteCaller(
    ctx.runtime.objects.upload.forName(marketplaceArtifactUploadName(LISTING_ID)).http,
  );
}

async function fileContent(ctx: BackofficeScenarioContext, fileKey: string): Promise<Response> {
  const url = new URL("https://upload.test/api/upload/files/by-key/content");
  url.searchParams.set("provider", "database");
  url.searchParams.set("key", fileKey);
  return ctx.runtime.objects.upload
    .forName(marketplaceArtifactUploadName(LISTING_ID))
    .http.fetch(new Request(url));
}

function workflowRuntime(ctx: BackofficeScenarioContext) {
  return createRouteBackedAutomationWorkflowRuntime({
    object: ctx.runtime.objects.automations.singleton(),
    execution: CONTEXT.execution,
  });
}

test("a maximum-size release captures destination revisions in one batch without per-file lookups", async () => {
  let snapshotReads = 0;
  let individualReads = 0;
  let uploads = 0;
  const source = {
    ...bundledEntry(),
    files: Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`file-${index}.txt`, `captured ${index}`]),
    ),
  };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Batch destination snapshots for 100-file publication",
      objects: {
        ...scenarioObjects,
        UPLOAD: ({ state, env, runtime, implementation }) =>
          new (class extends InMemoryUploadObject {
            override async fetch(request: Request): Promise<Response> {
              const url = new URL(request.url);
              if (request.method === "POST" && url.pathname.endsWith("/uploads")) {
                uploads += 1;
              }
              if (request.method === "POST" && url.pathname.endsWith("/files/snapshots")) {
                snapshotReads += 1;
              }
              if (request.method === "GET" && url.pathname.endsWith("/files/by-key")) {
                individualReads += 1;
              }
              return super.fetch(request);
            }
          })({
            state,
            env: env as unknown as ConstructorParameters<typeof InMemoryUploadObject>[0]["env"],
            runtime,
            implementation,
          }),
      },
      steps: ({ then, runner }) => [
        then.assert("accept a release with 100 authored files", async (ctx) => {
          const release = await captureBundledMarketplaceRelease(source);
          const result = await ctx.runtime.objects.marketplace
            .singleton()
            .commands.publishRelease(
              { release, dryRun: false, skipAuthorCheck: false, skipVersionCheck: false },
              CONTEXT,
            );
          expect(result).toMatchObject({ state: "requested", workflowCreated: true });
          expect(snapshotReads).toBe(1);
          expect(individualReads).toBe(0);
        }),
        runner.drain(),
        then.assert(
          "the complete file set is published without individual metadata reads",
          async (ctx) => {
            expect(
              (
                await ctx.runtime.objects.marketplace
                  .singleton()
                  .commands.getArtifactManifest({ listingId: LISTING_ID })
              )?.versions,
            ).toEqual(["1.0.0"]);
            const response = await artifactRoutes(ctx)("GET", "/files", {
              query: { provider: "database", prefix: "1.0.0/", pageSize: "500", status: "ready" },
            });
            assert(response.type === "json");
            expect(response.data.files).toHaveLength(101);
            expect(uploads).toBe(101);
            expect(individualReads).toBe(0);
            await expect((await fileContent(ctx, "1.0.0/file-99.txt")).text()).resolves.toBe(
              "captured 99",
            );
          },
        ),
        then.assert(
          "request metadata-only replacement without changing any authored bytes",
          async (ctx) => {
            const release = await captureBundledMarketplaceRelease({
              ...source,
              metadata: { ...source.metadata, name: "Metadata-only replacement" },
            });
            await ctx.runtime.objects.marketplace
              .singleton()
              .commands.publishRelease(
                { release, dryRun: false, skipAuthorCheck: false, skipVersionCheck: true },
                CONTEXT,
              );
          },
        ),
        runner.drain(),
        then.assert(
          "only the publishing guard is uploaded and unchanged files keep their revisions",
          async (ctx) => {
            expect(uploads).toBe(102);
            expect(individualReads).toBe(0);
            const result = await artifactRoutes(ctx)("POST", "/files/snapshots", {
              body: {
                provider: "database",
                fileKeys: ["1.0.0/file-99.txt", `1.0.0/${MARKETPLACE_RELEASE_GUARD_PATH}`],
              },
            });
            assert(result.type === "json");
            expect(result.data.files).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ fileKey: "1.0.0/file-99.txt", revision: 0 }),
                expect.objectContaining({
                  fileKey: `1.0.0/${MARKETPLACE_RELEASE_GUARD_PATH}`,
                  revision: 1,
                }),
              ]),
            );
            assert(
              (
                await ctx.runtime.objects.marketplace
                  .singleton()
                  .commands.getPublishedListing({ listingId: LISTING_ID })
              )?.listing.name === "Metadata-only replacement",
            );
          },
        ),
      ],
    }),
  );
});

test("reused files are revision-asserted atomically with the metadata guard", async () => {
  let changeDuringPreparation = false;
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Concurrent edit to a reused file rejects metadata replacement",
      options: { allowErroredWorkflows: true },
      objects: {
        ...scenarioObjects,
        UPLOAD: ({ state, env, runtime, implementation }) =>
          new (class extends InMemoryUploadObject {
            override async fetch(request: Request): Promise<Response> {
              const response = await super.fetch(request);
              if (
                changeDuringPreparation &&
                request.method === "POST" &&
                new URL(request.url).pathname.endsWith("/uploads")
              ) {
                changeDuringPreparation = false;
                const form = new FormData();
                form.set("provider", "database");
                form.set("fileKey", "1.0.0/README.md");
                form.set(
                  "file",
                  new File(["Concurrent bytes"], "README.md", { type: "text/plain" }),
                );
                const written = await super.fetch(
                  new Request(new URL("/api/upload/files", request.url), {
                    method: "POST",
                    body: form,
                  }),
                );
                assert(written.ok);
              }
              return response;
            }
          })({
            state,
            env: env as unknown as ConstructorParameters<typeof InMemoryUploadObject>[0]["env"],
            runtime,
            implementation,
          }),
      },
      steps: ({ then, runner }) => [
        then.assert("publish the original release", async (ctx) => {
          const release = await captureBundledMarketplaceRelease(bundledEntry());
          await ctx.runtime.objects.marketplace
            .singleton()
            .commands.publishRelease(
              { release, dryRun: false, skipAuthorCheck: false, skipVersionCheck: false },
              CONTEXT,
            );
        }),
        runner.drain(),
        then.assert(
          "request metadata replacement and edit an unchanged file after the durable reuse plan",
          async (ctx) => {
            const source = bundledEntry();
            const release = await captureBundledMarketplaceRelease({
              ...source,
              metadata: { ...source.metadata, name: "Rejected metadata" },
            });
            await ctx.runtime.objects.marketplace
              .singleton()
              .commands.publishRelease(
                { release, dryRun: false, skipAuthorCheck: false, skipVersionCheck: true },
                CONTEXT,
              );
            changeDuringPreparation = true;
          },
        ),
        runner.drain(),
        then.assert(
          "the assertion preserves concurrent bytes, the original guard, and catalog metadata",
          async (ctx) => {
            const source = await captureBundledMarketplaceRelease(bundledEntry());
            const marker = await fileContent(ctx, `1.0.0/${MARKETPLACE_RELEASE_GUARD_PATH}`);
            await expect(marker.json()).resolves.toEqual({ snapshotId: source.snapshotId });
            await expect((await fileContent(ctx, "1.0.0/README.md")).text()).resolves.toBe(
              "Concurrent bytes",
            );
            assert(
              (
                await ctx.runtime.objects.marketplace
                  .singleton()
                  .commands.getPublishedListing({ listingId: LISTING_ID })
              )?.listing.name === "Captured release",
            );
          },
        ),
      ],
    }),
  );
});

test("generic workflow creation cannot forge the release publisher's provenance", async () => {
  const caller = {
    execution: createBackofficeUserExecution({ scope: { kind: "system" }, userId: "admin-1" }),
    propagationContext: null,
  };
  await runBackofficeScenario(
    defineBackofficeScenario<{ forgedInstanceId: string }>({
      objects: scenarioObjects,
      name: "Captured release input cannot impersonate trusted workflow actors",
      vars: () => ({ forgedInstanceId: "" }),
      setup: ({ given }) => [given.auth.user({ id: "admin-1", role: "admin" })],
      options: { allowErroredWorkflows: true },
      steps: ({ then, runner }) => [
        then.assert(
          "create a structurally valid workflow that claims a different original publisher",
          async (ctx) => {
            const release = await captureBundledMarketplaceRelease(bundledEntry());
            const files = await marketplaceReleaseArtifactFiles(release);
            const work: Omit<MarketplacePackagePublishRequest, "workflowInstanceId"> = {
              intent: {
                release,
                execution: caller.execution,
                skipAuthorCheck: false,
                skipVersionCheck: false,
              },
              expectedVersionRevision: null,
              expectedFiles: files.map((file) => ({
                fileKey: `${release.version}/${file.relativePath}`,
                precondition: { kind: "absent" },
              })),
            };
            ctx.vars.forgedInstanceId = await marketplacePackagePublishWorkflowInstanceId(work);
            await workflowRuntime(ctx).createInternalInstance({
              workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
              instanceId: ctx.vars.forgedInstanceId,
              params: { request: { ...work, workflowInstanceId: ctx.vars.forgedInstanceId } },
            });
          },
        ),
        runner.drain(),
        then.assert(
          "trusted actor binding rejects the forged request before creating catalog state",
          async (ctx) => {
            expect(
              (
                await workflowRuntime(ctx).getInternalInstance({
                  workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
                  instanceId: ctx.vars.forgedInstanceId,
                })
              ).details,
            ).toMatchObject({
              status: "errored",
              error: {
                message: "Marketplace publishing actors do not match trusted workflow provenance.",
              },
            });
            await expect(
              ctx.runtime.objects.marketplace
                .singleton()
                .commands.getArtifactManifest({ listingId: LISTING_ID }),
            ).resolves.toBeNull();
            const result = await ctx.runtime.objects.marketplace
              .singleton()
              .commands.publishRelease(
                {
                  release: await captureBundledMarketplaceRelease({
                    ...bundledEntry(),
                    version: "1.1.0",
                  }),
                  dryRun: false,
                  skipAuthorCheck: false,
                  skipVersionCheck: false,
                },
                caller,
              );
            assert(result.state === "requested");
          },
        ),
        runner.drain(),
        then.assert(
          "the same human administrator can publish through the authenticated release boundary",
          async (ctx) => {
            expect(
              (
                await ctx.runtime.objects.marketplace
                  .singleton()
                  .commands.getArtifactManifest({ listingId: LISTING_ID })
              )?.versions,
            ).toEqual(["1.1.0"]);
          },
        ),
      ],
    }),
  );
});

test("bundled releases use captured input, guarded replacement, and stale-restart protection without an organization", async () => {
  let source = bundledEntry();
  await runBackofficeScenario(
    defineBackofficeScenario<{
      originalRequest: MarketplacePackagePublishRequest | null;
      originalInstanceId: string;
      markerRevision: number;
    }>({
      objects: scenarioObjects,
      name: "One publishing lifecycle for System-owned bundled releases",
      vars: () => ({ originalRequest: null, originalInstanceId: "", markerRevision: 0 }),
      options: { allowErroredWorkflows: true },
      steps: ({ then, runner }) => [
        then.assert(
          "capture a System release before enqueueing and initialize listing-root files separately",
          async (ctx) => {
            await initializeMarketplaceListingRootFiles(artifactRoutes(ctx), source.rootFiles);
            const release = await captureBundledMarketplaceRelease(source);
            const result = await ctx.runtime.objects.marketplace
              .singleton()
              .commands.publishRelease(
                { release, dryRun: false, skipAuthorCheck: false, skipVersionCheck: false },
                CONTEXT,
              );
            assert(result.state === "requested");
            ctx.vars.originalInstanceId = result.workflowInstanceId;
            const instance = await workflowRuntime(ctx).getInternalInstance({
              workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
              instanceId: result.workflowInstanceId,
            });
            const params = instance.meta.params as { request: unknown };
            ctx.vars.originalRequest = marketplacePackagePublishRequestSchema.parse(params.request);
            expect(ctx.vars.originalRequest.intent.release.owner.scope).toEqual({ kind: "system" });
            expect(
              ctx.vars.originalRequest.intent.release.files.map((file) => file.relativePath),
            ).toEqual(["README.md", "obsolete.txt"]);
            source = {
              ...source,
              metadata: { ...source.metadata, name: "Changed live metadata" },
              files: { "README.md": "Changed live bytes" },
            };
          },
        ),
        runner.drain(),
        then.assert(
          "the accepted bytes and metadata do not follow mutable bundled definitions",
          async (ctx) => {
            const detail = await ctx.runtime.objects.marketplace
              .singleton()
              .commands.getPublishedListing({ listingId: LISTING_ID });
            assert(detail?.listing.name === "Captured release");
            await expect((await fileContent(ctx, "1.0.0/README.md")).text()).resolves.toBe(
              "Captured bytes",
            );
            await expect((await fileContent(ctx, "README.md")).text()).resolves.toBe(
              "Listing documentation",
            );
            const duplicate = await ctx.runtime.objects.marketplace
              .singleton()
              .commands.publishRelease(
                {
                  release: await captureBundledMarketplaceRelease(bundledEntry()),
                  dryRun: false,
                  skipAuthorCheck: false,
                  skipVersionCheck: false,
                },
                CONTEXT,
              );
            expect(duplicate).toMatchObject({
              state: "published",
              workflowInstanceId: ctx.vars.originalInstanceId,
            });
            const marker = await artifactRoutes(ctx)("GET", "/files/by-key", {
              query: { provider: "database", key: `1.0.0/${MARKETPLACE_RELEASE_GUARD_PATH}` },
            });
            assert(marker.type === "json");
            ctx.vars.markerRevision = marker.data.revision;
            const entry = bundledEntry();
            const changed = await captureBundledMarketplaceRelease({
              ...entry,
              metadata: { ...entry.metadata, name: "Replaced metadata" },
            });
            await expect(
              ctx.runtime.objects.marketplace.singleton().commands.publishRelease(
                {
                  release: changed,
                  dryRun: false,
                  skipAuthorCheck: false,
                  skipVersionCheck: false,
                },
                CONTEXT,
              ),
            ).rejects.toMatchObject({ code: "MARKETPLACE_VERSION_TRANSITION_INVALID" });
            const replacement = await ctx.runtime.objects.marketplace
              .singleton()
              .commands.publishRelease(
                { release: changed, dryRun: false, skipAuthorCheck: false, skipVersionCheck: true },
                CONTEXT,
              );
            assert(replacement.state === "requested");
            expect(replacement.workflowInstanceId).not.toBe(ctx.vars.originalInstanceId);
          },
        ),
        runner.drain(),
        then.assert(
          "metadata-only replacement changes the Upload revision fence too",
          async (ctx) => {
            assert(
              (
                await ctx.runtime.objects.marketplace
                  .singleton()
                  .commands.getPublishedListing({ listingId: LISTING_ID })
              )?.listing.name === "Replaced metadata",
            );
            const marker = await artifactRoutes(ctx)("GET", "/files/by-key", {
              query: { provider: "database", key: `1.0.0/${MARKETPLACE_RELEASE_GUARD_PATH}` },
            });
            assert(marker.type === "json");
            expect(marker.data.revision).toBeGreaterThan(ctx.vars.markerRevision);
            const entry = bundledEntry();
            const replacement = await ctx.runtime.objects.marketplace
              .singleton()
              .commands.publishRelease(
                {
                  release: await captureBundledMarketplaceRelease({
                    ...entry,
                    metadata: { ...entry.metadata, name: "Complete replacement" },
                    files: { "new.txt": "A disjoint file set" },
                  }),
                  dryRun: false,
                  skipAuthorCheck: false,
                  skipVersionCheck: true,
                },
                CONTEXT,
              );
            assert(replacement.state === "requested");
          },
        ),
        runner.drain(),
        then.assert(
          "replacement removes omitted files and a stale full restart cannot restore them",
          async (ctx) => {
            assert((await fileContent(ctx, "1.0.0/README.md")).status === 410);
            assert((await fileContent(ctx, "1.0.0/obsolete.txt")).status === 410);
            await expect((await fileContent(ctx, "1.0.0/new.txt")).text()).resolves.toBe(
              "A disjoint file set",
            );
            assert(ctx.vars.originalRequest);
            await expect(
              ctx.runtime.objects.marketplace
                .singleton()
                .commands.completePackagePublish(ctx.vars.originalRequest, CONTEXT),
            ).rejects.toThrow();
            const response = await createWorkflowsRouteCaller({
              object: ctx.runtime.objects.automations.singleton(),
              context: CONTEXT,
            })("POST", "/:workflowName/instances/:instanceId/restart", {
              pathParams: {
                workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
                instanceId: ctx.vars.originalInstanceId,
              },
            });
            assert(response.type === "json");
          },
        ),
        runner.drain(),
        then.assert(
          "the superseded publisher conflicts without modifying the current release",
          async (ctx) => {
            const instance = await workflowRuntime(ctx).getInternalInstance({
              workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
              instanceId: ctx.vars.originalInstanceId,
            });
            expect(instance.details).toMatchObject({
              status: "errored",
              error: { message: expect.stringContaining("changed after publication was prepared") },
            });
            await expect((await fileContent(ctx, "1.0.0/new.txt")).text()).resolves.toBe(
              "A disjoint file set",
            );
            const entry = bundledEntry();
            const backfill = await ctx.runtime.objects.marketplace
              .singleton()
              .commands.publishRelease(
                {
                  release: await captureBundledMarketplaceRelease({
                    ...entry,
                    version: "0.9.0",
                    metadata: { ...entry.metadata, name: "Older metadata" },
                  }),
                  dryRun: false,
                  skipAuthorCheck: false,
                  skipVersionCheck: true,
                },
                CONTEXT,
              );
            assert(backfill.state === "requested");
          },
        ),
        runner.drain(),
        then.assert(
          "backfills cannot regress latest version or metadata and root documents remain independent",
          async (ctx) => {
            expect(
              (
                await ctx.runtime.objects.marketplace
                  .singleton()
                  .commands.getPublishedListing({ listingId: LISTING_ID })
              )?.listing,
            ).toMatchObject({ latestVersion: "1.0.0", name: "Complete replacement" });
            await initializeMarketplaceListingRootFiles(artifactRoutes(ctx), {
              "README.md": "Attempt to replace initialized listing docs",
            });
            await expect((await fileContent(ctx, "README.md")).text()).resolves.toBe(
              "Listing documentation",
            );
          },
        ),
      ],
    }),
  );
});
