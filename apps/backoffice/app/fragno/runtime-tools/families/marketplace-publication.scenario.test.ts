import { assert, describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));

import {
  createBackofficeRequestExecution,
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import { createStaticFileCollection } from "@/file-collection/create-static-file-collection";
import { MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME } from "@/fragno/automation/marketplace-package-publish-workflow";
import { createWorkflowsRouteCaller } from "@/fragno/automation/route-callers";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createRouteBackedAutomationWorkflowRuntime } from "@/fragno/automation/workflow-route-runtime";
import {
  createBackofficeStateBackend,
  type BackofficeStateBackend,
} from "@/fragno/codemode/state-backend";
import { marketplaceArtifactUploadName } from "@/fragno/marketplace/artifacts";
import type { MarketplaceArtifactManifest } from "@/fragno/marketplace/contracts";
import { marketplacePackageManifestSchema } from "@/fragno/marketplace/package-manifest";
import {
  marketplacePublishResultSchema,
  marketplacePackagePublishRequestSchema,
  type MarketplacePublishResult,
} from "@/fragno/marketplace/package-publishing";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { sha256Hex } from "@/lib/crypto";
import {
  fetchPublishedMarketplaceArtifactFile,
  loadPublishedMarketplaceArtifactExplorer,
} from "@/routes/backoffice/marketplace/artifact-files.server";

import { InMemoryApiObject } from "../../../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../../workers/forms.do";
import { InMemoryMarketplaceObject } from "../../../../workers/marketplace.do";
import { InMemoryMcpObject } from "../../../../workers/mcp.do";
import { InMemoryTelegramObject } from "../../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../../workers/upload.do";
import { createMarketplaceRuntime } from "./marketplace-runtime";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  MARKETPLACE: (input) => new InMemoryMarketplaceObject(input),
  MCP: (input) => new InMemoryMcpObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const ORG_SCOPE = { kind: "org", orgId: "org-1" } as const;
const PACKAGE_ROOT = "/workspace/packages/report";
const LISTING_ID = "org:org-1#durable-package";
const BINARY = new Uint8Array([0, 255, 128, 13, 10, 0]);
const METADATA = {
  name: "Durable package",
  summary: "A package captured before publication begins.",
  description:
    "A package used to exercise real publishing, artifact reads, and workspace installation.",
  category: "developer-tools",
  tags: ["testing"],
};

function sourceState(
  ctx: BackofficeScenarioContext,
  scope: BackofficeRoutableScope,
): BackofficeStateBackend {
  return createBackofficeStateBackend({
    uploadObject: ctx.runtime.objects.upload.for(scope).http,
    staticFileCollection: createStaticFileCollection({}),
  });
}

async function seedPackage(
  state: BackofficeStateBackend,
  {
    name,
    version,
    readme,
    files,
  }: {
    name: string;
    version: string;
    readme: string;
    files: string[];
  },
): Promise<void> {
  await state.writeFile(
    `${PACKAGE_ROOT}/manifest.json`,
    JSON.stringify({ name, version, metadata: METADATA, files }),
  );
  await state.writeFile(`${PACKAGE_ROOT}/README.md`, readme);
  await state.writeFile(
    `${PACKAGE_ROOT}/automations/report.workflow.js`,
    "throw new Error('Publishing must not execute this file.');",
  );
  await state.writeFileBytes(`${PACKAGE_ROOT}/assets/payload.bin`, BINARY);
}

function publisherShell(ctx: BackofficeScenarioContext, execution: BackofficeExecutionContext) {
  const context = createRouteBackedRuntimeContext({
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution,
    billingOrganizationId: null,
  });
  assert(context.stateBackend);
  return createInteractiveBashHost({ context: { ...context, stateBackend: context.stateBackend } })
    .bash;
}

function systemPublisher(ctx: BackofficeScenarioContext, state: BackofficeStateBackend) {
  const execution = createBackofficeSystemExecution({ kind: "system" });
  const kernel = new BackofficeKernel(ctx.runtime.services);
  const context = createRouteBackedRuntimeContext({
    runtime: ctx.runtime.services,
    kernel,
    execution,
    billingOrganizationId: null,
  });
  // The trusted System shell supplies a concrete readable source; flags never select a source scope.
  context.marketplace = {
    runtime: createMarketplaceRuntime(ctx.runtime.objects.marketplace.singleton().commands, {
      state,
      execution,
      kernel,
    }),
  };
  return createInteractiveBashHost({ context: { ...context, stateBackend: state } }).bash;
}

async function publishFromShell(
  bash: ReturnType<typeof publisherShell>,
  flags: string,
): Promise<MarketplacePublishResult> {
  const result = await bash.exec(
    `marketplace.publish --package-root ${PACKAGE_ROOT} ${flags} --format json`,
  );
  assert(result.exitCode === 0, result.stderr);
  return marketplacePublishResultSchema.parse(JSON.parse(result.stdout));
}

async function publishedManifest(
  ctx: BackofficeScenarioContext,
  listingId = LISTING_ID,
): Promise<MarketplaceArtifactManifest> {
  const manifest = await ctx.runtime.objects.marketplace
    .singleton()
    .commands.getArtifactManifest({ listingId });
  assert(manifest?.listingStatus === "published");
  return manifest;
}

function artifactFile(
  ctx: BackofficeScenarioContext,
  manifest: MarketplaceArtifactManifest,
  relativePath: string,
  version = "1.0.0",
) {
  return fetchPublishedMarketplaceArtifactFile({
    manifest,
    objects: ctx.runtime.objects,
    request: new Request("https://backoffice.test/marketplace/package"),
    path: `/artifact/${version}/${relativePath}`,
  });
}

async function publicationStatus(ctx: BackofficeScenarioContext, result: MarketplacePublishResult) {
  assert(result.state !== "preview");
  return await createRouteBackedAutomationWorkflowRuntime({
    object: ctx.runtime.objects.automations.singleton(),
    execution: createBackofficeSystemExecution({ kind: "system" }),
  }).getInternalInstance({
    workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
    instanceId: result.workflowInstanceId,
  });
}

async function publicationRequest(
  ctx: BackofficeScenarioContext,
  result: MarketplacePublishResult,
) {
  const instance = await publicationStatus(ctx, result);
  const params = instance.meta.params as { request: unknown };
  return marketplacePackagePublishRequestSchema.parse(params.request);
}

describe("Marketplace package publication scenarios", () => {
  test("publishes a frozen binary-capable snapshot through codemode and installs the exact artifact", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<{ publication: MarketplacePublishResult | null }>({
        objects: scenarioObjects,
        name: "Workspace package snapshot publication and installation",
        vars: () => ({ publication: null }),
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
        ],
        steps: ({ then, runner }) => [
          then.assert("capture the package through the registered codemode tool", async (ctx) => {
            const state = sourceState(ctx, ORG_SCOPE);
            await seedPackage(state, {
              name: "@ada-labs/durable-package",
              version: "1.0.0",
              readme: "Original README",
              files: ["README.md", "automations/", "assets/"],
            });
            await state.writeFile(
              `${PACKAGE_ROOT}/assets/page.html`,
              "<script>throw new Error('Publishing cannot execute HTML');</script>",
            );
            await state.writeFile("/workspace/unselected.txt", "not part of the package");
            const run = await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: `async () => await marketplace.publish({ packageRoot: '${PACKAGE_ROOT}/' })`,
              assertToolCalls: ["marketplace.publish"],
            });
            const publication = marketplacePublishResultSchema.parse(run.result);
            expect(publication).toMatchObject({
              state: "requested",
              name: "@ada-labs/durable-package",
              listingId: LISTING_ID,
              version: "1.0.0",
              owner: { scope: ORG_SCOPE, publisherName: "Ada Labs" },
              workflowScope: { kind: "system" },
            });
            expect(publication.files.map((file) => file.relativePath)).toEqual([
              "README.md",
              "assets/page.html",
              "assets/payload.bin",
              "automations/report.workflow.js",
              "manifest.json",
            ]);
            ctx.vars.publication = publication;
            assert(publication.state === "requested");
            await expect(
              ctx.runtime.objects.marketplace
                .singleton()
                .commands.completePackagePublish(await publicationRequest(ctx, publication), {
                  execution: createBackofficeSystemExecution({ kind: "system" }),
                  propagationContext: null,
                }),
            ).rejects.toThrow("Marketplace artifact snapshot is incomplete");
            await expect(
              ctx.runtime.objects.marketplace
                .singleton()
                .commands.getPublishedListing({ listingId: LISTING_ID }),
            ).resolves.toBeNull();
            await expect(
              state.readFileBytes(`${PACKAGE_ROOT}/assets/payload.bin`, 3),
            ).rejects.toThrow("3 byte read limit");
            await state.writeFile(`${PACKAGE_ROOT}/README.md`, "Changed after acceptance");
          }),
          runner.restartObject({ binding: "AUTOMATIONS", scope: { kind: "singleton" } }),
          runner.drain(),
          then.assert(
            "only the accepted bytes become visible in registry and file previews",
            async (ctx) => {
              assert(ctx.vars.publication);
              assert(
                (await publicationStatus(ctx, ctx.vars.publication)).details.status === "complete",
              );
              const manifest = await publishedManifest(ctx);
              const readme = await artifactFile(ctx, manifest, "README.md");
              await expect(readme.text()).resolves.toBe("Original README");
              const html = await artifactFile(ctx, manifest, "assets/page.html");
              expect(html.headers.get("content-security-policy")).toContain(
                "sandbox; default-src 'none'",
              );
              assert(html.headers.get("x-content-type-options") === "nosniff");
              await expect(html.text()).resolves.toContain("<script>");
              const binary = await artifactFile(ctx, manifest, "assets/payload.bin");
              expect(new Uint8Array(await binary.arrayBuffer())).toEqual(BINARY);
              const explorer = await loadPublishedMarketplaceArtifactExplorer({
                manifest,
                objects: ctx.runtime.objects,
                request: new Request("https://backoffice.test/marketplace/package"),
              });
              assert(explorer.state === "ready");
              expect(explorer.fileTree.entries.map((entry) => entry.path)).toContain(
                "1.0.0/manifest.json",
              );
              const discovery = await ctx.runCodemode({
                scope: ORG_SCOPE,
                code: "async () => await marketplace.search({ query: 'Durable package' })",
              });
              expect(discovery.result).toMatchObject({
                listings: [
                  { listingId: LISTING_ID, publisherName: "Ada Labs", latestVersion: "1.0.0" },
                ],
              });
              await ctx.runCodemode({
                scope: ORG_SCOPE,
                code: `async () => await packages.install({ listingId: '${LISTING_ID}', installationRoot: '/workspace/installed-report' })`,
              });
            },
          ),
          runner.drain(),
          then.assert("installation retains the existing workspace lock semantics", async (ctx) => {
            const state = sourceState(ctx, ORG_SCOPE);
            await expect(state.readFile("/workspace/installed-report/README.md")).resolves.toBe(
              "Original README",
            );
            expect(
              await state.readFileBytes("/workspace/installed-report/assets/payload.bin"),
            ).toEqual(BINARY);
            expect(await state.readJson("/workspace/marketplace-lock.json")).toEqual({
              entries: [
                {
                  listingId: LISTING_ID,
                  version: "1.0.0",
                  installationRoot: "/workspace/installed-report",
                },
              ],
            });
            await state.writeFile(`${PACKAGE_ROOT}/README.md`, "Original README");
            const repeat = await publishFromShell(
              publisherShell(ctx, createBackofficeSystemExecution(ORG_SCOPE)),
              "",
            );
            assert(repeat.state === "published");
            assert(ctx.vars.publication?.state !== "preview");
            assert(repeat.workflowInstanceId === ctx.vars.publication?.workflowInstanceId);
          }),
        ],
      }),
    );
  });

  test.each(["deferred", "request"] as const)(
    "ordinary members publish from personal workspaces with truthful %s provenance and write-free dry runs",
    async (executionKind) => {
      const USER_SCOPE = { kind: "user", userId: "member-1" } as const;
      await runBackofficeScenario(
        defineBackofficeScenario<{ publication: MarketplacePublishResult | null }>({
          objects: scenarioObjects,
          name: "Organization ownership is separate from personal source and publishing actor",
          vars: () => ({ publication: null }),
          setup: ({ given }) => [
            given.organization.exists({
              id: "org-1",
              slug: "ada-labs",
              name: "Ada Labs",
              ownerUserId: "owner-1",
            }),
            given.auth.user({ id: "member-1" }),
            given.auth.member({ orgId: "org-1", userId: "member-1", roles: ["member"] }),
          ],
          steps: ({ then, runner }) => [
            then.assert("preview validates without creating a registry listing", async (ctx) => {
              await seedPackage(sourceState(ctx, USER_SCOPE), {
                name: "@ada-labs/durable-package",
                version: "1.0.0",
                readme: "Member package",
                files: ["README.md"],
              });
              const execution =
                executionKind === "request"
                  ? createBackofficeRequestExecution({
                      scope: USER_SCOPE,
                      userId: "member-1",
                      verifiedRequestAuthority: {
                        role: "user",
                        organizationId: null,
                        expiresAt: new Date(Date.now() + 60_000),
                        scopeRestriction: USER_SCOPE,
                      },
                    })
                  : createBackofficeUserExecution({
                      scope: USER_SCOPE,
                      userId: "member-1",
                    });
              const bash = publisherShell(ctx, execution);
              const preview = await publishFromShell(bash, "--dry-run");
              assert(preview.state === "preview");
              await expect(
                ctx.runtime.objects.marketplace
                  .singleton()
                  .commands.getArtifactManifest({ listingId: LISTING_ID }),
              ).resolves.toBeNull();
              const help = await bash.exec("marketplace.publish --help");
              expect(help.stdout).toContain("--skip-author-check");
              expect(help.stdout).toContain("--skip-version-check");
              ctx.vars.publication = await publishFromShell(bash, "");
              assert(ctx.vars.publication.state === "requested");
              const stored = await publicationRequest(ctx, ctx.vars.publication);
              expect(stored?.intent.execution).toEqual({
                kind: "deferred",
                scope: USER_SCOPE,
                scopeRestriction: executionKind === "request" ? USER_SCOPE : null,
                actors: execution.actors,
              });
              expect(stored?.intent.release.owner).toEqual({
                scope: ORG_SCOPE,
                publisherName: "Ada Labs",
              });
              assert(stored);
              assert(!stored.intent.skipAuthorCheck);
              assert(!stored.intent.skipVersionCheck);
            }),
            runner.drain(),
            then.assert(
              "member publication completes on System without becoming System-authored",
              async (ctx) => {
                assert(ctx.vars.publication?.state === "requested");
                assert(
                  (await publicationStatus(ctx, ctx.vars.publication)).details.status ===
                    "complete",
                );
                const stored = await publicationRequest(ctx, ctx.vars.publication);
                assert(stored.intent.execution.actors.principal?.id === "member-1");
                expect(await publishedManifest(ctx)).toMatchObject({ versions: ["1.0.0"] });
              },
            ),
          ],
        }),
      );
    },
  );

  test("rejects non-members and every non-System override before staging a publication", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Publishing permission does not grant ownership or System overrides",
        setup: ({ given }) => [
          given.organization.exists({
            id: "org-1",
            slug: "ada-labs",
            name: "Ada Labs",
            ownerUserId: "owner-1",
          }),
          given.organization.exists({
            id: "org-2",
            slug: "other-labs",
            name: "Other Labs",
            ownerUserId: "other-1",
          }),
        ],
        steps: ({ then }) => [
          then.assert("normal permissions cannot impersonate another organization", async (ctx) => {
            const state = sourceState(ctx, ORG_SCOPE);
            await seedPackage(state, {
              name: "@other-labs/durable-package",
              version: "1.0.0",
              readme: "Not ours",
              files: ["README.md"],
            });
            const bash = publisherShell(
              ctx,
              createBackofficeUserExecution({ scope: ORG_SCOPE, userId: "owner-1" }),
            );
            const denied = await bash.exec(`marketplace.publish --package-root ${PACKAGE_ROOT}`);
            assert(denied.exitCode !== 0);
            expect(denied.stderr).toContain("membership in the owning organization");
            for (const flag of [
              "--skip-author-check",
              "--skip-version-check",
              "--skip-author-check --skip-version-check",
            ]) {
              const override = await bash.exec(
                `marketplace.publish --package-root ${PACKAGE_ROOT} ${flag}`,
              );
              assert(override.exitCode !== 0);
              expect(override.stderr).toContain("overrides require System context");
            }
            await state.writeFile(
              `${PACKAGE_ROOT}/manifest.json`,
              JSON.stringify({
                name: "@missing-labs/durable-package",
                version: "1.0.0",
                metadata: METADATA,
                files: ["README.md"],
              }),
            );
            const missing = await systemPublisher(ctx, state).exec(
              `marketplace.publish --package-root ${PACKAGE_ROOT} --skip-author-check`,
            );
            assert(missing.exitCode !== 0);
            expect(missing.stderr).toContain("was not found");
            await expect(
              ctx.runtime.objects.marketplace
                .singleton()
                .commands.getArtifactManifest({ listingId: "org:org-2#durable-package" }),
            ).resolves.toBeNull();
          }),
        ],
      }),
    );
  });

  test("System overrides replace complete version directories without changing installed copies", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<{ pinned: MarketplaceArtifactManifest | null }>({
        objects: scenarioObjects,
        name: "System publishes older releases and atomic replacements",
        vars: () => ({ pinned: null }),
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
        ],
        steps: ({ then, runner }) => [
          then.assert("System still needs the author override", async (ctx) => {
            const state = sourceState(ctx, ORG_SCOPE);
            await seedPackage(state, {
              name: "@ada-labs/durable-package",
              version: "2.0.0",
              readme: "Original release",
              files: ["README.md", "assets/"],
            });
            const bash = systemPublisher(ctx, state);
            const denied = await bash.exec(
              `marketplace.publish --package-root ${PACKAGE_ROOT} --skip-version-check`,
            );
            assert(denied.exitCode !== 0);
            expect(denied.stderr).toContain("membership in the owning organization");
            await publishFromShell(bash, "--skip-author-check");
          }),
          runner.drain(),
          then.assert(
            "install the initial release and reject a version rollback without its override",
            async (ctx) => {
              ctx.vars.pinned = await publishedManifest(ctx);
              await ctx.runCodemode({
                scope: ORG_SCOPE,
                code: `async () => await packages.install({ listingId: '${LISTING_ID}', version: '2.0.0', installationRoot: '/workspace/existing' })`,
              });
              const state = sourceState(ctx, ORG_SCOPE);
              await seedPackage(state, {
                name: "@ada-labs/durable-package",
                version: "1.0.0",
                readme: "Backfill",
                files: ["README.md"],
              });
              const bash = systemPublisher(ctx, state);
              const denied = await bash.exec(
                `marketplace.publish --package-root ${PACKAGE_ROOT} --skip-author-check`,
              );
              assert(denied.exitCode !== 0);
              expect(denied.stderr).toContain("cannot become the latest published version");
              await publishFromShell(bash, "--skip-author-check --skip-version-check");
            },
          ),
          runner.drain(),
          then.assert("backfilling does not move latest backwards", async (ctx) => {
            const listing = await ctx.runtime.objects.marketplace
              .singleton()
              .commands.getPublishedListing({ listingId: LISTING_ID });
            assert(listing?.listing.latestVersion === "2.0.0");
            expect((await publishedManifest(ctx)).versions).toEqual(["2.0.0", "1.0.0"]);
            const state = sourceState(ctx, ORG_SCOPE);
            await seedPackage(state, {
              name: "@ada-labs/durable-package",
              version: "2.0.0",
              readme: "Replacement release",
              files: ["README.md"],
            });
            const bash = systemPublisher(ctx, state);
            const denied = await bash.exec(
              `marketplace.publish --package-root ${PACKAGE_ROOT} --skip-author-check`,
            );
            assert(denied.exitCode !== 0);
            await publishFromShell(bash, "--skip-author-check --skip-version-check");
            const stillOld = await artifactFile(
              ctx,
              await publishedManifest(ctx),
              "README.md",
              "2.0.0",
            );
            await expect(stillOld.text()).resolves.toBe("Original release");
          }),
          runner.drain(),
          then.assert(
            "replacement removes absent files, changes fresh reads, and leaves installed copies untouched",
            async (ctx) => {
              const manifest = await publishedManifest(ctx);
              await expect(
                (await artifactFile(ctx, manifest, "README.md", "2.0.0")).text(),
              ).resolves.toBe("Replacement release");
              assert(
                (await artifactFile(ctx, manifest, "assets/payload.bin", "2.0.0")).status === 404,
              );
              assert(ctx.vars.pinned);
              await expect(
                (await artifactFile(ctx, ctx.vars.pinned, "README.md", "2.0.0")).text(),
              ).resolves.toBe("Replacement release");
              const explorer = await loadPublishedMarketplaceArtifactExplorer({
                manifest,
                objects: ctx.runtime.objects,
                request: new Request("https://backoffice.test/marketplace/package"),
              });
              assert(explorer.state === "ready");
              expect(explorer.fileTree.entries.map((entry) => entry.path)).not.toContain(
                "2.0.0/assets/payload.bin",
              );
              const state = sourceState(ctx, ORG_SCOPE);
              await expect(state.readFile("/workspace/existing/README.md")).resolves.toBe(
                "Original release",
              );
              expect(await state.readFileBytes("/workspace/existing/assets/payload.bin")).toEqual(
                BINARY,
              );
              expect(await state.readJson("/workspace/marketplace-lock.json")).toEqual({
                entries: [
                  {
                    listingId: LISTING_ID,
                    version: "2.0.0",
                    installationRoot: "/workspace/existing",
                  },
                ],
              });
            },
          ),
        ],
      }),
    );
  });

  test("a lost catalog response survives restart and cannot replay over a newer replacement", async () => {
    let loseResponse = true;
    await runBackofficeScenario(
      defineBackofficeScenario<{
        first: MarketplacePublishResult | null;
        second: MarketplacePublishResult | null;
      }>({
        name: "Superseded publication retries cannot roll back replacement",
        vars: () => ({ first: null, second: null }),
        options: { allowErroredWorkflows: true },
        objects: {
          ...scenarioObjects,
          MARKETPLACE: ({ state, env, runtime, implementation }) =>
            new (class extends InMemoryMarketplaceObject {
              override async completePackagePublish(
                ...args: Parameters<InMemoryMarketplaceObject["completePackagePublish"]>
              ) {
                const result = await super.completePackagePublish(...args);
                if (loseResponse) {
                  loseResponse = false;
                  throw new Error("Catalog commit response was lost.");
                }
                return result;
              }
            })({ state, env, runtime, implementation }),
        },
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
        ],
        steps: ({ then, runner, when }) => [
          then.assert("submit the first release", async (ctx) => {
            const state = sourceState(ctx, ORG_SCOPE);
            await seedPackage(state, {
              name: "@ada-labs/durable-package",
              version: "1.0.0",
              readme: "First snapshot",
              files: ["README.md"],
            });
            ctx.vars.first = await publishFromShell(
              systemPublisher(ctx, state),
              "--skip-author-check",
            );
          }),
          runner.drain(),
          then.assert(
            "the first release is committed despite its waiting workflow",
            async (ctx) => {
              assert(ctx.vars.first);
              assert((await publicationStatus(ctx, ctx.vars.first)).details.status === "waiting");
              await expect(
                (await artifactFile(ctx, await publishedManifest(ctx), "README.md")).text(),
              ).resolves.toBe("First snapshot");
              const state = sourceState(ctx, ORG_SCOPE);
              await state.writeFile(`${PACKAGE_ROOT}/README.md`, "Second snapshot");
              ctx.vars.second = await publishFromShell(
                systemPublisher(ctx, state),
                "--skip-author-check --skip-version-check",
              );
            },
          ),
          runner.drain(),
          runner.restartObject({ binding: "AUTOMATIONS", scope: { kind: "singleton" } }),
          when.time.advance("1 s"),
          then.assert(
            "superseded publication fails instead of restoring its older files",
            async (ctx) => {
              assert(ctx.vars.first && ctx.vars.second);
              assert((await publicationStatus(ctx, ctx.vars.first)).details.status === "errored");
              assert((await publicationStatus(ctx, ctx.vars.second)).details.status === "complete");
              const manifest = await publishedManifest(ctx);
              await expect((await artifactFile(ctx, manifest, "README.md")).text()).resolves.toBe(
                "Second snapshot",
              );
              assert(ctx.vars.second.state !== "preview");
              expect(manifest.uploadName).toBe(marketplaceArtifactUploadName(LISTING_ID));
            },
          ),
        ],
      }),
    );
  });

  test("identical concurrent requests deduplicate and replay after a full workflow restart", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<{ publications: MarketplacePublishResult[] }>({
        objects: scenarioObjects,
        name: "Identical captured requests share a durable workflow",
        vars: () => ({ publications: [] }),
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
        ],
        steps: ({ then, runner }) => [
          then.assert(
            "submit two identical snapshots before either becomes public",
            async (ctx) => {
              const state = sourceState(ctx, ORG_SCOPE);
              await seedPackage(state, {
                name: "@ada-labs/durable-package",
                version: "1.0.0",
                readme: "Identical snapshot",
                files: ["README.md"],
              });
              const bash = publisherShell(ctx, createBackofficeSystemExecution(ORG_SCOPE));
              ctx.vars.publications = [
                await publishFromShell(bash, ""),
                await publishFromShell(bash, ""),
              ];
              assert(
                ctx.vars.publications.every((publication) => publication.state === "requested"),
              );
            },
          ),
          runner.drain(),
          then.assert(
            "both requests identify the same committed workflow and deterministic storage",
            async (ctx) => {
              const manifest = await publishedManifest(ctx);
              const execution = createBackofficeSystemExecution({ kind: "system" });
              const marketplace = ctx.runtime.objects.marketplace.singleton().commands;
              const first = ctx.vars.publications[0];
              assert(first.state !== "preview");
              for (const result of ctx.vars.publications) {
                assert(result.state !== "preview");
                assert((await publicationStatus(ctx, result)).details.status === "complete");
                expect(result.workflowInstanceId).toBe(first.workflowInstanceId);
                expect(manifest.uploadName).toBe(marketplaceArtifactUploadName(LISTING_ID));
                await marketplace.completePackagePublish(await publicationRequest(ctx, result), {
                  execution,
                  propagationContext: null,
                });
              }
              const result = ctx.vars.publications[0];
              assert(result.state !== "preview");
              const routes = createWorkflowsRouteCaller({
                object: ctx.runtime.objects.automations.singleton(),
                context: { execution, propagationContext: null },
              });
              const response = await routes(
                "POST",
                "/:workflowName/instances/:instanceId/restart",
                {
                  pathParams: {
                    workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
                    instanceId: result.workflowInstanceId,
                  },
                },
              );
              assert(response.type === "json");
            },
          ),
          runner.drain(),
          then.assert(
            "restart recognizes the current published version without rewriting it",
            async (ctx) => {
              assert(
                (await publicationStatus(ctx, ctx.vars.publications[0])).details.status ===
                  "complete",
              );
              await expect(
                (await artifactFile(ctx, await publishedManifest(ctx), "README.md")).text(),
              ).resolves.toBe("Identical snapshot");
            },
          ),
        ],
      }),
    );
  });

  test.each(["bytes", "inventory"] as const)(
    "rejects %s changes during capture before publication acceptance",
    async (mutation) => {
      let mutate = true;
      await runBackofficeScenario(
        defineBackofficeScenario({
          name: `Capture detects concurrent ${mutation} changes`,
          objects: {
            ...scenarioObjects,
            UPLOAD: ({ state, env, runtime, implementation }) =>
              new (class extends InMemoryUploadObject {
                override async fetch(request: Request): Promise<Response> {
                  const response = await super.fetch(request);
                  const url = new URL(request.url);
                  if (
                    mutate &&
                    request.method === "GET" &&
                    url.pathname.endsWith("/files/by-key/content") &&
                    url.searchParams.get("key") === "packages/report/README.md"
                  ) {
                    mutate = false;
                    const fileKey =
                      mutation === "bytes"
                        ? "packages/report/README.md"
                        : "packages/report/assets/late.txt";
                    const bytes = new TextEncoder().encode("Changed README!");
                    const form = new FormData();
                    form.set("provider", "database");
                    form.set("fileKey", fileKey);
                    form.set(
                      "checksum",
                      JSON.stringify({ algo: "sha256", value: await sha256Hex(bytes) }),
                    );
                    form.set(
                      "file",
                      new File([bytes], fileKey.split("/").at(-1) ?? "late.txt", {
                        type: "text/plain",
                      }),
                    );
                    const write = await super.fetch(
                      new Request(new URL("/api/upload/files", request.url), {
                        method: "POST",
                        body: form,
                      }),
                    );
                    assert(write.ok);
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
          setup: ({ given }) => [
            given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
          ],
          steps: ({ then }) => [
            then.assert(
              "an unstable source is rejected and the catalog stays untouched",
              async (ctx) => {
                await seedPackage(sourceState(ctx, ORG_SCOPE), {
                  name: "@ada-labs/durable-package",
                  version: "1.0.0",
                  readme: "Original README",
                  files: ["README.md", "assets/"],
                });
                const result = await publisherShell(
                  ctx,
                  createBackofficeSystemExecution(ORG_SCOPE),
                ).exec(`marketplace.publish --package-root ${PACKAGE_ROOT}`);
                assert(result.exitCode !== 0);
                expect(result.stderr).toMatch(/changed during capture|file selection changed/u);
                assert(!mutate);
                await expect(
                  ctx.runtime.objects.marketplace
                    .singleton()
                    .commands.getArtifactManifest({ listingId: LISTING_ID }),
                ).resolves.toBeNull();
              },
            ),
          ],
        }),
      );
    },
  );

  test("lost upload responses and a checkpoint-discarding restart publish the captured bytes once", async () => {
    let fault: "creation" | "transfer" | "commit" | null = "creation";
    let uploadCreations = 0;
    await runBackofficeScenario(
      defineBackofficeScenario<{
        publication: MarketplacePublishResult | null;
        creationsBeforeRestart: number;
      }>({
        name: "Upload response loss and full publication restart",
        vars: () => ({ publication: null, creationsBeforeRestart: 0 }),
        objects: {
          ...scenarioObjects,
          UPLOAD: ({ state, env, runtime, implementation }) =>
            new (class extends InMemoryUploadObject {
              override async fetch(request: Request): Promise<Response> {
                const path = new URL(request.url).pathname;
                const stage =
                  request.method === "POST" && path.endsWith("/uploads")
                    ? "creation"
                    : request.method === "PUT" && path.endsWith("/content")
                      ? "transfer"
                      : request.method === "POST" && path.endsWith("/files/commit-prepared")
                        ? "commit"
                        : null;
                if (stage === "creation") {
                  uploadCreations += 1;
                }
                const response = await super.fetch(request);
                if (stage !== null && stage === fault && response.ok) {
                  fault =
                    stage === "creation" ? "transfer" : stage === "transfer" ? "commit" : null;
                  throw new Error(`Marketplace ${stage} response was lost.`);
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
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
        ],
        steps: ({ then, runner, when }) => [
          then.assert("request a captured release", async (ctx) => {
            const state = sourceState(ctx, ORG_SCOPE);
            await seedPackage(state, {
              name: "@ada-labs/durable-package",
              version: "1.0.0",
              readme: "Frozen through upload failures",
              files: ["README.md"],
            });
            ctx.vars.publication = await publishFromShell(
              publisherShell(ctx, createBackofficeSystemExecution(ORG_SCOPE)),
              "",
            );
            await state.writeFile(
              `${PACKAGE_ROOT}/README.md`,
              "Edited while upload responses are lost",
            );
          }),
          runner.drain(),
          runner.restartObject({ binding: "AUTOMATIONS", scope: { kind: "singleton" } }),
          when.time.advance("1 s"),
          runner.restartObject({ binding: "AUTOMATIONS", scope: { kind: "singleton" } }),
          when.time.advance("1 s"),
          then.assert(
            "committed files remain outside the published catalog while their response is lost",
            async (ctx) => {
              assert(ctx.vars.publication?.state === "requested");
              assert(
                (await publicationStatus(ctx, ctx.vars.publication)).details.status === "waiting",
              );
              await expect(
                ctx.runtime.objects.marketplace
                  .singleton()
                  .commands.getPublishedListing({ listingId: LISTING_ID }),
              ).resolves.toBeNull();
              ctx.vars.creationsBeforeRestart = uploadCreations;
              const execution = createBackofficeSystemExecution({ kind: "system" });
              const routes = createWorkflowsRouteCaller({
                object: ctx.runtime.objects.automations.singleton(),
                context: { execution, propagationContext: null },
              });
              const response = await routes(
                "POST",
                "/:workflowName/instances/:instanceId/restart",
                {
                  pathParams: {
                    workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
                    instanceId: ctx.vars.publication.workflowInstanceId,
                  },
                },
              );
              assert(response.type === "json");
            },
          ),
          runner.restartObject({ binding: "AUTOMATIONS", scope: { kind: "singleton" } }),
          runner.drain(),
          then.assert(
            "restart recognizes committed bytes instead of uploading or changing them",
            async (ctx) => {
              assert(ctx.vars.publication);
              assert(
                (await publicationStatus(ctx, ctx.vars.publication)).details.status === "complete",
              );
              assert(fault === null);
              assert(uploadCreations === ctx.vars.creationsBeforeRestart);
              await expect(
                (await artifactFile(ctx, await publishedManifest(ctx), "README.md")).text(),
              ).resolves.toBe("Frozen through upload failures");
            },
          ),
        ],
      }),
    );
  });

  test("concurrent System replacements still enforce release revision checks", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<{
        first: MarketplacePublishResult | null;
        second: MarketplacePublishResult | null;
      }>({
        objects: scenarioObjects,
        name: "Publishing overrides do not bypass optimistic concurrency",
        vars: () => ({ first: null, second: null }),
        options: { allowErroredWorkflows: true },
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
        ],
        steps: ({ then, runner }) => [
          then.assert("publish the base version", async (ctx) => {
            const state = sourceState(ctx, ORG_SCOPE);
            await seedPackage(state, {
              name: "@ada-labs/durable-package",
              version: "1.0.0",
              readme: "Base snapshot",
              files: ["README.md"],
            });
            await publishFromShell(systemPublisher(ctx, state), "--skip-author-check");
          }),
          runner.drain(),
          then.assert(
            "submit two different replacements against the same revision",
            async (ctx) => {
              const state = sourceState(ctx, ORG_SCOPE);
              const bash = systemPublisher(ctx, state);
              await state.writeFile(`${PACKAGE_ROOT}/README.md`, "First replacement");
              ctx.vars.first = await publishFromShell(
                bash,
                "--skip-author-check --skip-version-check",
              );
              await state.writeFile(`${PACKAGE_ROOT}/README.md`, "Second replacement");
              ctx.vars.second = await publishFromShell(
                bash,
                "--skip-author-check --skip-version-check",
              );
            },
          ),
          runner.drain(),
          then.assert("exactly one replacement becomes visible", async (ctx) => {
            assert(ctx.vars.first && ctx.vars.second);
            const instances = await Promise.all([
              publicationStatus(ctx, ctx.vars.first),
              publicationStatus(ctx, ctx.vars.second),
            ]);
            expect(instances.map((instance) => instance.details.status).sort()).toEqual([
              "complete",
              "errored",
            ]);
            const failed = instances.find((instance) => instance.details.status === "errored");
            expect(failed?.details.error?.message).toContain(
              "changed after publication was prepared",
            );
            const content = await (
              await artifactFile(ctx, await publishedManifest(ctx), "README.md")
            ).text();
            assert(content === "First replacement" || content === "Second replacement");
          }),
        ],
      }),
    );
  });

  test("destination revision conflicts reject all replacement writes and deletions", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<{ replacement: MarketplacePublishResult | null }>({
        objects: scenarioObjects,
        name: "Frozen destination revisions guard the complete replacement batch",
        vars: () => ({ replacement: null }),
        options: { allowErroredWorkflows: true },
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
        ],
        steps: ({ then, runner }) => [
          then.assert("publish the original version", async (ctx) => {
            const state = sourceState(ctx, ORG_SCOPE);
            await seedPackage(state, {
              name: "@ada-labs/durable-package",
              version: "1.0.0",
              readme: "Original README",
              files: ["README.md", "assets/"],
            });
            await publishFromShell(systemPublisher(ctx, state), "--skip-author-check");
          }),
          runner.drain(),
          then.assert(
            "capture a replacement, then change one destination outside the publishing workflow",
            async (ctx) => {
              const state = sourceState(ctx, ORG_SCOPE);
              await seedPackage(state, {
                name: "@ada-labs/durable-package",
                version: "1.0.0",
                readme: "Replacement README",
                files: ["README.md"],
              });
              ctx.vars.replacement = await publishFromShell(
                systemPublisher(ctx, state),
                "--skip-author-check --skip-version-check",
              );
              const artifactState = createBackofficeStateBackend({
                uploadObject: ctx.runtime.objects.upload.forName(
                  marketplaceArtifactUploadName(LISTING_ID),
                ).http,
                staticFileCollection: createStaticFileCollection({}),
              });
              await artifactState.writeFile(
                "/workspace/1.0.0/README.md",
                "Concurrent destination edit",
              );
            },
          ),
          runner.drain(),
          then.assert("a stale write cannot partially publish or delete old files", async (ctx) => {
            assert(ctx.vars.replacement);
            const instance = await publicationStatus(ctx, ctx.vars.replacement);
            assert(instance.details.status === "errored");
            expect(instance.details.error?.message).toContain(
              "version files changed after publication was prepared",
            );
            const manifest = await publishedManifest(ctx);
            await expect((await artifactFile(ctx, manifest, "README.md")).text()).resolves.toBe(
              "Concurrent destination edit",
            );
            expect(
              new Uint8Array(
                await (await artifactFile(ctx, manifest, "assets/payload.bin")).arrayBuffer(),
              ),
            ).toEqual(BINARY);
            const oldManifest = marketplacePackageManifestSchema.parse(
              await (await artifactFile(ctx, manifest, "manifest.json")).json(),
            );
            expect(oldManifest.files).toEqual(["README.md", "assets/"]);
            const state = sourceState(ctx, ORG_SCOPE);
            ctx.vars.replacement = await publishFromShell(
              systemPublisher(ctx, state),
              "--skip-author-check --skip-version-check",
            );
          }),
          runner.drain(),
          then.assert(
            "a new request captures fresh destination revisions and replaces the whole version",
            async (ctx) => {
              assert(ctx.vars.replacement);
              assert(
                (await publicationStatus(ctx, ctx.vars.replacement)).details.status === "complete",
              );
              const manifest = await publishedManifest(ctx);
              await expect((await artifactFile(ctx, manifest, "README.md")).text()).resolves.toBe(
                "Replacement README",
              );
              assert((await artifactFile(ctx, manifest, "assets/payload.bin")).status === 404);
            },
          ),
        ],
      }),
    );
  });

  test("failed prepared replacements leave the old files readable and release the version for a new request", async () => {
    let loseTransfers = false;
    await runBackofficeScenario(
      defineBackofficeScenario<{
        abandoned: MarketplacePublishResult | null;
        replacement: MarketplacePublishResult | null;
      }>({
        name: "Prepared replacement failure, recovery, and superseded full restart",
        vars: () => ({ abandoned: null, replacement: null }),
        options: { allowErroredWorkflows: true },
        objects: {
          ...scenarioObjects,
          UPLOAD: ({ state, env, runtime, implementation }) =>
            new (class extends InMemoryUploadObject {
              override async fetch(request: Request): Promise<Response> {
                const response = await super.fetch(request);
                if (
                  loseTransfers &&
                  request.method === "PUT" &&
                  new URL(request.url).pathname.endsWith("/content") &&
                  response.ok
                ) {
                  throw new Error("Prepared replacement transfer response was lost.");
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
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
        ],
        steps: ({ then, runner, when }) => [
          then.assert("publish the original file set", async (ctx) => {
            const state = sourceState(ctx, ORG_SCOPE);
            await seedPackage(state, {
              name: "@ada-labs/durable-package",
              version: "1.0.0",
              readme: "Original file set",
              files: ["README.md", "assets/"],
            });
            await publishFromShell(systemPublisher(ctx, state), "--skip-author-check");
          }),
          runner.drain(),
          then.assert(
            "prepare a replacement whose transfer responses never arrive",
            async (ctx) => {
              const state = sourceState(ctx, ORG_SCOPE);
              await seedPackage(state, {
                name: "@ada-labs/durable-package",
                version: "1.0.0",
                readme: "Abandoned replacement",
                files: ["README.md"],
              });
              ctx.vars.abandoned = await publishFromShell(
                systemPublisher(ctx, state),
                "--skip-author-check --skip-version-check",
              );
              loseTransfers = true;
            },
          ),
          runner.drain(),
          then.assert("prepared writes and pending deletions are not visible", async (ctx) => {
            assert(ctx.vars.abandoned);
            assert((await publicationStatus(ctx, ctx.vars.abandoned)).details.status === "waiting");
            const repeated = await publishFromShell(
              systemPublisher(ctx, sourceState(ctx, ORG_SCOPE)),
              "--skip-author-check --skip-version-check",
            );
            assert(repeated.state === "requested" && ctx.vars.abandoned.state !== "preview");
            expect(repeated.workflowInstanceId).toBe(ctx.vars.abandoned.workflowInstanceId);
            const manifest = await publishedManifest(ctx);
            await expect((await artifactFile(ctx, manifest, "README.md")).text()).resolves.toBe(
              "Original file set",
            );
            expect(
              new Uint8Array(
                await (await artifactFile(ctx, manifest, "assets/payload.bin")).arrayBuffer(),
              ),
            ).toEqual(BINARY);
          }),
          when.time.advance("1 s"),
          when.time.advance("2 s"),
          when.time.advance("4 s"),
          then.assert("terminal failure permits a fresh replacement request", async (ctx) => {
            assert(ctx.vars.abandoned);
            assert((await publicationStatus(ctx, ctx.vars.abandoned)).details.status === "errored");
            await expect(
              (await artifactFile(ctx, await publishedManifest(ctx), "README.md")).text(),
            ).resolves.toBe("Original file set");
            loseTransfers = false;
            const state = sourceState(ctx, ORG_SCOPE);
            await state.writeFile(`${PACKAGE_ROOT}/README.md`, "Successful replacement");
            ctx.vars.replacement = await publishFromShell(
              systemPublisher(ctx, state),
              "--skip-author-check --skip-version-check",
            );
          }),
          runner.drain(),
          then.assert(
            "the new workflow replaces the whole version, then restart the abandoned workflow",
            async (ctx) => {
              assert(ctx.vars.abandoned?.state !== "preview" && ctx.vars.abandoned);
              assert(ctx.vars.replacement);
              assert(
                (await publicationStatus(ctx, ctx.vars.replacement)).details.status === "complete",
              );
              const manifest = await publishedManifest(ctx);
              await expect((await artifactFile(ctx, manifest, "README.md")).text()).resolves.toBe(
                "Successful replacement",
              );
              assert((await artifactFile(ctx, manifest, "assets/payload.bin")).status === 404);
              const routes = createWorkflowsRouteCaller({
                object: ctx.runtime.objects.automations.singleton(),
                context: {
                  execution: createBackofficeSystemExecution({ kind: "system" }),
                  propagationContext: null,
                },
              });
              const response = await routes(
                "POST",
                "/:workflowName/instances/:instanceId/restart",
                {
                  pathParams: {
                    workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
                    instanceId: ctx.vars.abandoned.workflowInstanceId,
                  },
                },
              );
              assert(response.type === "json");
            },
          ),
          runner.drain(),
          then.assert("the superseded full restart cannot restore abandoned files", async (ctx) => {
            assert(ctx.vars.abandoned);
            const instance = await publicationStatus(ctx, ctx.vars.abandoned);
            assert(instance.details.status === "errored");
            expect(instance.details.error?.message).toContain(
              "changed after publication was prepared",
            );
            await expect(
              (await artifactFile(ctx, await publishedManifest(ctx), "README.md")).text(),
            ).resolves.toBe("Successful replacement");
          }),
        ],
      }),
    );
  });

  test.each([
    { phase: "reservation", lookup: 1, stepName: "begin marketplace package publication" },
    { phase: "commit", lookup: 2, stepName: "commit marketplace artifact files" },
    { phase: "finalization", lookup: 3, stepName: "publish marketplace package release" },
  ])(
    "retries a temporary Auth outage during $phase and completes publication",
    async ({ phase, lookup, stepName }) => {
      const userScope = { kind: "user", userId: "member-1" } as const;
      let publicationAccepted = false;
      let authorityLookups = 0;
      await runBackofficeScenario(
        defineBackofficeScenario<{ publication: MarketplacePublishResult | null }>({
          name: `Temporary Auth outage during publication ${phase}`,
          vars: () => ({ publication: null }),
          objects: {
            ...scenarioObjects,
            AUTH: ({ state, env, runtime, getAuthDatabase }) =>
              new (class extends InMemoryAuthObject {
                override async getUserAuthorityFacts(
                  input: Parameters<InMemoryAuthObject["getUserAuthorityFacts"]>[0],
                ) {
                  if (publicationAccepted && ++authorityLookups === lookup) {
                    throw new Error("Temporary Auth authority lookup failure.");
                  }
                  return super.getUserAuthorityFacts(input);
                }
              })({ state, env: env as never, runtime, database: getAuthDatabase() }),
          },
          setup: ({ given }) => [
            given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
            given.auth.user({ id: "member-1" }),
            given.auth.member({ orgId: "org-1", userId: "member-1" }),
          ],
          steps: ({ then, runner, when }) => [
            then.assert(
              "accept a member's captured release before Auth becomes unavailable",
              async (ctx) => {
                await seedPackage(sourceState(ctx, userScope), {
                  name: "@ada-labs/durable-package",
                  version: "1.0.0",
                  readme: "Frozen during Auth outage",
                  files: ["README.md"],
                });
                ctx.vars.publication = await publishFromShell(
                  publisherShell(
                    ctx,
                    createBackofficeUserExecution({ scope: userScope, userId: "member-1" }),
                  ),
                  "",
                );
                publicationAccepted = true;
              },
            ),
            runner.drain(),
            then.assert(
              "the actual kernel authority-unavailable error schedules a retry",
              async (ctx) => {
                assert(ctx.vars.publication?.state === "requested");
                const instance = await publicationStatus(ctx, ctx.vars.publication);
                assert(instance.details.status === "waiting");
                const history = await createRouteBackedAutomationWorkflowRuntime({
                  object: ctx.runtime.objects.automations.singleton(),
                  execution: createBackofficeSystemExecution({ kind: "system" }),
                }).getInternalHistory({
                  workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
                  instanceId: ctx.vars.publication.workflowInstanceId,
                });
                expect(history.steps).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({
                      name: stepName,
                      status: "waiting",
                      attempts: 1,
                      nextRetryAt: expect.anything(),
                      error: {
                        name: "BackofficeForbiddenError",
                        message: "Backoffice authority resolution is unavailable.",
                      },
                    }),
                  ]),
                );
                await expect(
                  ctx.runtime.objects.marketplace
                    .singleton()
                    .commands.getPublishedListing({ listingId: LISTING_ID }),
                ).resolves.toBeNull();
              },
            ),
            runner.restartObject({ binding: "AUTOMATIONS", scope: { kind: "singleton" } }),
            when.time.advance("1 s"),
            then.assert(
              "the persisted retry completes with the original bytes after Auth recovers",
              async (ctx) => {
                assert(ctx.vars.publication?.state === "requested");
                assert(
                  (await publicationStatus(ctx, ctx.vars.publication)).details.status ===
                    "complete",
                );
                const history = await createRouteBackedAutomationWorkflowRuntime({
                  object: ctx.runtime.objects.automations.singleton(),
                  execution: createBackofficeSystemExecution({ kind: "system" }),
                }).getInternalHistory({
                  workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
                  instanceId: ctx.vars.publication.workflowInstanceId,
                });
                expect(history.steps).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({
                      name: stepName,
                      status: "completed",
                      attempts: 2,
                      nextRetryAt: null,
                    }),
                  ]),
                );
                await expect(
                  (await artifactFile(ctx, await publishedManifest(ctx), "README.md")).text(),
                ).resolves.toBe("Frozen during Auth outage");
              },
            ),
          ],
        }),
      );
    },
  );

  test("membership revocation before execution fails permanently instead of inheriting coordinator authority", async () => {
    const USER_SCOPE = { kind: "user", userId: "member-1" } as const;
    await runBackofficeScenario(
      defineBackofficeScenario<{ publication: MarketplacePublishResult | null }>({
        objects: scenarioObjects,
        name: "Deferred publication checks current publishing authority",
        vars: () => ({ publication: null }),
        options: { allowErroredWorkflows: true },
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
          given.auth.user({ id: "member-1" }),
          given.auth.member({ orgId: "org-1", userId: "member-1" }),
        ],
        steps: ({ then, runner }) => [
          then.assert(
            "accept the member's original intent, then revoke membership",
            async (ctx) => {
              await seedPackage(sourceState(ctx, USER_SCOPE), {
                name: "@ada-labs/durable-package",
                version: "1.0.0",
                readme: "Queued snapshot",
                files: ["README.md"],
              });
              ctx.vars.publication = await publishFromShell(
                publisherShell(
                  ctx,
                  createBackofficeUserExecution({ scope: USER_SCOPE, userId: "member-1" }),
                ),
                "",
              );
              await ctx.runtime.objects.auth.singleton().commands.applyScenarioFixture({
                removedMembers: [{ organizationId: "org-1", userId: "member-1" }],
              });
            },
          ),
          runner.drain(),
          then.assert(
            "System orchestration cannot grant the former member author authority",
            async (ctx) => {
              assert(ctx.vars.publication);
              const instance = await publicationStatus(ctx, ctx.vars.publication);
              assert(instance.details.status === "errored");
              expect(instance.details.error?.message).toContain(
                "membership in the owning organization",
              );
              await expect(
                ctx.runtime.objects.marketplace
                  .singleton()
                  .commands.getPublishedListing({ listingId: LISTING_ID }),
              ).resolves.toBeNull();
            },
          ),
        ],
      }),
    );
  });

  test("rejects invalid manifests, unsafe selections, secrets, and oversized packages without writes", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Package validation happens before publication staging",
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
        ],
        steps: ({ then, runner }) => [
          then.assert("reject invalid package boundaries", async (ctx) => {
            const state = sourceState(ctx, ORG_SCOPE);
            const bash = publisherShell(ctx, createBackofficeSystemExecution(ORG_SCOPE));
            const base = {
              name: "@ada-labs/durable-package",
              version: "1.0.0",
              metadata: METADATA,
              files: ["README.md"],
            };
            await seedPackage(state, { ...base, readme: "Valid file" });
            for (const manifest of [
              { ...base, name: "durable-package" },
              { ...base, version: "latest" },
              { ...base, publisherName: "Impersonated publisher" },
              { ...base, files: ["../secret.txt"] },
              { ...base, files: ["/workspace/secret.txt"] },
              { ...base, files: ["automations/*.js"] },
              { ...base, files: ["README.md", "README.md"] },
              { ...base, files: [".env"] },
              { ...base, files: ["marketplace-lock.json"] },
              { ...base, files: ["missing.txt"] },
              { ...base, files: ["README.md/"] },
            ]) {
              await state.writeFile(`${PACKAGE_ROOT}/manifest.json`, JSON.stringify(manifest));
              const rejected = await bash.exec(
                `marketplace.publish --package-root ${PACKAGE_ROOT}`,
              );
              assert(rejected.exitCode !== 0, JSON.stringify(manifest));
            }
            await state.writeFile(`${PACKAGE_ROOT}/manifest.json`, JSON.stringify(base));
            await state.writeFile(`${PACKAGE_ROOT}/README.md`, "x".repeat(1_048_576));
            const oversized = await bash.exec(`marketplace.publish --package-root ${PACKAGE_ROOT}`);
            assert(oversized.exitCode !== 0);
            expect(oversized.stderr).toContain("exceeds 1048576 bytes");
            await state.writeFile(`${PACKAGE_ROOT}/.git/manifest.json`, JSON.stringify(base));
            const privateRoot = await bash.exec(
              `marketplace.publish --package-root ${PACKAGE_ROOT}/.git`,
            );
            assert(privateRoot.exitCode !== 0);
            expect(privateRoot.stderr).toContain("cannot be published");
            await expect(
              ctx.runtime.objects.marketplace
                .singleton()
                .commands.getArtifactManifest({ listingId: LISTING_ID }),
            ).resolves.toBeNull();
            await state.writeFile(
              `${PACKAGE_ROOT}/manifest.json`,
              JSON.stringify({ ...base, files: ["manifest.json"] }),
            );
            const manifestOnly = await publishFromShell(bash, "");
            expect(manifestOnly.files.map((file) => file.relativePath)).toEqual(["manifest.json"]);
          }),
          runner.drain(),
          then.assert(
            "the allowlist excludes oversized unselected content and includes its explicit manifest once",
            async (ctx) => {
              const manifest = await publishedManifest(ctx);
              assert((await artifactFile(ctx, manifest, "README.md")).status === 404);
              const content = marketplacePackageManifestSchema.parse(
                await (await artifactFile(ctx, manifest, "manifest.json")).json(),
              );
              assert(content.name === "@ada-labs/durable-package");
              expect(content.files).toEqual(["manifest.json"]);
            },
          ),
        ],
      }),
    );
  });
});
