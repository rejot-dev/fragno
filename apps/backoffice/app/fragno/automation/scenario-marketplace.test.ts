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

import { TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE } from "@/files/content/telegram-test-command";
import {
  marketplaceArtifactUploadName,
  type MarketplaceStaticArtifactEntry,
} from "@/fragno/marketplace/artifacts";
import type {
  MarketplaceCreateDraftListingInput,
  MarketplacePublishVersionInput,
} from "@/fragno/marketplace/contracts";
import { marketplaceListingId } from "@/fragno/marketplace/owner";
import { STATIC_MARKETPLACE_ENTRIES } from "@/fragno/marketplace/static-entries";

import { InMemoryMarketplaceObject } from "../../../workers/marketplace.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import {
  buildMarketplaceIngestionWorkflowInstanceId,
  MARKETPLACE_INGEST_WORKFLOW_NAME,
} from "./marketplace-ingest-workflow";
import {
  buildMarketplacePublicationWorkflowInstanceId,
  MARKETPLACE_PUBLISH_WORKFLOW_NAME,
} from "./marketplace-publish-workflow";
import { createWorkflowsRouteCaller } from "./route-callers";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "./scenario";

const MARKETPLACE_LISTING_ID = marketplaceListingId({
  ownerScope: { kind: "system" },
  slug: "telegram-test-command",
});
const MARKETPLACE_ARTIFACT_FILE_KEY = "automations/telegram-test-command.workflow.js";
const UPDATED_TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE = `${TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE}\n// Marketplace version 1.1.0`;
const UPDATED_STATIC_MARKETPLACE_ENTRY: MarketplaceStaticArtifactEntry = {
  ...STATIC_MARKETPLACE_ENTRIES[0],
  version: "1.1.0",
  metadata: {
    ...STATIC_MARKETPLACE_ENTRIES[0].metadata,
    name: "Telegram test command 1.1",
  },
  files: {
    [MARKETPLACE_ARTIFACT_FILE_KEY]: UPDATED_TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE,
  },
};

const mutableStaticMarketplaceEntries =
  STATIC_MARKETPLACE_ENTRIES as unknown as MarketplaceStaticArtifactEntry[];

const withUpdatedStaticMarketplaceEntry = async (run: () => Promise<void>) => {
  mutableStaticMarketplaceEntries.push(UPDATED_STATIC_MARKETPLACE_ENTRY);
  try {
    await run();
  } finally {
    const index = mutableStaticMarketplaceEntries.indexOf(UPDATED_STATIC_MARKETPLACE_ENTRY);
    if (index >= 0) {
      mutableStaticMarketplaceEntries.splice(index, 1);
    }
  }
};

const createMarketplacePublicationWorkflow = async (
  ctx: BackofficeScenarioContext,
  version: string,
) => {
  const workflowInstanceId = buildMarketplacePublicationWorkflowInstanceId({
    listingId: MARKETPLACE_LISTING_ID,
    version,
  });
  const workflows = createWorkflowsRouteCaller({
    object: ctx.runtime.objects.automations.forOrg("org-1"),
    scope: { kind: "org", orgId: "org-1" },
  });
  const created = await workflows("POST", "/:workflowName/instances", {
    pathParams: { workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME },
    body: {
      id: workflowInstanceId,
      params: { slug: "telegram-test-command", version },
    },
  });
  assert(created.type === "json");
  return workflowInstanceId;
};

const writeUploadFile = async (input: {
  content: string;
  fileKey: string;
  upload: { fetch(request: Request): Promise<Response> };
}) => {
  const form = new FormData();
  form.set("provider", "database");
  form.set("fileKey", input.fileKey);
  form.set("filename", input.fileKey.split("/").at(-1) ?? "artifact");
  form.set("file", new File([input.content], input.fileKey.split("/").at(-1) ?? "artifact"));
  const response = await input.upload.fetch(
    new Request("https://upload.test/api/upload/files", { method: "POST", body: form }),
  );
  assert(response.ok);
};

describe("marketplace scenarios", { concurrent: false }, () => {
  test("publishes bundled artifacts idempotently through the organization workflow", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "publish bundled marketplace artifact",

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.codemode.run({
            orgId: "org-1",
            label: "request bundled marketplace publication",
            code: "async () => await internal.marketplacePush({})",
            assertToolCalls: ["internal.marketplace.push"],
          }),

          then.assert("the first push requests the publication workflow", (ctx) => {
            const result = ctx.codemodeRuns.at(-1)?.result.result as {
              publications: Array<{
                listingId: string;
                slug: string;
                version: string;
                workflowInstanceId: string;
                state: string;
                workflowStatus: string;
              }>;
            };
            expect(result.publications).toEqual([
              {
                listingId: marketplaceListingId({
                  ownerScope: { kind: "system" },
                  slug: "telegram-test-command",
                }),
                slug: "telegram-test-command",
                version: "1.0.0",
                workflowInstanceId: expect.stringMatching(/^marketplace-publish-/u),
                state: "requested",
                workflowStatus: "active",
              },
            ]);
          }),

          then.assert(
            "the workflow publishes the artifact and marketplace manifest",
            async (ctx) => {
              const listingId = marketplaceListingId({
                ownerScope: { kind: "system" },
                slug: "telegram-test-command",
              });
              const marketplace = ctx.runtime.objects.marketplace.singleton();
              const detail = await marketplace.getPublishedListing({ listingId });
              const manifest = await marketplace.getArtifactManifest({ listingId });

              assert(detail);
              expect(detail.listing).toMatchObject({
                slug: "telegram-test-command",
                publisherName: "Fragno",
                name: "Telegram test command",
                latestVersion: "1.0.0",
                status: "published",
              });
              const uploadName = marketplaceArtifactUploadName(listingId);
              expect(manifest).toEqual({
                listingId,
                slug: "telegram-test-command",
                listingStatus: "published",
                uploadName,
                versions: [{ version: "1.0.0", directory: "1.0.0" }],
              });

              const upload = ctx.runtime.objects.upload.forName(uploadName);
              const listResponse = await upload.fetch(
                new Request(
                  "https://marketplace.test/api/upload/files?provider=database&status=ready&pageSize=500",
                ),
              );
              assert(listResponse.ok);
              const files = (await listResponse.json()) as {
                files: Array<{
                  fileKey: string;
                  contentType: string;
                  metadata: Record<string, unknown> | null;
                }>;
              };
              const artifactFiles = files.files.filter(
                (file) => file.metadata?.__docsDirectoryMarker !== true,
              );
              expect(artifactFiles).toEqual([
                expect.objectContaining({
                  fileKey: "1.0.0/automations/telegram-test-command.workflow.js",
                  contentType: "text/javascript",
                }),
              ]);
              assert(!files.files.some((file) => file.fileKey === "manifest.json"));

              const contentResponse = await upload.fetch(
                new Request(
                  "https://marketplace.test/api/upload/files/by-key/content?provider=database&key=1.0.0%2Fautomations%2Ftelegram-test-command.workflow.js",
                ),
              );
              assert(contentResponse.ok);
              await expect(contentResponse.text()).resolves.toBe(
                TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE,
              );
            },
          ),

          when.codemode.run({
            orgId: "org-1",
            label: "push the published artifact again",
            code: "async () => await internal.marketplacePush({})",
            assertToolCalls: ["internal.marketplace.push"],
          }),

          then.assert("the repeated push skips the published artifact", (ctx) => {
            const first = ctx.codemodeRuns[0]?.result.result as {
              publications: Array<{ workflowInstanceId: string }>;
            };
            const repeated = ctx.codemodeRuns.at(-1)?.result.result as {
              publications: Array<{
                workflowInstanceId: string;
                state: string;
              }>;
            };
            expect(repeated.publications).toEqual([
              expect.objectContaining({
                workflowInstanceId: first.publications[0]?.workflowInstanceId,
                state: "published",
              }),
            ]);
          }),

          then.assert("published requests do not inspect the artifact files again", async (ctx) => {
            const listingId = marketplaceListingId({
              ownerScope: { kind: "system" },
              slug: "telegram-test-command",
            });
            const upload = ctx.runtime.objects.upload.forName(
              marketplaceArtifactUploadName(listingId),
            );
            const fileKey = "1.0.0/automations/telegram-test-command.workflow.js";
            const deleteUrl = new URL("https://marketplace.test/api/upload/files/by-key");
            deleteUrl.searchParams.set("provider", "database");
            deleteUrl.searchParams.set("key", fileKey);
            const deleteResponse = await upload.fetch(new Request(deleteUrl, { method: "DELETE" }));
            assert(deleteResponse.ok);

            const form = new FormData();
            form.set("provider", "database");
            form.set("fileKey", fileKey);
            form.set("filename", "telegram-test-command.workflow.js");
            form.set("file", new File(["changed"], "telegram-test-command.workflow.js"));
            const replaceResponse = await upload.fetch(
              new Request("https://marketplace.test/api/upload/files", {
                method: "POST",
                body: form,
              }),
            );
            assert(replaceResponse.ok);

            await expect(
              ctx.runtime.objects.automations
                .forOrg("org-1")
                .requestStaticMarketplacePublications(),
            ).resolves.toMatchObject({ publications: [{ state: "published" }] });
          }),
        ],
      }),
    );
  });

  test("ingests a published artifact into organization and project workspaces", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "ingest marketplace artifact into scoped workspaces",

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then, runner }) => [
          when.codemode.run({
            orgId: "org-1",
            label: "publish the bundled marketplace artifact",
            code: "async () => await internal.marketplacePush({})",
            assertToolCalls: ["internal.marketplace.push"],
          }),

          then.assert("organization and project ingestions are requested", async (ctx) => {
            const automations = ctx.runtime.objects.automations.forOrg("org-1");
            const projectResponse = await automations.fetch(
              new Request("https://automations.test/api/automations/projects?orgId=org-1", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  name: "Delivery",
                  slug: "delivery",
                  createdByUserId: "user-1",
                }),
              }),
            );
            assert(projectResponse.ok);
            const project = (await projectResponse.json()) as { id: string };
            const listingId = marketplaceListingId({
              ownerScope: { kind: "system" },
              slug: "telegram-test-command",
            });

            await expect(
              automations.requestMarketplaceIngestion({
                listingId,
                targetScope: { kind: "org", orgId: "org-1" },
              }),
            ).resolves.toMatchObject({ state: "requested", version: "1.0.0" });
            await expect(
              automations.requestMarketplaceIngestion({
                listingId,
                targetScope: { kind: "project", orgId: "org-1", projectId: project.id },
              }),
            ).resolves.toMatchObject({ state: "requested", version: "1.0.0" });

            ctx.vars.projectId = project.id;
          }),

          runner.drain(),

          then.assert(
            "each destination has independent successful ingestion state",
            async (ctx) => {
              const automations = ctx.runtime.objects.automations.forOrg("org-1");
              const ingestions = await automations.listMarketplaceIngestions();
              expect(ingestions).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    targetScopeKey: "org:org-1",
                    listingId: marketplaceListingId({
                      ownerScope: { kind: "system" },
                      slug: "telegram-test-command",
                    }),
                    version: "1.0.0",
                  }),
                  expect.objectContaining({
                    targetScopeKey: `project:org-1:${String(ctx.vars.projectId)}`,
                    listingId: marketplaceListingId({
                      ownerScope: { kind: "system" },
                      slug: "telegram-test-command",
                    }),
                    version: "1.0.0",
                  }),
                ]),
              );

              for (const upload of [
                ctx.runtime.objects.upload.forOrg("org-1"),
                ctx.runtime.objects.upload.forProject({
                  orgId: "org-1",
                  projectId: String(ctx.vars.projectId),
                }),
              ]) {
                const url = new URL("https://upload.test/api/upload/files/by-key/content");
                url.searchParams.set("provider", "database");
                url.searchParams.set("key", "automations/telegram-test-command.workflow.js");
                const response = await upload.fetch(new Request(url));
                assert(response.ok);
                await expect(response.text()).resolves.toBe(TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE);
              }
            },
          ),
        ],
      }),
    );
  });

  test("rejects conflicting organization workspace files without recording ingestion", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "reject conflicting marketplace ingestion",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then, runner }) => [
          when.codemode.run({
            orgId: "org-1",
            label: "publish the bundled marketplace artifact",
            code: "async () => await internal.marketplacePush({})",
            assertToolCalls: ["internal.marketplace.push"],
          }),
          then.assert("a conflicting destination file is created", async (ctx) => {
            const upload = ctx.runtime.objects.upload.forOrg("org-1");
            await upload.setAdminConfig({ provider: "database" }, "org-1");
            const form = new FormData();
            form.set("provider", "database");
            form.set("fileKey", "automations/telegram-test-command.workflow.js");
            form.set("filename", "telegram-test-command.workflow.js");
            form.set("file", new File(["locally modified"], "telegram-test-command.workflow.js"));
            const response = await upload.fetch(
              new Request("https://upload.test/api/upload/files", { method: "POST", body: form }),
            );
            assert(response.ok);

            const listingId = marketplaceListingId({
              ownerScope: { kind: "system" },
              slug: "telegram-test-command",
            });
            await expect(
              ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion({
                listingId,
                targetScope: { kind: "org", orgId: "org-1" },
              }),
            ).resolves.toMatchObject({ state: "requested" });
          }),
          runner.drain(),
          then.assert("the failed workflow leaves no successful ingestion row", async (ctx) => {
            await expect(
              ctx.runtime.objects.automations.forOrg("org-1").getMarketplaceIngestion({
                targetScope: { kind: "org", orgId: "org-1" },
                listingId: marketplaceListingId({
                  ownerScope: { kind: "system" },
                  slug: "telegram-test-command",
                }),
              }),
            ).resolves.toBeNull();
          }),
        ],
        options: { allowErroredWorkflows: true },
      }),
    );
  });

  test("replays publication from its durable static entry snapshot after an object restart", async () => {
    const baseEntryFiles = STATIC_MARKETPLACE_ENTRIES[0].files as Record<string, string>;
    const originalSource = baseEntryFiles[MARKETPLACE_ARTIFACT_FILE_KEY];
    let rejectReservation = true;

    try {
      await runBackofficeScenario(
        defineBackofficeScenario({
          name: "replay marketplace publication from a durable static snapshot",
          objectFactories: {
            MARKETPLACE: ({ state, env, runtime }) =>
              new (class extends InMemoryMarketplaceObject {
                async createDraftListing(input: MarketplaceCreateDraftListingInput) {
                  if (rejectReservation) {
                    rejectReservation = false;
                    throw new Error("Temporary Marketplace reservation failure.");
                  }
                  return await super.createDraftListing(input);
                }
              })({ state, env, runtime }),
          },
          setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
          steps: ({ when, then, runner }) => [
            then.assert("publication is requested without draining its workflow", async (ctx) => {
              await expect(
                ctx.runtime.objects.automations
                  .forOrg("org-1")
                  .requestStaticMarketplacePublications(),
              ).resolves.toMatchObject({ publications: [{ state: "requested" }] });
            }),
            runner.drain(),
            then.workflow.instance({
              workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
              instanceId: buildMarketplacePublicationWorkflowInstanceId({
                listingId: MARKETPLACE_LISTING_ID,
                version: "1.0.0",
              }),
              status: "waiting",
            }),
            then.assert("the bundled source changes after the snapshot step commits", () => {
              baseEntryFiles[MARKETPLACE_ARTIFACT_FILE_KEY] = "changed after snapshot";
            }),
            runner.restartObject({
              binding: "AUTOMATIONS",
              scope: { kind: "org", orgId: "org-1" },
            }),
            when.time.advance("1 s"),
            then.workflow.instance({
              workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
              instanceId: buildMarketplacePublicationWorkflowInstanceId({
                listingId: MARKETPLACE_LISTING_ID,
                version: "1.0.0",
              }),
              status: "complete",
            }),
            then.assert("publication uses the source captured before restart", async (ctx) => {
              const upload = ctx.runtime.objects.upload.forName(
                marketplaceArtifactUploadName(MARKETPLACE_LISTING_ID),
              );
              const url = new URL("https://upload.test/api/upload/files/by-key/content");
              url.searchParams.set("provider", "database");
              url.searchParams.set("key", `1.0.0/${MARKETPLACE_ARTIFACT_FILE_KEY}`);
              const response = await upload.fetch(new Request(url));
              assert(response.ok);
              await expect(response.text()).resolves.toBe(originalSource);
            }),
          ],
        }),
      );
    } finally {
      if (originalSource !== undefined) {
        baseEntryFiles[MARKETPLACE_ARTIFACT_FILE_KEY] = originalSource;
      }
    }
  });

  test("replays a successful publication after its response is lost and a newer version publishes", async () => {
    await withUpdatedStaticMarketplaceEntry(async () => {
      let loseFirstPublicationResponse = true;
      await runBackofficeScenario(
        defineBackofficeScenario({
          name: "replay an already successful marketplace publication",
          objectFactories: {
            MARKETPLACE: ({ state, env, runtime }) =>
              new (class extends InMemoryMarketplaceObject {
                async publishVersion(input: MarketplacePublishVersionInput) {
                  const result = await super.publishVersion(input);
                  if (input.version === "1.0.0" && result.ok && loseFirstPublicationResponse) {
                    loseFirstPublicationResponse = false;
                    throw new Error("Marketplace publication response was lost.");
                  }
                  return result;
                }
              })({ state, env, runtime }),
          },
          setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
          steps: ({ when, then, runner }) => [
            then.assert("version 1.0.0 publication is created", async (ctx) => {
              await createMarketplacePublicationWorkflow(ctx, "1.0.0");
            }),
            runner.drain(),
            then.workflow.instance({
              workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
              instanceId: buildMarketplacePublicationWorkflowInstanceId({
                listingId: MARKETPLACE_LISTING_ID,
                version: "1.0.0",
              }),
              status: "waiting",
            }),
            then.assert("version 1.0.0 is published despite the lost response", async (ctx) => {
              await expect(
                ctx.runtime.objects.marketplace
                  .singleton()
                  .getArtifactManifest({ listingId: MARKETPLACE_LISTING_ID }),
              ).resolves.toMatchObject({
                versions: [expect.objectContaining({ version: "1.0.0" })],
              });
            }),
            then.assert("version 1.1.0 publication is created", async (ctx) => {
              await createMarketplacePublicationWorkflow(ctx, "1.1.0");
            }),
            runner.drain(),
            then.assert("version 1.1.0 becomes latest before the replay", async (ctx) => {
              await expect(
                ctx.runtime.objects.marketplace
                  .singleton()
                  .getPublishedListing({ listingId: MARKETPLACE_LISTING_ID }),
              ).resolves.toMatchObject({ listing: { latestVersion: "1.1.0" } });
            }),
            runner.restartObject({
              binding: "AUTOMATIONS",
              scope: { kind: "org", orgId: "org-1" },
            }),
            when.time.advance("1 s"),
            then.workflow.instance({
              workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
              instanceId: buildMarketplacePublicationWorkflowInstanceId({
                listingId: MARKETPLACE_LISTING_ID,
                version: "1.0.0",
              }),
              status: "complete",
            }),
            then.assert("the replay does not promote the older version", async (ctx) => {
              await expect(
                ctx.runtime.objects.marketplace
                  .singleton()
                  .getPublishedListing({ listingId: MARKETPLACE_LISTING_ID }),
              ).resolves.toMatchObject({ listing: { latestVersion: "1.1.0" } });
            }),
          ],
        }),
      );
    });
  });

  test("replays ingestion after the file write commits but chmod fails", async () => {
    const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
      targetScope: { kind: "org", orgId: "org-1" },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.0.0",
    });
    let rejectFirstChmod = true;
    let targetWriteAttempts = 0;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "replay a committed marketplace ingestion file write",
        objectFactories: {
          UPLOAD: ({ name, state, env, runtime }) => {
            const destinationObject = name.endsWith("v1:org:org-1");
            return new (class extends InMemoryUploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  destinationObject &&
                  request.method === "POST" &&
                  url.pathname.endsWith("/files")
                ) {
                  const form = await request.clone().formData();
                  if (form.get("fileKey") === MARKETPLACE_ARTIFACT_FILE_KEY) {
                    targetWriteAttempts += 1;
                  }
                }
                if (
                  destinationObject &&
                  request.method === "PATCH" &&
                  url.pathname.endsWith("/files/by-key") &&
                  url.searchParams.get("key") === MARKETPLACE_ARTIFACT_FILE_KEY &&
                  rejectFirstChmod
                ) {
                  rejectFirstChmod = false;
                  return Response.json({ message: "Temporary chmod failure." }, { status: 503 });
                }
                return await super.fetch(request);
              }
            })({ state, env: env as never, runtime });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then, runner }) => [
          when.codemode.run({
            orgId: "org-1",
            label: "publish the bundled marketplace artifact",
            code: "async () => await internal.marketplacePush({})",
            assertToolCalls: ["internal.marketplace.push"],
          }),
          then.assert("ingestion is requested without draining", async (ctx) => {
            await expect(
              ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion({
                listingId: MARKETPLACE_LISTING_ID,
                targetScope: { kind: "org", orgId: "org-1" },
              }),
            ).resolves.toMatchObject({ state: "requested" });
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "waiting",
          }),
          then.assert("the successful file write remains readable", async (ctx) => {
            const url = new URL("https://upload.test/api/upload/files/by-key/content");
            url.searchParams.set("provider", "database");
            url.searchParams.set("key", MARKETPLACE_ARTIFACT_FILE_KEY);
            const response = await ctx.runtime.objects.upload
              .forOrg("org-1")
              .fetch(new Request(url));
            assert(response.ok);
            await expect(response.text()).resolves.toBe(TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE);
          }),
          runner.restartObject({
            binding: "AUTOMATIONS",
            scope: { kind: "org", orgId: "org-1" },
          }),
          when.time.advance("1 s"),
          then.workflow.instance({
            workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "complete",
          }),
          then.assert(
            "the replay recognizes its previous write and records ingestion",
            async (ctx) => {
              expect(targetWriteAttempts).toBe(2);
              await expect(
                ctx.runtime.objects.automations.forOrg("org-1").getMarketplaceIngestion({
                  targetScope: { kind: "org", orgId: "org-1" },
                  listingId: MARKETPLACE_LISTING_ID,
                }),
              ).resolves.toMatchObject({ version: "1.0.0" });
            },
          ),
        ],
      }),
    );
  });

  test("updates files that still match the previously ingested marketplace version", async () => {
    await withUpdatedStaticMarketplaceEntry(async () => {
      await runBackofficeScenario(
        defineBackofficeScenario({
          name: "upgrade an unchanged marketplace workspace",
          setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
          steps: ({ then, runner }) => [
            then.assert("version 1.0.0 publication is created", async (ctx) => {
              await createMarketplacePublicationWorkflow(ctx, "1.0.0");
            }),
            runner.drain(),
            then.assert("version 1.1.0 publication is created", async (ctx) => {
              await createMarketplacePublicationWorkflow(ctx, "1.1.0");
            }),
            runner.drain(),
            then.assert("version 1.0.0 ingestion is requested", async (ctx) => {
              await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion({
                listingId: MARKETPLACE_LISTING_ID,
                version: "1.0.0",
                targetScope: { kind: "org", orgId: "org-1" },
              });
            }),
            runner.drain(),
            then.assert("version 1.1.0 ingestion is requested", async (ctx) => {
              await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion({
                listingId: MARKETPLACE_LISTING_ID,
                version: "1.1.0",
                targetScope: { kind: "org", orgId: "org-1" },
              });
            }),
            runner.drain(),
            then.assert("the workspace and ingestion projection advance together", async (ctx) => {
              await expect(
                ctx.runtime.objects.automations.forOrg("org-1").getMarketplaceIngestion({
                  targetScope: { kind: "org", orgId: "org-1" },
                  listingId: MARKETPLACE_LISTING_ID,
                }),
              ).resolves.toMatchObject({ version: "1.1.0" });

              const url = new URL("https://upload.test/api/upload/files/by-key/content");
              url.searchParams.set("provider", "database");
              url.searchParams.set("key", MARKETPLACE_ARTIFACT_FILE_KEY);
              const response = await ctx.runtime.objects.upload
                .forOrg("org-1")
                .fetch(new Request(url));
              assert(response.ok);
              await expect(response.text()).resolves.toBe(
                UPDATED_TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE,
              );
            }),
          ],
        }),
      );
    });
  });

  test("preserves locally modified files when a marketplace upgrade is requested", async () => {
    await withUpdatedStaticMarketplaceEntry(async () => {
      const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
        targetScope: { kind: "org", orgId: "org-1" },
        listingId: MARKETPLACE_LISTING_ID,
        version: "1.1.0",
      });
      await runBackofficeScenario(
        defineBackofficeScenario({
          name: "reject a marketplace upgrade over local modifications",
          setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
          steps: ({ then, runner }) => [
            then.assert("both marketplace versions are published", async (ctx) => {
              await createMarketplacePublicationWorkflow(ctx, "1.0.0");
            }),
            runner.drain(),
            then.assert("the updated marketplace version is published", async (ctx) => {
              await createMarketplacePublicationWorkflow(ctx, "1.1.0");
            }),
            runner.drain(),
            then.assert("version 1.0.0 is ingested", async (ctx) => {
              await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion({
                listingId: MARKETPLACE_LISTING_ID,
                version: "1.0.0",
                targetScope: { kind: "org", orgId: "org-1" },
              });
            }),
            runner.drain(),
            then.assert("the installed file is locally modified", async (ctx) => {
              await writeUploadFile({
                upload: ctx.runtime.objects.upload.forOrg("org-1"),
                fileKey: MARKETPLACE_ARTIFACT_FILE_KEY,
                content: "locally modified after version 1.0.0",
              });
            }),
            then.assert("version 1.1.0 upgrade is requested", async (ctx) => {
              await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion({
                listingId: MARKETPLACE_LISTING_ID,
                version: "1.1.0",
                targetScope: { kind: "org", orgId: "org-1" },
              });
            }),
            runner.drain(),
            then.workflow.instance({
              workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
              instanceId: workflowInstanceId,
              status: "errored",
            }),
            then.assert(
              "the old projection and local content remain authoritative",
              async (ctx) => {
                await expect(
                  ctx.runtime.objects.automations.forOrg("org-1").getMarketplaceIngestion({
                    targetScope: { kind: "org", orgId: "org-1" },
                    listingId: MARKETPLACE_LISTING_ID,
                  }),
                ).resolves.toMatchObject({ version: "1.0.0" });

                const url = new URL("https://upload.test/api/upload/files/by-key/content");
                url.searchParams.set("provider", "database");
                url.searchParams.set("key", MARKETPLACE_ARTIFACT_FILE_KEY);
                const response = await ctx.runtime.objects.upload
                  .forOrg("org-1")
                  .fetch(new Request(url));
                assert(response.ok);
                await expect(response.text()).resolves.toBe("locally modified after version 1.0.0");
              },
            ),
          ],
          options: { allowErroredWorkflows: true },
        }),
      );
    });
  });

  test("rejects source bytes changed after listing without poisoning the destination", async () => {
    const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
      targetScope: { kind: "org", orgId: "org-1" },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.0.0",
    });
    let mutateSourceAfterListing = true;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "reject a marketplace source changed during ingestion",
        objectFactories: {
          UPLOAD: ({ name, state, env, runtime }) => {
            const destinationObject = name.endsWith("v1:org:org-1");
            return new (class extends InMemoryUploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  destinationObject &&
                  request.method === "GET" &&
                  url.pathname.endsWith("/files/by-key") &&
                  url.searchParams.get("key") === MARKETPLACE_ARTIFACT_FILE_KEY &&
                  mutateSourceAfterListing
                ) {
                  mutateSourceAfterListing = false;
                  await writeUploadFile({
                    upload: runtime.objects.upload.forName(
                      marketplaceArtifactUploadName(MARKETPLACE_LISTING_ID),
                    ),
                    fileKey: `1.0.0/${MARKETPLACE_ARTIFACT_FILE_KEY}`,
                    content: "source changed after durable listing",
                  });
                }
                return await super.fetch(request);
              }
            })({ state, env: env as never, runtime });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then, runner }) => [
          when.codemode.run({
            orgId: "org-1",
            label: "publish the bundled marketplace artifact",
            code: "async () => await internal.marketplacePush({})",
            assertToolCalls: ["internal.marketplace.push"],
          }),
          then.assert("ingestion is requested", async (ctx) => {
            await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion({
              listingId: MARKETPLACE_LISTING_ID,
              targetScope: { kind: "org", orgId: "org-1" },
            });
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "errored",
          }),
          then.assert("the changed source was never written or recorded", async (ctx) => {
            const contentUrl = new URL("https://upload.test/api/upload/files/by-key/content");
            contentUrl.searchParams.set("provider", "database");
            contentUrl.searchParams.set("key", MARKETPLACE_ARTIFACT_FILE_KEY);
            const contentResponse = await ctx.runtime.objects.upload
              .forOrg("org-1")
              .fetch(new Request(contentUrl));
            assert(contentResponse.status === 404);
            await expect(
              ctx.runtime.objects.automations.forOrg("org-1").getMarketplaceIngestion({
                targetScope: { kind: "org", orgId: "org-1" },
                listingId: MARKETPLACE_LISTING_ID,
              }),
            ).resolves.toBeNull();
          }),
        ],
        options: { allowErroredWorkflows: true },
      }),
    );
  });

  test("rejects invalid marketplace workflow params before creating instances", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "validate marketplace workflow params",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert("invalid publication and ingestion params are rejected", async (ctx) => {
            const workflows = createWorkflowsRouteCaller({
              object: ctx.runtime.objects.automations.forOrg("org-1"),
              scope: { kind: "org", orgId: "org-1" },
            });
            const invalidPublication = await workflows("POST", "/:workflowName/instances", {
              pathParams: { workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME },
              body: {
                id: "invalid-marketplace-publication",
                params: { slug: "Invalid Slug", version: "not-semver" } as never,
              },
            });
            assert(invalidPublication.type === "error");
            assert(invalidPublication.status === 400);
            assert(invalidPublication.error.code === "WORKFLOW_PARAMS_INVALID");

            const invalidIngestion = await workflows("POST", "/:workflowName/instances", {
              pathParams: { workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME },
              body: {
                id: "invalid-marketplace-ingestion",
                params: { listingId: MARKETPLACE_LISTING_ID } as never,
              },
            });
            assert(invalidIngestion.type === "error");
            assert(invalidIngestion.status === 400);
            assert(invalidIngestion.error.code === "WORKFLOW_PARAMS_INVALID");
          }),
        ],
      }),
    );
  });

  test("surfaces an existing failed publication workflow", async () => {
    const listingId = marketplaceListingId({
      ownerScope: { kind: "system" },
      slug: "telegram-test-command",
    });
    const workflowInstanceId = buildMarketplacePublicationWorkflowInstanceId({
      listingId,
      version: "1.0.0",
    });

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "report failed marketplace publication",

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ then }) => [
          then.assert("an existing publication workflow is terminated", async (ctx) => {
            const workflows = createWorkflowsRouteCaller({
              object: ctx.runtime.objects.automations.forOrg("org-1"),
              scope: { kind: "org", orgId: "org-1" },
            });
            const created = await workflows("POST", "/:workflowName/instances", {
              pathParams: { workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME },
              body: {
                id: workflowInstanceId,
                params: {
                  slug: "telegram-test-command",
                  version: "1.0.0",
                },
              },
            });
            assert(created.type === "json");

            const terminated = await workflows(
              "POST",
              "/:workflowName/instances/:instanceId/terminate",
              {
                pathParams: {
                  workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
                  instanceId: workflowInstanceId,
                },
              },
            );
            assert(terminated.type === "json");
          }),

          then.workflow.instance({
            workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "terminated",
          }),

          then.assert("a repeated request returns the terminal workflow failure", async (ctx) => {
            const result = await ctx.runtime.objects.automations
              .forOrg("org-1")
              .requestStaticMarketplacePublications();

            expect(result).toEqual({
              publications: [
                {
                  listingId,
                  slug: "telegram-test-command",
                  version: "1.0.0",
                  workflowInstanceId,
                  state: "failed",
                  workflowStatus: "terminated",
                  error: {
                    name: "MarketplacePublicationTerminated",
                    message: `Marketplace publication workflow ${workflowInstanceId} terminated.`,
                  },
                },
              ],
            });
          }),
        ],
      }),
    );
  });

  test("keeps archived bundled marketplace listings archived", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "preserve archived bundled marketplace listing",

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.codemode.run({
            orgId: "org-1",
            label: "publish the bundled marketplace artifact",
            code: "async () => await internal.marketplacePush({})",
            assertToolCalls: ["internal.marketplace.push"],
          }),

          then.assert("an archived listing is not republished by a later request", async (ctx) => {
            const listingId = marketplaceListingId({
              ownerScope: { kind: "system" },
              slug: "telegram-test-command",
            });
            const marketplace = ctx.runtime.objects.marketplace.singleton();
            const archived = await marketplace.archiveListing({
              owner: { scope: { kind: "system" }, publisherName: "Fragno" },
              listingId,
            });
            assert(archived.ok);
            expect(archived.value).toMatchObject({ archived: true });

            await expect(
              ctx.runtime.objects.automations
                .forOrg("org-1")
                .requestStaticMarketplacePublications(),
            ).rejects.toMatchObject({ code: "MARKETPLACE_LISTING_ARCHIVED" });

            await expect(marketplace.getPublishedListing({ listingId })).resolves.toBeNull();
            await expect(marketplace.getArtifactManifest({ listingId })).resolves.toMatchObject({
              listingStatus: "archived",
              versions: [{ version: "1.0.0", directory: "1.0.0" }],
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
