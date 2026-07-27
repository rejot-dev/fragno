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
import { marketplaceArtifactUploadName } from "@/fragno/marketplace/artifacts";
import { marketplaceListingId } from "@/fragno/marketplace/owner";

import {
  buildMarketplacePublicationWorkflowInstanceId,
  MARKETPLACE_PUBLISH_WORKFLOW_NAME,
} from "./marketplace-publish-workflow";
import { createWorkflowsRouteCaller } from "./route-callers";
import { defineBackofficeScenario, runBackofficeScenario } from "./scenario";

describe("marketplace scenarios", () => {
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
