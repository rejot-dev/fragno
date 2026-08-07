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

vi.mock("cloudflare:workers", () => ({
  DurableObject,
  RpcTarget,
  WorkerEntrypoint,
}));

import {
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import {
  automationActorsSchema,
  BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY,
} from "@/fragno/automation/actors";
import { UNTRUSTED_CODEMODE_WORKFLOW } from "@/fragno/automation/engine/untrusted-codemode-workflow";
import {
  MARKETPLACE_INSTALL_WORKFLOW_PATH,
  marketplaceArtifactUploadName,
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
import { createAutomationsRouteCaller, createWorkflowsRouteCaller } from "./route-callers";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "./scenario";

const MARKETPLACE_LISTING_ID = marketplaceListingId({
  ownerScope: { kind: "system" },
  slug: "telegram-test-command",
});
const MARKETPLACE_ARTIFACT_UPLOAD_OBJECT_NAME = `v1:named:${encodeURIComponent(
  marketplaceArtifactUploadName(MARKETPLACE_LISTING_ID),
)}`;
const MARKETPLACE_ARTIFACT_FILE_KEY = "automations/telegram-test-command.workflow.js";
const MARKETPLACE_ARTIFACT_CONFLICT_MESSAGE =
  "Marketplace ingestion conflicts with workspace file '/workspace/automations/telegram-test-command.workflow.js'.";
const MARKETPLACE_UNCHANGED_FILE_KEY = "prompts/marketplace.md";
const MARKETPLACE_UNCHANGED_FILE_SOURCE = "# Marketplace\n";
const MARKETPLACE_REMOVED_FILE_KEY = "prompts/removed-in-next-version.md";
const MARKETPLACE_REMOVED_FILE_SOURCE = "# Removed in the next Marketplace version\n";
const STATIC_TELEGRAM_TEST_COMMAND = STATIC_MARKETPLACE_ENTRIES.find(
  (entry) => entry.slug === "telegram-test-command",
);
if (!STATIC_TELEGRAM_TEST_COMMAND) {
  throw new Error("Expected the built-in Telegram test command Marketplace entry.");
}
const BASE_STATIC_MARKETPLACE_VERSION = STATIC_TELEGRAM_TEST_COMMAND.versions.find(
  (version) => version.version === "1.0.0",
);
const UPDATED_STATIC_MARKETPLACE_VERSION = STATIC_TELEGRAM_TEST_COMMAND.versions.find(
  (version) => version.version === "1.1.0",
);
const INSTALLER_STATIC_MARKETPLACE_VERSION = STATIC_TELEGRAM_TEST_COMMAND.versions.find(
  (version) => version.version === "1.2.1",
);
if (
  !BASE_STATIC_MARKETPLACE_VERSION ||
  !UPDATED_STATIC_MARKETPLACE_VERSION ||
  !INSTALLER_STATIC_MARKETPLACE_VERSION
) {
  throw new Error("Expected all Telegram test command Marketplace versions.");
}
const TELEGRAM_TEST_COMMAND_MARKETPLACE_README =
  STATIC_TELEGRAM_TEST_COMMAND.rootFiles?.["README.md"];
const TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE =
  BASE_STATIC_MARKETPLACE_VERSION.files[MARKETPLACE_ARTIFACT_FILE_KEY];
const UPDATED_TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE =
  UPDATED_STATIC_MARKETPLACE_VERSION.files[MARKETPLACE_ARTIFACT_FILE_KEY];
const TELEGRAM_TEST_COMMAND_INSTALL_WORKFLOW_SOURCE =
  INSTALLER_STATIC_MARKETPLACE_VERSION.files[MARKETPLACE_INSTALL_WORKFLOW_PATH];
const UNAUTHORIZED_MARKETPLACE_INSTALL_WORKFLOW_SOURCE = `defineWorkflow(
  { name: "unauthorized-marketplace-install" },
  async (_event, step) => {
    await step.do("attempt unauthorized store mutation", async () => {
      await store.set({
        key: "marketplace/unauthorized",
        value: "should-not-be-written",
        category: ["test", "marketplace"],
      });
    });
  },
);
`;

type MarketplaceWorkflowListEntry = { id: string };
type MarketplaceWorkflowHistoryStep = {
  name: string;
  status: string;
  attempts: number;
};

const withUpdatedStaticMarketplaceEntry = async (run: () => Promise<void>) => await run();

const withMarketplaceInstallerSource = async (source: string, run: () => Promise<void>) => {
  const files = INSTALLER_STATIC_MARKETPLACE_VERSION.files as Record<string, string>;
  const originalSource = files[MARKETPLACE_INSTALL_WORKFLOW_PATH];
  files[MARKETPLACE_INSTALL_WORKFLOW_PATH] = source;

  try {
    await run();
  } finally {
    files[MARKETPLACE_INSTALL_WORKFLOW_PATH] = originalSource;
  }
};

const withTwoFileMarketplaceVersions = async (run: () => Promise<void>) => {
  const baseFiles = BASE_STATIC_MARKETPLACE_VERSION.files as Record<string, string>;
  const updatedFiles = UPDATED_STATIC_MARKETPLACE_VERSION.files as Record<string, string>;
  const originalBaseFile = baseFiles[MARKETPLACE_UNCHANGED_FILE_KEY];
  const originalUpdatedFile = updatedFiles[MARKETPLACE_UNCHANGED_FILE_KEY];
  baseFiles[MARKETPLACE_UNCHANGED_FILE_KEY] = MARKETPLACE_UNCHANGED_FILE_SOURCE;
  updatedFiles[MARKETPLACE_UNCHANGED_FILE_KEY] = MARKETPLACE_UNCHANGED_FILE_SOURCE;

  try {
    await withUpdatedStaticMarketplaceEntry(run);
  } finally {
    if (originalBaseFile === undefined) {
      delete baseFiles[MARKETPLACE_UNCHANGED_FILE_KEY];
    } else {
      baseFiles[MARKETPLACE_UNCHANGED_FILE_KEY] = originalBaseFile;
    }
    if (originalUpdatedFile === undefined) {
      delete updatedFiles[MARKETPLACE_UNCHANGED_FILE_KEY];
    } else {
      updatedFiles[MARKETPLACE_UNCHANGED_FILE_KEY] = originalUpdatedFile;
    }
  }
};

const withRemovedFileMarketplaceVersion = async (run: () => Promise<void>) => {
  const baseFiles = BASE_STATIC_MARKETPLACE_VERSION.files as Record<string, string>;
  const updatedFiles = UPDATED_STATIC_MARKETPLACE_VERSION.files as Record<string, string>;
  const originalBaseFile = baseFiles[MARKETPLACE_REMOVED_FILE_KEY];
  const originalUpdatedFile = updatedFiles[MARKETPLACE_REMOVED_FILE_KEY];
  baseFiles[MARKETPLACE_REMOVED_FILE_KEY] = MARKETPLACE_REMOVED_FILE_SOURCE;
  delete updatedFiles[MARKETPLACE_REMOVED_FILE_KEY];

  try {
    await withUpdatedStaticMarketplaceEntry(run);
  } finally {
    if (originalBaseFile === undefined) {
      delete baseFiles[MARKETPLACE_REMOVED_FILE_KEY];
    } else {
      baseFiles[MARKETPLACE_REMOVED_FILE_KEY] = originalBaseFile;
    }
    if (originalUpdatedFile === undefined) {
      delete updatedFiles[MARKETPLACE_REMOVED_FILE_KEY];
    } else {
      updatedFiles[MARKETPLACE_REMOVED_FILE_KEY] = originalUpdatedFile;
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
    context: {
      execution: createBackofficeSystemExecution({
        kind: "org",
        orgId: "org-1",
      }),
      propagationContext: null,
    },
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
    new Request("https://upload.test/api/upload/files", {
      method: "POST",
      body: form,
    }),
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
                workflowStatus?: string;
                blockedByVersion?: string;
              }>;
            };
            const listingId = marketplaceListingId({
              ownerScope: { kind: "system" },
              slug: "telegram-test-command",
            });
            expect(result.publications).toEqual([
              {
                listingId,
                slug: "telegram-test-command",
                version: "1.0.0",
                workflowInstanceId: expect.stringMatching(/^marketplace-publish-/u),
                state: "requested",
                workflowStatus: "active",
              },
              {
                listingId,
                slug: "telegram-test-command",
                version: "1.1.0",
                workflowInstanceId: expect.stringMatching(/^marketplace-publish-/u),
                state: "queued",
                blockedByVersion: "1.0.0",
              },
              {
                listingId,
                slug: "telegram-test-command",
                version: "1.2.1",
                workflowInstanceId: expect.stringMatching(/^marketplace-publish-/u),
                state: "queued",
                blockedByVersion: "1.0.0",
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
              const detail = await marketplace.getPublishedListing({
                listingId,
              });
              const manifest = await marketplace.getArtifactManifest({
                listingId,
              });

              assert(detail);
              expect(detail.listing).toMatchObject({
                slug: "telegram-test-command",
                publisherName: "Fragno",
                name: "Telegram test command",
                latestVersion: "1.2.1",
                status: "published",
              });
              const uploadName = marketplaceArtifactUploadName(listingId);
              expect(manifest).toEqual({
                listingId,
                slug: "telegram-test-command",
                listingStatus: "published",
                uploadName,
                versions: ["1.2.1", "1.1.0", "1.0.0"],
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
              expect(artifactFiles).toEqual(
                expect.arrayContaining([
                  ...["1.0.0", "1.1.0", "1.2.1"].map((version) =>
                    expect.objectContaining({
                      fileKey: `${version}/automations/telegram-test-command.workflow.js`,
                      contentType: "text/javascript",
                    }),
                  ),
                  expect.objectContaining({
                    fileKey: `1.2.1/${MARKETPLACE_INSTALL_WORKFLOW_PATH}`,
                    contentType: "text/javascript",
                  }),
                  expect.objectContaining({
                    fileKey: "README.md",
                    contentType: "text/markdown",
                  }),
                ]),
              );
              expect(artifactFiles).toHaveLength(5);
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

              const installerResponse = await upload.fetch(
                new Request(
                  `https://marketplace.test/api/upload/files/by-key/content?provider=database&key=${encodeURIComponent(`1.2.1/${MARKETPLACE_INSTALL_WORKFLOW_PATH}`)}`,
                ),
              );
              assert(installerResponse.ok);
              await expect(installerResponse.text()).resolves.toBe(
                TELEGRAM_TEST_COMMAND_INSTALL_WORKFLOW_SOURCE,
              );

              const readmeResponse = await upload.fetch(
                new Request(
                  "https://marketplace.test/api/upload/files/by-key/content?provider=database&key=README.md",
                ),
              );
              assert(readmeResponse.ok);
              await expect(readmeResponse.text()).resolves.toBe(
                TELEGRAM_TEST_COMMAND_MARKETPLACE_README,
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
            expect(repeated.publications).toEqual(
              first.publications.map(({ workflowInstanceId }) =>
                expect.objectContaining({
                  workflowInstanceId,
                  state: "published",
                }),
              ),
            );
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

            const result = await ctx.runtime.objects.automations
              .forOrg("org-1")
              .requestStaticMarketplacePublications();
            expect(result.publications).toHaveLength(3);
            assert(result.publications.every(({ state }) => state === "published"));
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
              automations.requestMarketplaceIngestion(
                {
                  listingId,
                  targetScope: { kind: "org", orgId: "org-1" },
                },
                {
                  execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                  propagationContext: null,
                },
              ),
            ).resolves.toMatchObject({ state: "requested", version: "1.2.1" });
            await expect(
              automations.requestMarketplaceIngestion(
                {
                  listingId,
                  targetScope: { kind: "project", orgId: "org-1", projectId: project.id },
                },
                {
                  execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                  propagationContext: null,
                },
              ),
            ).resolves.toMatchObject({ state: "requested", version: "1.2.1" });

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
                    version: "1.2.1",
                  }),
                  expect.objectContaining({
                    targetScopeKey: `project:org-1:${String(ctx.vars.projectId)}`,
                    listingId: marketplaceListingId({
                      ownerScope: { kind: "system" },
                      slug: "telegram-test-command",
                    }),
                    version: "1.2.1",
                  }),
                ]),
              );

              for (const targetScope of [
                { kind: "org" as const, orgId: "org-1" },
                {
                  kind: "project" as const,
                  orgId: "org-1",
                  projectId: String(ctx.vars.projectId),
                },
              ]) {
                const upload = ctx.runtime.objects.upload.for(targetScope);
                const url = new URL("https://upload.test/api/upload/files/by-key/content");
                url.searchParams.set("provider", "database");
                url.searchParams.set("key", "automations/telegram-test-command.workflow.js");
                const response = await upload.fetch(new Request(url));
                assert(response.ok);
                await expect(response.text()).resolves.toBe(
                  UPDATED_TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE,
                );

                const listingReadmeUrl = new URL(
                  "https://upload.test/api/upload/files/by-key/content",
                );
                listingReadmeUrl.searchParams.set("provider", "database");
                listingReadmeUrl.searchParams.set("key", "README.md");
                const listingReadmeResponse = await upload.fetch(new Request(listingReadmeUrl));
                assert(listingReadmeResponse.status === 404);

                const installerUrl = new URL("https://upload.test/api/upload/files/by-key/content");
                installerUrl.searchParams.set("provider", "database");
                installerUrl.searchParams.set("key", MARKETPLACE_INSTALL_WORKFLOW_PATH);
                const installerResponse = await upload.fetch(new Request(installerUrl));
                assert(installerResponse.status === 404);

                const routeResponse = await ctx.runtime.objects.automations
                  .for(targetScope)
                  .fetch(
                    new Request(
                      "https://automations.test/api/automations/routes/telegram-test-command",
                    ),
                  );
                assert(routeResponse.ok);
                await expect(routeResponse.json()).resolves.toMatchObject({
                  id: "telegram-test-command",
                  action: {
                    workflowScriptPath: "/workspace/automations/telegram-test-command.workflow.js",
                  },
                  metadata: {
                    managedBy: {
                      kind: "marketplace",
                      listingId: MARKETPLACE_LISTING_ID,
                      resourceKey: "telegram-test-command-route",
                      version: "1.2.1",
                    },
                  },
                });
              }
            },
          ),
        ],
      }),
    );
  });

  test("denies installer operations outside the untrusted codemode permission ceiling", async () => {
    const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
      targetScope: { kind: "org", orgId: "org-1" },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.2.1",
    });

    await withMarketplaceInstallerSource(
      UNAUTHORIZED_MARKETPLACE_INSTALL_WORKFLOW_SOURCE,
      async () => {
        await runBackofficeScenario(
          defineBackofficeScenario({
            name: "deny unauthorized Marketplace installer operation",
            setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
            steps: ({ then, runner }) => [
              then.assert("publish the Marketplace artifact", async (ctx) => {
                await ctx.runtime.objects.automations
                  .forOrg("org-1")
                  .requestStaticMarketplacePublications();
              }),
              runner.drain(),
              then.assert("request Marketplace ingestion", async (ctx) => {
                await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
                  {
                    listingId: MARKETPLACE_LISTING_ID,
                    targetScope: { kind: "org", orgId: "org-1" },
                  },
                  {
                    execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                    propagationContext: null,
                  },
                );
              }),
              runner.drain(),
              then.workflow.instance({
                workflowName: UNTRUSTED_CODEMODE_WORKFLOW,
                instanceId: `${workflowInstanceId}:installation`,
                status: "errored",
              }),
              then.workflow.instance({
                workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
                instanceId: workflowInstanceId,
                status: "errored",
              }),
              then.assert(
                "the installer failed at the delegated capability boundary",
                async (ctx) => {
                  const workflows = createWorkflowsRouteCaller({
                    object: ctx.runtime.objects.automations.forOrg("org-1"),
                    context: {
                      execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                      propagationContext: null,
                    },
                  });
                  const response = await workflows("GET", "/:workflowName/instances/:instanceId", {
                    pathParams: {
                      workflowName: UNTRUSTED_CODEMODE_WORKFLOW,
                      instanceId: `${workflowInstanceId}:installation`,
                    },
                  });
                  assert(response.type === "json");
                  expect(response.data.details.error?.message).toContain(
                    "delegated actor does not have the required capability grant",
                  );
                },
              ),
              then.store.missing({ orgId: "org-1", key: "marketplace/unauthorized" }),
            ],
            options: { allowErroredWorkflows: true },
          }),
        );
      },
    );
  });

  test("reconciles a Marketplace-owned route while preserving its operational state", async () => {
    const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
      targetScope: { kind: "org", orgId: "org-1" },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.2.1",
    });
    const creatorActors = automationActorsSchema.parse({
      initiator: {
        scope: "internal",
        type: "user",
        id: "route-author",
        role: "initiator",
      },
      principal: null,
      delegation: [],
    });
    const installerExecution = createBackofficeUserExecution({
      scope: { kind: "org", orgId: "org-1" },
      userId: "marketplace-installer",
    });

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "reconcile a Marketplace-owned automation route",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("the Marketplace artifact is published", async (ctx) => {
            await ctx.runtime.objects.automations
              .forOrg("org-1")
              .requestStaticMarketplacePublications();
          }),
          runner.drain(),
          then.assert("an owned but drifted route exists", async (ctx) => {
            const routes = createAutomationsRouteCaller({
              object: ctx.runtime.objects.automations.forOrg("org-1"),
              context: {
                execution: { scope: { kind: "org", orgId: "org-1" }, actors: creatorActors },
                propagationContext: null,
              },
            });
            const created = await routes("POST", "/routes", {
              body: {
                id: "telegram-test-command",
                name: "Customized Telegram command",
                enabled: false,
                priority: 999,
                trigger: {
                  kind: "event",
                  source: "telegram",
                  eventType: "message.received",
                  matcher: { path: "$.payload.text", op: "eq", value: "!test" },
                },
                action: {
                  kind: "start_workflow",
                  authority: { kind: "organization-automation" },
                  remoteWorkflowName: "telegram-test-command",
                  workflowScriptPath: "/workspace/automations/wrong.workflow.js",
                  instanceIdTemplate: "wrong-${event.id}",
                },
                managedBy: {
                  kind: "marketplace",
                  listingId: MARKETPLACE_LISTING_ID,
                  resourceKey: "telegram-test-command-route",
                  version: "1.0.0",
                },
              },
            });
            assert(created.type === "json");

            const automations = ctx.runtime.objects.automations.forOrg("org-1");
            const firstRequest = await automations.requestMarketplaceIngestion(
              {
                listingId: MARKETPLACE_LISTING_ID,
                targetScope: { kind: "org", orgId: "org-1" },
              },
              { execution: installerExecution, propagationContext: null },
            );
            const replayedRequest = await automations.requestMarketplaceIngestion(
              {
                listingId: MARKETPLACE_LISTING_ID,
                targetScope: { kind: "org", orgId: "org-1" },
              },
              { execution: installerExecution, propagationContext: null },
            );
            expect(replayedRequest.workflowInstanceId).toBe(firstRequest.workflowInstanceId);
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "complete",
            actors: installerExecution.actors,
          }),
          then.assert("ingestion and installation preserve requester actors", async (ctx) => {
            const workflows = createWorkflowsRouteCaller({
              object: ctx.runtime.objects.automations.forOrg("org-1"),
              context: {
                execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                propagationContext: null,
              },
            });
            const requesterActors = installerExecution.actors;

            const ingestion = await workflows("GET", "/:workflowName/instances/:instanceId", {
              pathParams: {
                workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
                instanceId: workflowInstanceId,
              },
            });
            assert(ingestion.type === "json");
            const ingestionParams = ingestion.data.meta.params as {
              metadata?: Record<string, unknown>;
            };
            const ingestionActors = automationActorsSchema.parse(
              ingestionParams.metadata?.[BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY],
            );
            expect(ingestionActors).toEqual(requesterActors);
            expect(ingestionActors).toMatchInlineSnapshot(`
              {
                "delegation": [],
                "initiator": {
                  "id": "interactive",
                  "role": "initiator",
                  "scope": "internal",
                  "type": "backoffice",
                },
                "principal": {
                  "id": "marketplace-installer",
                  "role": "principal",
                  "scope": "internal",
                  "type": "user",
                },
              }
            `);

            const installation = await workflows("GET", "/:workflowName/instances/:instanceId", {
              pathParams: {
                workflowName: UNTRUSTED_CODEMODE_WORKFLOW,
                instanceId: `${workflowInstanceId}:installation`,
              },
            });
            assert(installation.type === "json");
            const installationParams = installation.data.meta.params as {
              automationEvent: { actors: unknown };
              metadata?: Record<string, unknown>;
            };
            const installationActors = automationActorsSchema.parse(
              installationParams.metadata?.[BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY],
            );
            expect(installationActors).toEqual(requesterActors);
            expect(installationActors).toMatchInlineSnapshot(`
              {
                "delegation": [],
                "initiator": {
                  "id": "interactive",
                  "role": "initiator",
                  "scope": "internal",
                  "type": "backoffice",
                },
                "principal": {
                  "id": "marketplace-installer",
                  "role": "principal",
                  "scope": "internal",
                  "type": "user",
                },
              }
            `);

            const installationEventActors = automationActorsSchema.parse(
              installationParams.automationEvent.actors,
            );
            expect(installationEventActors).toEqual({
              initiator: {
                scope: "internal",
                type: "system",
                id: "backoffice",
                role: "initiator",
              },
              principal: {
                scope: "internal",
                type: "automation",
                id: `automation:${workflowInstanceId}:installation`,
                role: "principal",
              },
              delegation: [],
            });
          }),
          then.assert("the managed route is reconciled without re-enabling it", async (ctx) => {
            const routes = createAutomationsRouteCaller({
              object: ctx.runtime.objects.automations.forOrg("org-1"),
              context: {
                execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                propagationContext: null,
              },
            });
            const response = await routes("GET", "/routes/:routeId", {
              pathParams: { routeId: "telegram-test-command" },
            });
            assert(response.type === "json");
            expect(response.data).toMatchObject({
              id: "telegram-test-command",
              name: "Telegram /test command",
              enabled: false,
              priority: 110,
              trigger: {
                kind: "event",
                matcher: { path: "$.payload.text", op: "eq", value: "/test" },
              },
              action: {
                kind: "start_workflow",
                authority: { kind: "organization-automation" },
                remoteWorkflowName: "telegram-test-command",
                workflowScriptPath: "/workspace/automations/telegram-test-command.workflow.js",
                instanceIdTemplate: "telegram-test-${event.id}",
              },
              metadata: {
                createdByActors: creatorActors,
                updatedByActors: {
                  initiator: {
                    scope: "internal",
                    type: "system",
                    id: "backoffice",
                    role: "initiator",
                  },
                  principal: {
                    scope: "internal",
                    type: "automation",
                    id: `automation:${workflowInstanceId}:installation`,
                    role: "principal",
                  },
                  delegation: [
                    {
                      scope: "internal",
                      type: "capability",
                      id: UNTRUSTED_CODEMODE_WORKFLOW,
                      role: "delegate",
                    },
                  ],
                },
                managedBy: {
                  kind: "marketplace",
                  listingId: MARKETPLACE_LISTING_ID,
                  resourceKey: "telegram-test-command-route",
                  version: "1.2.1",
                },
              },
            });

            const listed = await routes("GET", "/routes");
            assert(listed.type === "json");
            expect(
              listed.data.filter((route) => route.id === "telegram-test-command"),
            ).toHaveLength(1);
          }),
        ],
      }),
    );
  });

  test("rejects the unmanaged legacy Telegram route", async () => {
    const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
      targetScope: { kind: "org", orgId: "org-1" },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.2.1",
    });

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "reject an unmanaged legacy Marketplace automation route",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then, runner }) => [
          when.codemode.run({
            orgId: "org-1",
            label: "publish the bundled marketplace artifact",
            code: "async () => await internal.marketplacePush({})",
            assertToolCalls: ["internal.marketplace.push"],
          }),
          runner.drain(),
          when.router.createRoute({
            orgId: "org-1",
            id: "telegram-test-command",
            name: "Legacy Telegram command",
            enabled: true,
            priority: 900,
            trigger: {
              kind: "event",
              source: "telegram",
              eventType: "message.received",
              matcher: { path: "$.payload.text", op: "eq", value: "!test" },
            },
            action: {
              kind: "start_workflow",
              authority: { kind: "organization-automation" },
              remoteWorkflowName: "telegram-test-command",
              workflowScriptPath: "/workspace/automations/legacy-test.workflow.js",
              instanceIdTemplate: "legacy-${event.id}",
            },
          }),
          then.assert("ingestion is requested", async (ctx) => {
            await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
              {
                listingId: MARKETPLACE_LISTING_ID,
                targetScope: { kind: "org", orgId: "org-1" },
              },
              {
                execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                propagationContext: null,
              },
            );
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "errored",
          }),
          then.assert(
            "the legacy route remains unmanaged and ingestion is not recorded",
            async (ctx) => {
              const automations = ctx.runtime.objects.automations.forOrg("org-1");
              await expect(automations.listMarketplaceIngestions()).resolves.toEqual([]);

              const response = await automations.fetch(
                new Request(
                  "https://automations.test/api/automations/routes/telegram-test-command",
                ),
              );
              assert(response.ok);
              await expect(response.json()).resolves.toMatchObject({
                id: "telegram-test-command",
                name: "Legacy Telegram command",
                priority: 900,
                trigger: { matcher: { path: "$.payload.text", op: "eq", value: "!test" } },
                action: {
                  workflowScriptPath: "/workspace/automations/legacy-test.workflow.js",
                },
                metadata: { managedBy: null },
              });
            },
          ),
        ],
        options: { allowErroredWorkflows: true },
      }),
    );
  });

  test("rejects an unrelated route collision without advancing ingestion", async () => {
    const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
      targetScope: { kind: "org", orgId: "org-1" },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.2.1",
    });

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "reject an unrelated Marketplace route collision",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then, runner }) => [
          when.codemode.run({
            orgId: "org-1",
            label: "publish the bundled marketplace artifact",
            code: "async () => await internal.marketplacePush({})",
            assertToolCalls: ["internal.marketplace.push"],
          }),
          runner.drain(),
          when.router.createRoute({
            orgId: "org-1",
            id: "telegram-test-command",
            name: "Unrelated route",
            enabled: true,
            priority: 1,
            trigger: {
              kind: "event",
              source: "telegram",
              eventType: "message.received",
              matcher: null,
            },
            action: {
              kind: "start_workflow",
              authority: { kind: "organization-automation" },
              remoteWorkflowName: "unrelated-workflow",
              workflowScriptPath: "/workspace/automations/unrelated.workflow.js",
              instanceIdTemplate: "unrelated-${event.id}",
            },
          }),
          then.assert("the conflicting ingestion is requested", async (ctx) => {
            await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
              {
                listingId: MARKETPLACE_LISTING_ID,
                targetScope: { kind: "org", orgId: "org-1" },
              },
              {
                execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                propagationContext: null,
              },
            );
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "errored",
          }),
          then.assert("the collision is preserved and ingestion is not recorded", async (ctx) => {
            const automations = ctx.runtime.objects.automations.forOrg("org-1");
            await expect(automations.listMarketplaceIngestions()).resolves.toEqual([]);

            const response = await automations.fetch(
              new Request("https://automations.test/api/automations/routes/telegram-test-command"),
            );
            assert(response.ok);
            await expect(response.json()).resolves.toMatchObject({
              name: "Unrelated route",
              priority: 1,
              action: {
                remoteWorkflowName: "unrelated-workflow",
                workflowScriptPath: "/workspace/automations/unrelated.workflow.js",
              },
              metadata: { managedBy: null },
            });
          }),
        ],
        options: { allowErroredWorkflows: true },
      }),
    );
  });

  test("retries a lost ingestion transfer response without creating another upload session", async () => {
    const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
      targetScope: { kind: "org", orgId: "org-1" },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.0.0",
    });
    let createUploadAttempts = 0;
    let transferUploadAttempts = 0;
    let loseFirstTransferResponse = true;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "replay marketplace ingestion transfer without recreating its upload",
        objectFactories: {
          UPLOAD: ({ name, state, env, runtime }) => {
            const destinationObject = name.endsWith("v1:org:org-1");
            return new (class extends InMemoryUploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  destinationObject &&
                  request.method === "POST" &&
                  url.pathname.endsWith("/uploads")
                ) {
                  createUploadAttempts += 1;
                }
                if (
                  destinationObject &&
                  request.method === "PUT" &&
                  /\/uploads\/[^/]+\/content$/u.test(url.pathname)
                ) {
                  transferUploadAttempts += 1;
                  const response = await super.fetch(request);
                  if (response.ok && loseFirstTransferResponse) {
                    loseFirstTransferResponse = false;
                    throw new Error("Marketplace ingestion transfer response was lost.");
                  }
                  return response;
                }
                return await super.fetch(request);
              }
            })({ state, env: env as never, runtime });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner, when }) => [
          then.assert("the Marketplace artifact is published", async (ctx) => {
            await createMarketplacePublicationWorkflow(ctx, "1.0.0");
          }),
          runner.drain(),
          then.assert("ingestion is requested", async (ctx) => {
            await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
              {
                listingId: MARKETPLACE_LISTING_ID,
                targetScope: { kind: "org", orgId: "org-1" },
              },
              {
                execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                propagationContext: null,
              },
            );
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "waiting",
          }),
          then.assert("the completed create step is not repeated", () => {
            expect(createUploadAttempts).toBe(1);
            expect(transferUploadAttempts).toBe(1);
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
          then.assert("only the ingestion transfer step is replayed", async (ctx) => {
            expect(createUploadAttempts).toBe(1);
            expect(transferUploadAttempts).toBe(2);

            const url = new URL("https://upload.test/api/upload/files/by-key/content");
            url.searchParams.set("provider", "database");
            url.searchParams.set("key", MARKETPLACE_ARTIFACT_FILE_KEY);
            const response = await ctx.runtime.objects.upload
              .forOrg("org-1")
              .fetch(new Request(url));
            assert(response.ok);
            await expect(response.text()).resolves.toBe(TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE);
          }),
        ],
      }),
    );
  });

  test("rebuilds a multi-write ingestion batch after a runner restart", async () => {
    await withTwoFileMarketplaceVersions(async () => {
      const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
        targetScope: { kind: "org", orgId: "org-1" },
        listingId: MARKETPLACE_LISTING_ID,
        version: "1.0.0",
      });
      const createAttempts = new Map<string, number>();
      const transferAttempts = new Map<string, number>();
      const uploadFileKeys = new Map<string, string>();
      let loseSecondFileTransferResponse = true;

      await runBackofficeScenario(
        defineBackofficeScenario({
          name: "rebuild a multi-write Marketplace ingestion batch",
          objectFactories: {
            UPLOAD: ({ name, state, env, runtime }) => {
              const destinationObject = name.endsWith("v1:org:org-1");
              return new (class extends InMemoryUploadObject {
                async fetch(request: Request): Promise<Response> {
                  const url = new URL(request.url);
                  if (
                    destinationObject &&
                    request.method === "POST" &&
                    url.pathname.endsWith("/uploads")
                  ) {
                    const payload = (await request.clone().json()) as {
                      fileKey: string;
                    };
                    createAttempts.set(
                      payload.fileKey,
                      (createAttempts.get(payload.fileKey) ?? 0) + 1,
                    );
                    const response = await super.fetch(request);
                    if (response.ok) {
                      const created = (await response.clone().json()) as {
                        uploadId: string;
                      };
                      uploadFileKeys.set(created.uploadId, payload.fileKey);
                    }
                    return response;
                  }
                  const transferMatch = /\/uploads\/([^/]+)\/content$/u.exec(url.pathname);
                  if (destinationObject && request.method === "PUT" && transferMatch?.[1]) {
                    const uploadId = decodeURIComponent(transferMatch[1]);
                    const fileKey = uploadFileKeys.get(uploadId);
                    assert(fileKey);
                    transferAttempts.set(fileKey, (transferAttempts.get(fileKey) ?? 0) + 1);
                    const response = await super.fetch(request);
                    if (
                      response.ok &&
                      fileKey === MARKETPLACE_UNCHANGED_FILE_KEY &&
                      loseSecondFileTransferResponse
                    ) {
                      loseSecondFileTransferResponse = false;
                      throw new Error("Second Marketplace ingestion transfer response was lost.");
                    }
                    return response;
                  }
                  return await super.fetch(request);
                }
              })({ state, env: env as never, runtime });
            },
          },
          setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
          steps: ({ then, runner, when }) => [
            then.assert("the two-file Marketplace artifact is published", async (ctx) => {
              await createMarketplacePublicationWorkflow(ctx, "1.0.0");
            }),
            runner.drain(),
            then.assert("the two-file ingestion is requested", async (ctx) => {
              await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
                {
                  listingId: MARKETPLACE_LISTING_ID,
                  targetScope: { kind: "org", orgId: "org-1" },
                },
                {
                  execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                  propagationContext: null,
                },
              );
            }),
            runner.drain(),
            then.workflow.instance({
              workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
              instanceId: workflowInstanceId,
              status: "waiting",
            }),
            then.assert("both upload sessions were created exactly once", () => {
              expect(createAttempts).toEqual(
                new Map([
                  [MARKETPLACE_ARTIFACT_FILE_KEY, 1],
                  [MARKETPLACE_UNCHANGED_FILE_KEY, 1],
                ]),
              );
              expect(transferAttempts).toEqual(
                new Map([
                  [MARKETPLACE_ARTIFACT_FILE_KEY, 1],
                  [MARKETPLACE_UNCHANGED_FILE_KEY, 1],
                ]),
              );
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
              "replay transfers only the incomplete step and commits every write",
              async (ctx) => {
                expect(createAttempts).toEqual(
                  new Map([
                    [MARKETPLACE_ARTIFACT_FILE_KEY, 1],
                    [MARKETPLACE_UNCHANGED_FILE_KEY, 1],
                  ]),
                );
                expect(transferAttempts).toEqual(
                  new Map([
                    [MARKETPLACE_ARTIFACT_FILE_KEY, 1],
                    [MARKETPLACE_UNCHANGED_FILE_KEY, 2],
                  ]),
                );

                const upload = ctx.runtime.objects.upload.forOrg("org-1");
                for (const [fileKey, expectedContent] of [
                  [MARKETPLACE_ARTIFACT_FILE_KEY, TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE],
                  [MARKETPLACE_UNCHANGED_FILE_KEY, MARKETPLACE_UNCHANGED_FILE_SOURCE],
                ] as const) {
                  const url = new URL("https://upload.test/api/upload/files/by-key/content");
                  url.searchParams.set("provider", "database");
                  url.searchParams.set("key", fileKey);
                  const response = await upload.fetch(new Request(url));
                  assert(response.ok);
                  await expect(response.text()).resolves.toBe(expectedContent);
                }
              },
            ),
          ],
        }),
      );
    });
  });

  test("does not retry permanent typed Upload errors during ingestion", async () => {
    const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
      targetScope: { kind: "org", orgId: "org-1" },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.0.0",
    });
    let createUploadAttempts = 0;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "reject permanent marketplace ingestion Upload errors",
        objectFactories: {
          UPLOAD: ({ name, state, env, runtime }) => {
            const destinationObject = name.endsWith("v1:org:org-1");
            return new (class extends InMemoryUploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  destinationObject &&
                  request.method === "POST" &&
                  url.pathname.endsWith("/uploads")
                ) {
                  createUploadAttempts += 1;
                  return Response.json(
                    {
                      code: "INVALID_CHECKSUM",
                      message: "Synthetic permanent ingestion checksum failure.",
                    },
                    { status: 400 },
                  );
                }
                return await super.fetch(request);
              }
            })({ state, env: env as never, runtime });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("the Marketplace artifact is published", async (ctx) => {
            await createMarketplacePublicationWorkflow(ctx, "1.0.0");
          }),
          runner.drain(),
          then.assert("ingestion is requested", async (ctx) => {
            await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
              {
                listingId: MARKETPLACE_LISTING_ID,
                targetScope: { kind: "org", orgId: "org-1" },
              },
              {
                execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                propagationContext: null,
              },
            );
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "errored",
          }),
          then.assert("the permanent Upload code bypasses ingestion retries", () => {
            expect(createUploadAttempts).toBe(1);
          }),
        ],
        options: { allowErroredWorkflows: true },
      }),
    );
  });

  test("preserves an existing target file and rejects Marketplace ingestion", async () => {
    const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
      targetScope: { kind: "org", orgId: "org-1" },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.2.1",
    });

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "preserve an existing Marketplace ingestion target file",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then, runner }) => [
          when.codemode.run({
            orgId: "org-1",
            label: "publish the bundled marketplace artifact",
            code: "async () => await internal.marketplacePush({})",
            assertToolCalls: ["internal.marketplace.push"],
          }),
          then.assert("a file already exists at the Marketplace target path", async (ctx) => {
            const upload = ctx.runtime.objects.upload.forOrg("org-1");
            await upload.setAdminConfig({ provider: "database" }, "org-1");
            await writeUploadFile({
              upload,
              fileKey: MARKETPLACE_ARTIFACT_FILE_KEY,
              content: "locally modified",
            });

            await expect(
              ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
                {
                  listingId: MARKETPLACE_LISTING_ID,
                  targetScope: { kind: "org", orgId: "org-1" },
                },
                {
                  execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                  propagationContext: null,
                },
              ),
            ).resolves.toMatchObject({
              state: "requested",
              version: "1.2.1",
              workflowInstanceId,
            });
          }),
          runner.drain(),
          then.assert("the ingestion workflow reports the target file conflict", async (ctx) => {
            const workflows = createWorkflowsRouteCaller({
              object: ctx.runtime.objects.automations.forOrg("org-1"),
              context: {
                execution: createBackofficeSystemExecution({
                  kind: "org",
                  orgId: "org-1",
                }),
                propagationContext: null,
              },
            });
            const instance = await workflows("GET", "/:workflowName/instances/:instanceId", {
              pathParams: {
                workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
                instanceId: workflowInstanceId,
              },
            });
            assert(instance.type === "json");
            expect(instance.data.details).toMatchObject({
              status: "errored",
              error: {
                name: "NonRetryableError",
                message: MARKETPLACE_ARTIFACT_CONFLICT_MESSAGE,
              },
            });
          }),
          then.assert(
            "the existing file remains unchanged and is not recorded as installed",
            async (ctx) => {
              const contentUrl = new URL("https://upload.test/api/upload/files/by-key/content");
              contentUrl.searchParams.set("provider", "database");
              contentUrl.searchParams.set("key", MARKETPLACE_ARTIFACT_FILE_KEY);
              const response = await ctx.runtime.objects.upload
                .forOrg("org-1")
                .fetch(new Request(contentUrl));
              assert(response.ok);
              await expect(response.text()).resolves.toBe("locally modified");

              await expect(
                ctx.runtime.objects.automations.forOrg("org-1").getMarketplaceIngestion({
                  targetScope: { kind: "org", orgId: "org-1" },
                  listingId: MARKETPLACE_LISTING_ID,
                }),
              ).resolves.toBeNull();
            },
          ),
        ],
        options: { allowErroredWorkflows: true },
      }),
    );
  });

  test("rejects a latest-version ingestion when the legacy starter file matches version 1.0.0", async () => {
    const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
      targetScope: { kind: "org", orgId: "org-1" },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.2.1",
    });

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "reject Marketplace ingestion over a legacy starter-seeded version",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then, runner }) => [
          when.codemode.run({
            orgId: "org-1",
            label: "publish both bundled Marketplace versions",
            code: "async () => await internal.marketplacePush({})",
            assertToolCalls: ["internal.marketplace.push"],
          }),
          then.assert(
            "the legacy starter seeded the version 1.0.0 file without an ingestion row",
            async (ctx) => {
              const automations = ctx.runtime.objects.automations.forOrg("org-1");
              const upload = ctx.runtime.objects.upload.forOrg("org-1");
              await upload.setAdminConfig({ provider: "database" }, "org-1");
              await writeUploadFile({
                upload,
                fileKey: MARKETPLACE_ARTIFACT_FILE_KEY,
                content: TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE,
              });
              await expect(
                automations.getMarketplaceIngestion({
                  targetScope: { kind: "org", orgId: "org-1" },
                  listingId: MARKETPLACE_LISTING_ID,
                }),
              ).resolves.toBeNull();

              await expect(
                automations.requestMarketplaceIngestion(
                  {
                    listingId: MARKETPLACE_LISTING_ID,
                    targetScope: { kind: "org", orgId: "org-1" },
                  },
                  {
                    execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                    propagationContext: null,
                  },
                ),
              ).resolves.toMatchObject({
                state: "requested",
                version: "1.2.1",
                workflowInstanceId,
              });
            },
          ),
          runner.drain(),
          then.assert(
            "the missing ingestion baseline makes the legacy file conflict",
            async (ctx) => {
              const workflows = createWorkflowsRouteCaller({
                object: ctx.runtime.objects.automations.forOrg("org-1"),
                context: {
                  execution: createBackofficeSystemExecution({
                    kind: "org",
                    orgId: "org-1",
                  }),
                  propagationContext: null,
                },
              });
              const instance = await workflows("GET", "/:workflowName/instances/:instanceId", {
                pathParams: {
                  workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
                  instanceId: workflowInstanceId,
                },
              });
              assert(instance.type === "json");
              expect(instance.data.details).toMatchObject({
                status: "errored",
                error: {
                  name: "NonRetryableError",
                  message: MARKETPLACE_ARTIFACT_CONFLICT_MESSAGE,
                },
              });
            },
          ),
          then.assert(
            "the version 1.0.0 file remains and Marketplace is not installed",
            async (ctx) => {
              const contentUrl = new URL("https://upload.test/api/upload/files/by-key/content");
              contentUrl.searchParams.set("provider", "database");
              contentUrl.searchParams.set("key", MARKETPLACE_ARTIFACT_FILE_KEY);
              const response = await ctx.runtime.objects.upload
                .forOrg("org-1")
                .fetch(new Request(contentUrl));
              assert(response.ok);
              await expect(response.text()).resolves.toBe(TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE);

              await expect(
                ctx.runtime.objects.automations.forOrg("org-1").getMarketplaceIngestion({
                  targetScope: { kind: "org", orgId: "org-1" },
                  listingId: MARKETPLACE_LISTING_ID,
                }),
              ).resolves.toBeNull();
            },
          ),
        ],
        options: { allowErroredWorkflows: true },
      }),
    );
  });

  test("replays publication from its durable static entry snapshot after an object restart", async () => {
    const baseEntryFiles = BASE_STATIC_MARKETPLACE_VERSION.files as Record<string, string>;
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
            then.assert("version 1.0.0 publication is requested without draining", async (ctx) => {
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

  test("reuses an upload session after its creation response is lost", async () => {
    const uploadIds: string[] = [];
    let createUploadAttempts = 0;
    let transferUploadAttempts = 0;
    let loseFirstCreateResponse = true;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "replay Marketplace upload creation with its existing session",
        objectFactories: {
          UPLOAD: ({ name, state, env, runtime }) => {
            const artifactUploadObject = name.endsWith(MARKETPLACE_ARTIFACT_UPLOAD_OBJECT_NAME);
            return new (class extends InMemoryUploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  artifactUploadObject &&
                  request.method === "POST" &&
                  url.pathname.endsWith("/uploads")
                ) {
                  createUploadAttempts += 1;
                  const response = await super.fetch(request);
                  if (response.ok) {
                    const created = (await response.clone().json()) as {
                      uploadId: string;
                    };
                    uploadIds.push(created.uploadId);
                  }
                  if (response.ok && loseFirstCreateResponse) {
                    loseFirstCreateResponse = false;
                    throw new Error("Marketplace upload creation response was lost.");
                  }
                  return response;
                }
                if (
                  artifactUploadObject &&
                  request.method === "PUT" &&
                  /\/uploads\/[^/]+\/content$/u.test(url.pathname)
                ) {
                  transferUploadAttempts += 1;
                }
                return await super.fetch(request);
              }
            })({ state, env: env as never, runtime });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner, when }) => [
          then.assert("publication is requested", async (ctx) => {
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
          then.assert("the lost response leaves one reusable upload", () => {
            expect(createUploadAttempts).toBe(1);
            expect(transferUploadAttempts).toBe(0);
            expect(uploadIds).toHaveLength(1);
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
          then.assert("creation replay reuses the upload before transferring each file", () => {
            expect(createUploadAttempts).toBe(3);
            expect(transferUploadAttempts).toBe(2);
            expect(uploadIds[0]).toBe(uploadIds[1]);
            assert(new Set(uploadIds).size === 2);
          }),
        ],
      }),
    );
  });

  test("retries a lost artifact transfer response without creating another upload session", async () => {
    let createUploadAttempts = 0;
    let transferUploadAttempts = 0;
    let loseFirstTransferResponse = true;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "replay marketplace artifact transfer without recreating its upload",
        objectFactories: {
          UPLOAD: ({ name, state, env, runtime }) => {
            const artifactUploadObject = name.endsWith(MARKETPLACE_ARTIFACT_UPLOAD_OBJECT_NAME);
            return new (class extends InMemoryUploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  artifactUploadObject &&
                  request.method === "POST" &&
                  url.pathname.endsWith("/uploads")
                ) {
                  createUploadAttempts += 1;
                }
                if (
                  artifactUploadObject &&
                  request.method === "PUT" &&
                  /\/uploads\/[^/]+\/content$/u.test(url.pathname)
                ) {
                  transferUploadAttempts += 1;
                  const response = await super.fetch(request);
                  if (response.ok && loseFirstTransferResponse) {
                    loseFirstTransferResponse = false;
                    throw new Error("Marketplace artifact transfer response was lost.");
                  }
                  return response;
                }
                return await super.fetch(request);
              }
            })({ state, env: env as never, runtime });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner, when }) => [
          then.assert("publication is requested", async (ctx) => {
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
          then.assert("the completed create step is not repeated", () => {
            expect(createUploadAttempts).toBe(1);
            expect(transferUploadAttempts).toBe(1);
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
          then.assert("only the failed transfer step is replayed", async (ctx) => {
            expect(createUploadAttempts).toBe(2);
            expect(transferUploadAttempts).toBe(3);

            const upload = ctx.runtime.objects.upload.forName(
              marketplaceArtifactUploadName(MARKETPLACE_LISTING_ID),
            );
            const url = new URL("https://upload.test/api/upload/files/by-key/content");
            url.searchParams.set("provider", "database");
            url.searchParams.set("key", `1.0.0/${MARKETPLACE_ARTIFACT_FILE_KEY}`);
            const response = await upload.fetch(new Request(url));
            assert(response.ok);
            await expect(response.text()).resolves.toBe(TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE);
          }),
        ],
      }),
    );
  });

  test("does not retry permanent typed Upload errors", async () => {
    let createUploadAttempts = 0;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "reject permanent marketplace artifact upload errors",
        objectFactories: {
          UPLOAD: ({ name, state, env, runtime }) => {
            const artifactUploadObject = name.endsWith(MARKETPLACE_ARTIFACT_UPLOAD_OBJECT_NAME);
            return new (class extends InMemoryUploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  artifactUploadObject &&
                  request.method === "POST" &&
                  url.pathname.endsWith("/uploads")
                ) {
                  createUploadAttempts += 1;
                  return Response.json(
                    {
                      code: "INVALID_CHECKSUM",
                      message: "Synthetic permanent checksum failure.",
                    },
                    { status: 400 },
                  );
                }
                return await super.fetch(request);
              }
            })({ state, env: env as never, runtime });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publication is requested", async (ctx) => {
            await createMarketplacePublicationWorkflow(ctx, "1.0.0");
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
            instanceId: buildMarketplacePublicationWorkflowInstanceId({
              listingId: MARKETPLACE_LISTING_ID,
              version: "1.0.0",
            }),
            status: "errored",
          }),
          then.assert("the non-retryable Upload code bypasses the retry policy", () => {
            expect(createUploadAttempts).toBe(1);
          }),
        ],
        options: { allowErroredWorkflows: true },
      }),
    );
  });

  test("retries typed transient Upload errors before publishing", async () => {
    let createUploadAttempts = 0;
    let returnStorageError = true;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "retry typed transient Marketplace Upload errors",
        objectFactories: {
          UPLOAD: ({ name, state, env, runtime }) => {
            const artifactUploadObject = name.endsWith(MARKETPLACE_ARTIFACT_UPLOAD_OBJECT_NAME);
            return new (class extends InMemoryUploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  artifactUploadObject &&
                  request.method === "POST" &&
                  url.pathname.endsWith("/uploads")
                ) {
                  createUploadAttempts += 1;
                  if (returnStorageError) {
                    returnStorageError = false;
                    return Response.json(
                      {
                        code: "STORAGE_ERROR",
                        message: "Synthetic transient storage failure.",
                      },
                      { status: 400 },
                    );
                  }
                }
                return await super.fetch(request);
              }
            })({ state, env: env as never, runtime });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner, when }) => [
          then.assert("publication is requested", async (ctx) => {
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
          then.assert("the typed storage failure was retried once", () => {
            expect(createUploadAttempts).toBe(3);
          }),
        ],
      }),
    );
  });

  test("replays publication after its prepared batch commits but the response is lost", async () => {
    let batchCommitAttempts = 0;
    let loseFirstBatchCommitResponse = true;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "replay a committed Marketplace publication batch",
        objectFactories: {
          UPLOAD: ({ name, state, env, runtime }) => {
            const artifactUploadObject = name.endsWith(MARKETPLACE_ARTIFACT_UPLOAD_OBJECT_NAME);
            return new (class extends InMemoryUploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  artifactUploadObject &&
                  request.method === "POST" &&
                  url.pathname.endsWith("/files/commit-prepared")
                ) {
                  batchCommitAttempts += 1;
                  const response = await super.fetch(request);
                  if (response.ok && loseFirstBatchCommitResponse) {
                    loseFirstBatchCommitResponse = false;
                    throw new Error("Marketplace publication batch response was lost.");
                  }
                  return response;
                }
                return await super.fetch(request);
              }
            })({ state, env: env as never, runtime });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner, when }) => [
          then.assert("publication is requested", async (ctx) => {
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
          then.assert(
            "the committed artifact is ready before Marketplace publication",
            async (ctx) => {
              const upload = ctx.runtime.objects.upload.forName(
                marketplaceArtifactUploadName(MARKETPLACE_LISTING_ID),
              );
              const url = new URL("https://upload.test/api/upload/files/by-key/content");
              url.searchParams.set("provider", "database");
              url.searchParams.set("key", `1.0.0/${MARKETPLACE_ARTIFACT_FILE_KEY}`);
              const response = await upload.fetch(new Request(url));
              assert(response.ok);
              await expect(response.text()).resolves.toBe(TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE);
              await expect(
                ctx.runtime.objects.marketplace.singleton().getPublishedListing({
                  listingId: MARKETPLACE_LISTING_ID,
                }),
              ).resolves.toBeNull();
            },
          ),
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
          then.assert("the committed batch is reused before publishing the version", () => {
            expect(batchCommitAttempts).toBe(2);
          }),
        ],
      }),
    );
  });

  test("keeps publication unpublished after its prepared upload expires", async () => {
    let batchCommitAttempts = 0;
    let interruptFirstBatchCommit = true;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "expire a prepared Marketplace publication upload",
        objectFactories: {
          UPLOAD: ({ name, state, env, runtime }) => {
            const artifactUploadObject = name.endsWith(MARKETPLACE_ARTIFACT_UPLOAD_OBJECT_NAME);
            return new (class extends InMemoryUploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  artifactUploadObject &&
                  request.method === "POST" &&
                  url.pathname.endsWith("/files/commit-prepared")
                ) {
                  batchCommitAttempts += 1;
                  if (interruptFirstBatchCommit) {
                    interruptFirstBatchCommit = false;
                    throw new Error("Marketplace publication paused before batch commit.");
                  }
                }
                return await super.fetch(request);
              }
            })({ state, env: env as never, runtime });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner, when }) => [
          then.assert("publication is requested", async (ctx) => {
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
          when.time.advance("2 hours"),
          then.workflow.instance({
            workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
            instanceId: buildMarketplacePublicationWorkflowInstanceId({
              listingId: MARKETPLACE_LISTING_ID,
              version: "1.0.0",
            }),
            status: "waiting",
          }),
          when.time.advance("2 hours"),
          then.workflow.instance({
            workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
            instanceId: buildMarketplacePublicationWorkflowInstanceId({
              listingId: MARKETPLACE_LISTING_ID,
              version: "1.0.0",
            }),
            status: "waiting",
          }),
          then.assert("the expired upload is never published", async (ctx) => {
            expect(batchCommitAttempts).toBe(2);
            await expect(
              ctx.runtime.objects.marketplace.singleton().getPublishedListing({
                listingId: MARKETPLACE_LISTING_ID,
              }),
            ).resolves.toBeNull();

            const upload = ctx.runtime.objects.upload.forName(
              marketplaceArtifactUploadName(MARKETPLACE_LISTING_ID),
            );
            const url = new URL("https://upload.test/api/upload/files/by-key/content");
            url.searchParams.set("provider", "database");
            url.searchParams.set("key", `1.0.0/${MARKETPLACE_ARTIFACT_FILE_KEY}`);
            const response = await upload.fetch(new Request(url));
            assert(response.status === 404);
          }),
        ],
        options: { allowErroredWorkflows: true },
      }),
    );
  });

  test("queues the next publication exactly once after replaying a lost publication response", async () => {
    const currentInstanceId = buildMarketplacePublicationWorkflowInstanceId({
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.0.0",
    });
    const nextInstanceId = buildMarketplacePublicationWorkflowInstanceId({
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.1.0",
    });
    const finalInstanceId = buildMarketplacePublicationWorkflowInstanceId({
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.2.1",
    });
    const publicationAttempts = new Map<string, number>();
    let loseFirstPublicationResponse = true;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "replay Marketplace publication before atomically creating its successor",
        objectFactories: {
          MARKETPLACE: ({ state, env, runtime }) =>
            new (class extends InMemoryMarketplaceObject {
              async publishVersion(input: MarketplacePublishVersionInput) {
                publicationAttempts.set(
                  input.version,
                  (publicationAttempts.get(input.version) ?? 0) + 1,
                );
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
          then.assert("the catalog requests only the first publication workflow", async (ctx) => {
            await expect(
              ctx.runtime.objects.automations
                .forOrg("org-1")
                .requestStaticMarketplacePublications(),
            ).resolves.toMatchObject({
              publications: [
                {
                  version: "1.0.0",
                  state: "requested",
                  workflowInstanceId: currentInstanceId,
                },
                {
                  version: "1.1.0",
                  state: "queued",
                  workflowInstanceId: nextInstanceId,
                  blockedByVersion: "1.0.0",
                },
                {
                  version: "1.2.1",
                  state: "queued",
                  blockedByVersion: "1.0.0",
                },
              ],
            });
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
            instanceId: currentInstanceId,
            status: "waiting",
          }),
          then.assert(
            "the failed step has published the version without committing its successor",
            async (ctx) => {
              await expect(
                ctx.runtime.objects.marketplace
                  .singleton()
                  .getArtifactManifest({ listingId: MARKETPLACE_LISTING_ID }),
              ).resolves.toMatchObject({
                versions: ["1.0.0"],
              });

              const workflows = createWorkflowsRouteCaller({
                object: ctx.runtime.objects.automations.forOrg("org-1"),
                context: {
                  execution: createBackofficeSystemExecution({
                    kind: "org",
                    orgId: "org-1",
                  }),
                  propagationContext: null,
                },
              });
              const nextInstance = await workflows("GET", "/:workflowName/instances/:instanceId", {
                pathParams: {
                  workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
                  instanceId: nextInstanceId,
                },
              });
              assert(nextInstance.type === "error");
              assert(nextInstance.status === 404);
            },
          ),
          runner.restartObject({
            binding: "AUTOMATIONS",
            scope: { kind: "org", orgId: "org-1" },
          }),
          when.time.advance("1 s"),
          then.workflow.instance({
            workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
            instanceId: currentInstanceId,
            status: "complete",
          }),
          then.workflow.instance({
            workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
            instanceId: nextInstanceId,
            status: "complete",
          }),
          then.assert(
            "the replay commits one successor and the complete version chain",
            async (ctx) => {
              const workflows = createWorkflowsRouteCaller({
                object: ctx.runtime.objects.automations.forOrg("org-1"),
                context: {
                  execution: createBackofficeSystemExecution({
                    kind: "org",
                    orgId: "org-1",
                  }),
                  propagationContext: null,
                },
              });
              const instances = await workflows("GET", "/:workflowName/instances", {
                pathParams: {
                  workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
                },
              });
              assert(instances.type === "json");
              const instanceIds = (instances.data.instances as MarketplaceWorkflowListEntry[]).map(
                (instance) => instance.id,
              );
              expect(instanceIds.sort()).toEqual(
                [currentInstanceId, nextInstanceId, finalInstanceId].sort(),
              );

              let firstInstanceActors: ReturnType<typeof automationActorsSchema.parse> | null =
                null;
              for (const instanceId of [currentInstanceId, nextInstanceId, finalInstanceId]) {
                const instance = await workflows("GET", "/:workflowName/instances/:instanceId", {
                  pathParams: {
                    workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
                    instanceId,
                  },
                });
                assert(instance.type === "json");
                const params = instance.data.meta.params as {
                  metadata?: Record<string, unknown>;
                };
                const actors = automationActorsSchema.parse(
                  params.metadata?.[BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY],
                );
                if (firstInstanceActors) {
                  expect(actors).toEqual(firstInstanceActors);
                } else {
                  firstInstanceActors = actors;
                }
              }

              const currentHistory = await workflows(
                "GET",
                "/:workflowName/instances/:instanceId/history",
                {
                  pathParams: {
                    workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
                    instanceId: currentInstanceId,
                  },
                },
              );
              assert(currentHistory.type === "json");
              expect(
                (currentHistory.data.steps as MarketplaceWorkflowHistoryStep[]).find(
                  (historyStep) => historyStep.name === "publish marketplace artifact version",
                ),
              ).toMatchObject({ status: "completed", attempts: 2 });

              const nextHistory = await workflows(
                "GET",
                "/:workflowName/instances/:instanceId/history",
                {
                  pathParams: {
                    workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
                    instanceId: nextInstanceId,
                  },
                },
              );
              assert(nextHistory.type === "json");
              expect(
                (nextHistory.data.steps as MarketplaceWorkflowHistoryStep[]).find(
                  (historyStep) => historyStep.name === "publish marketplace artifact version",
                ),
              ).toMatchObject({ status: "completed", attempts: 1 });

              expect(Object.fromEntries(publicationAttempts)).toEqual({
                "1.0.0": 1,
                "1.1.0": 1,
                "1.2.1": 1,
              });
              await expect(
                ctx.runtime.objects.marketplace
                  .singleton()
                  .getPublishedListing({ listingId: MARKETPLACE_LISTING_ID }),
              ).resolves.toMatchObject({ listing: { latestVersion: "1.2.1" } });
            },
          ),
        ],
      }),
    );
  });

  test("keeps the chained publication durable while its first child attempt retries", async () => {
    const currentInstanceId = buildMarketplacePublicationWorkflowInstanceId({
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.0.0",
    });
    const nextInstanceId = buildMarketplacePublicationWorkflowInstanceId({
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.1.0",
    });
    let rejectFirstNextVersionReservation = true;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "restart after a chained Marketplace publication starts retrying",
        objectFactories: {
          MARKETPLACE: ({ state, env, runtime }) =>
            new (class extends InMemoryMarketplaceObject {
              async createDraftListing(input: MarketplaceCreateDraftListingInput) {
                if (input.version === "1.1.0" && rejectFirstNextVersionReservation) {
                  rejectFirstNextVersionReservation = false;
                  throw new Error("Temporary next-version reservation failure.");
                }
                return await super.createDraftListing(input);
              }
            })({ state, env, runtime }),
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then, runner }) => [
          then.assert("the catalog requests the version chain", async (ctx) => {
            await ctx.runtime.objects.automations
              .forOrg("org-1")
              .requestStaticMarketplacePublications();
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
            instanceId: currentInstanceId,
            status: "complete",
          }),
          then.workflow.instance({
            workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
            instanceId: nextInstanceId,
            status: "waiting",
          }),
          then.assert("the committed handoff exposes one retrying child instance", async (ctx) => {
            const workflows = createWorkflowsRouteCaller({
              object: ctx.runtime.objects.automations.forOrg("org-1"),
              context: {
                execution: createBackofficeSystemExecution({
                  kind: "org",
                  orgId: "org-1",
                }),
                propagationContext: null,
              },
            });
            const instances = await workflows("GET", "/:workflowName/instances", {
              pathParams: {
                workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
              },
            });
            assert(instances.type === "json");
            const instanceIds = (instances.data.instances as MarketplaceWorkflowListEntry[]).map(
              (instance) => instance.id,
            );
            expect(instanceIds.sort()).toEqual([currentInstanceId, nextInstanceId].sort());

            const history = await workflows("GET", "/:workflowName/instances/:instanceId/history", {
              pathParams: {
                workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
                instanceId: nextInstanceId,
              },
            });
            assert(history.type === "json");
            expect(
              (history.data.steps as MarketplaceWorkflowHistoryStep[]).find(
                (historyStep) => historyStep.name === "create marketplace draft listing",
              ),
            ).toMatchObject({ status: "waiting", attempts: 1 });
          }),
          runner.restartObject({
            binding: "AUTOMATIONS",
            scope: { kind: "org", orgId: "org-1" },
          }),
          when.time.advance("1 s"),
          then.workflow.instance({
            workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
            instanceId: nextInstanceId,
            status: "complete",
          }),
          then.assert("the persisted child resumes without another parent handoff", async (ctx) => {
            const workflows = createWorkflowsRouteCaller({
              object: ctx.runtime.objects.automations.forOrg("org-1"),
              context: {
                execution: createBackofficeSystemExecution({
                  kind: "org",
                  orgId: "org-1",
                }),
                propagationContext: null,
              },
            });
            const history = await workflows("GET", "/:workflowName/instances/:instanceId/history", {
              pathParams: {
                workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
                instanceId: nextInstanceId,
              },
            });
            assert(history.type === "json");
            expect(
              (history.data.steps as MarketplaceWorkflowHistoryStep[]).find(
                (historyStep) => historyStep.name === "create marketplace draft listing",
              ),
            ).toMatchObject({ status: "completed", attempts: 2 });
            await expect(
              ctx.runtime.objects.marketplace
                .singleton()
                .getPublishedListing({ listingId: MARKETPLACE_LISTING_ID }),
            ).resolves.toMatchObject({ listing: { latestVersion: "1.2.1" } });
          }),
        ],
      }),
    );
  });

  test("replays ingestion after the prepared batch commits but its response is lost", async () => {
    const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
      targetScope: { kind: "org", orgId: "org-1" },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.0.0",
    });
    let loseFirstBatchCommitResponse = true;
    let batchCommitAttempts = 0;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "replay a committed marketplace ingestion batch",
        objectFactories: {
          UPLOAD: ({ name, state, env, runtime }) => {
            const destinationObject = name.endsWith("v1:org:org-1");
            return new (class extends InMemoryUploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  destinationObject &&
                  request.method === "POST" &&
                  url.pathname.endsWith("/files/commit-prepared")
                ) {
                  batchCommitAttempts += 1;
                  const response = await super.fetch(request);
                  if (response.ok && loseFirstBatchCommitResponse) {
                    loseFirstBatchCommitResponse = false;
                    throw new Error("Prepared batch commit response was lost.");
                  }
                  return response;
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
              ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
                {
                  listingId: MARKETPLACE_LISTING_ID,
                  version: "1.0.0",
                  targetScope: { kind: "org", orgId: "org-1" },
                },
                {
                  execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                  propagationContext: null,
                },
              ),
            ).resolves.toMatchObject({ state: "requested" });
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "waiting",
          }),
          then.assert("the committed batch remains readable", async (ctx) => {
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
            "the replay reuses the committed batch and records ingestion",
            async (ctx) => {
              expect(batchCommitAttempts).toBe(2);
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

  test("derives an out-of-date ingestion after a newer version is published", async () => {
    await withUpdatedStaticMarketplaceEntry(async () => {
      await runBackofficeScenario(
        defineBackofficeScenario({
          name: "observe an out-of-date marketplace ingestion",
          setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
          steps: ({ then, runner }) => [
            then.assert("version 1.0.0 publication is created", async (ctx) => {
              await createMarketplacePublicationWorkflow(ctx, "1.0.0");
            }),
            runner.drain(),
            then.assert("version 1.0.0 is ingested", async (ctx) => {
              await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
                {
                  listingId: MARKETPLACE_LISTING_ID,
                  version: "1.0.0",
                  targetScope: { kind: "org", orgId: "org-1" },
                },
                {
                  execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                  propagationContext: null,
                },
              );
            }),
            runner.drain(),
            then.assert("version 1.1.0 publication is created", async (ctx) => {
              await createMarketplacePublicationWorkflow(ctx, "1.1.0");
            }),
            runner.drain(),
            then.assert(
              "the installed version is older than the latest publication",
              async (ctx) => {
                const ingestion = await ctx.runtime.objects.automations
                  .forOrg("org-1")
                  .getMarketplaceIngestion({
                    targetScope: { kind: "org", orgId: "org-1" },
                    listingId: MARKETPLACE_LISTING_ID,
                  });
                const latest = await ctx.runtime.objects.marketplace
                  .singleton()
                  .getLatestPublishedVersions({
                    listingIds: [MARKETPLACE_LISTING_ID],
                  });

                expect(ingestion).toMatchObject({ version: "1.0.0" });
                expect(latest).toEqual({ [MARKETPLACE_LISTING_ID]: "1.1.0" });
                expect(ingestion?.version).not.toBe(latest[MARKETPLACE_LISTING_ID]);
              },
            ),
          ],
        }),
      );
    });
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
              await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
                {
                  listingId: MARKETPLACE_LISTING_ID,
                  version: "1.0.0",
                  targetScope: { kind: "org", orgId: "org-1" },
                },
                {
                  execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                  propagationContext: null,
                },
              );
            }),
            runner.drain(),
            then.assert("version 1.1.0 ingestion is requested", async (ctx) => {
              await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
                {
                  listingId: MARKETPLACE_LISTING_ID,
                  version: "1.1.0",
                  targetScope: { kind: "org", orgId: "org-1" },
                },
                {
                  execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                  propagationContext: null,
                },
              );
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

  test("removes obsolete files and replays an update whose commit response is lost", async () => {
    await withRemovedFileMarketplaceVersion(async () => {
      const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
        targetScope: { kind: "org", orgId: "org-1" },
        listingId: MARKETPLACE_LISTING_ID,
        version: "1.1.0",
      });
      let loseUpgradeCommitResponse = false;

      await runBackofficeScenario(
        defineBackofficeScenario({
          name: "replay a marketplace update that removes a file",
          objectFactories: {
            UPLOAD: ({ name, state, env, runtime }) => {
              const destinationObject = name.endsWith("v1:org:org-1");
              return new (class extends InMemoryUploadObject {
                async fetch(request: Request): Promise<Response> {
                  const url = new URL(request.url);
                  if (
                    destinationObject &&
                    request.method === "POST" &&
                    url.pathname.endsWith("/files/commit-prepared")
                  ) {
                    const response = await super.fetch(request);
                    if (response.ok && loseUpgradeCommitResponse) {
                      loseUpgradeCommitResponse = false;
                      throw new Error("Marketplace update commit response was lost.");
                    }
                    return response;
                  }
                  return await super.fetch(request);
                }
              })({ state, env: env as never, runtime });
            },
          },
          setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
          steps: ({ then, runner, when }) => [
            then.assert("both Marketplace versions are published", async (ctx) => {
              await createMarketplacePublicationWorkflow(ctx, "1.0.0");
            }),
            runner.drain(),
            then.assert("the updated Marketplace version is published", async (ctx) => {
              await createMarketplacePublicationWorkflow(ctx, "1.1.0");
            }),
            runner.drain(),
            then.assert("version 1.0.0 is ingested", async (ctx) => {
              await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
                {
                  listingId: MARKETPLACE_LISTING_ID,
                  version: "1.0.0",
                  targetScope: { kind: "org", orgId: "org-1" },
                },
                {
                  execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                  propagationContext: null,
                },
              );
            }),
            runner.drain(),
            then.assert("the obsolete file exists before the update", async (ctx) => {
              const url = new URL("https://upload.test/api/upload/files/by-key/content");
              url.searchParams.set("provider", "database");
              url.searchParams.set("key", MARKETPLACE_REMOVED_FILE_KEY);
              const response = await ctx.runtime.objects.upload
                .forOrg("org-1")
                .fetch(new Request(url));
              assert(response.ok);
              await expect(response.text()).resolves.toBe(MARKETPLACE_REMOVED_FILE_SOURCE);
            }),
            then.assert(
              "version 1.1.0 is requested before losing the commit response",
              async (ctx) => {
                loseUpgradeCommitResponse = true;
                await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
                  {
                    listingId: MARKETPLACE_LISTING_ID,
                    version: "1.1.0",
                    targetScope: { kind: "org", orgId: "org-1" },
                  },
                  {
                    execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                    propagationContext: null,
                  },
                );
              },
            ),
            runner.drain(),
            then.workflow.instance({
              workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
              instanceId: workflowInstanceId,
              status: "waiting",
            }),
            then.assert("the committed removal is visible before workflow replay", async (ctx) => {
              const url = new URL("https://upload.test/api/upload/files/by-key/content");
              url.searchParams.set("provider", "database");
              url.searchParams.set("key", MARKETPLACE_REMOVED_FILE_KEY);
              const response = await ctx.runtime.objects.upload
                .forOrg("org-1")
                .fetch(new Request(url));
              assert(response.status === 410);
              await expect(
                ctx.runtime.objects.automations.forOrg("org-1").getMarketplaceIngestion({
                  targetScope: { kind: "org", orgId: "org-1" },
                  listingId: MARKETPLACE_LISTING_ID,
                }),
              ).resolves.toMatchObject({ version: "1.0.0" });
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
            then.assert("the replay records the fully updated version", async (ctx) => {
              await expect(
                ctx.runtime.objects.automations.forOrg("org-1").getMarketplaceIngestion({
                  targetScope: { kind: "org", orgId: "org-1" },
                  listingId: MARKETPLACE_LISTING_ID,
                }),
              ).resolves.toMatchObject({ version: "1.1.0" });
            }),
          ],
        }),
      );
    });
  });

  test("preserves a locally modified file that a Marketplace update would remove", async () => {
    await withRemovedFileMarketplaceVersion(async () => {
      const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
        targetScope: { kind: "org", orgId: "org-1" },
        listingId: MARKETPLACE_LISTING_ID,
        version: "1.1.0",
      });

      await runBackofficeScenario(
        defineBackofficeScenario({
          name: "reject removing a locally modified Marketplace file",
          setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
          steps: ({ then, runner }) => [
            then.assert("both Marketplace versions are published", async (ctx) => {
              await createMarketplacePublicationWorkflow(ctx, "1.0.0");
            }),
            runner.drain(),
            then.assert("the updated Marketplace version is published", async (ctx) => {
              await createMarketplacePublicationWorkflow(ctx, "1.1.0");
            }),
            runner.drain(),
            then.assert("version 1.0.0 is ingested", async (ctx) => {
              await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
                {
                  listingId: MARKETPLACE_LISTING_ID,
                  version: "1.0.0",
                  targetScope: { kind: "org", orgId: "org-1" },
                },
                {
                  execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                  propagationContext: null,
                },
              );
            }),
            runner.drain(),
            then.assert("the obsolete file is locally modified", async (ctx) => {
              await writeUploadFile({
                upload: ctx.runtime.objects.upload.forOrg("org-1"),
                fileKey: MARKETPLACE_REMOVED_FILE_KEY,
                content: "locally modified and must not be deleted",
              });
            }),
            then.assert("version 1.1.0 update is requested", async (ctx) => {
              await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
                {
                  listingId: MARKETPLACE_LISTING_ID,
                  version: "1.1.0",
                  targetScope: { kind: "org", orgId: "org-1" },
                },
                {
                  execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                  propagationContext: null,
                },
              );
            }),
            runner.drain(),
            then.workflow.instance({
              workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
              instanceId: workflowInstanceId,
              status: "errored",
            }),
            then.assert("the local file and previous ingestion remain unchanged", async (ctx) => {
              const url = new URL("https://upload.test/api/upload/files/by-key/content");
              url.searchParams.set("provider", "database");
              url.searchParams.set("key", MARKETPLACE_REMOVED_FILE_KEY);
              const response = await ctx.runtime.objects.upload
                .forOrg("org-1")
                .fetch(new Request(url));
              assert(response.ok);
              await expect(response.text()).resolves.toBe(
                "locally modified and must not be deleted",
              );
              await expect(
                ctx.runtime.objects.automations.forOrg("org-1").getMarketplaceIngestion({
                  targetScope: { kind: "org", orgId: "org-1" },
                  listingId: MARKETPLACE_LISTING_ID,
                }),
              ).resolves.toMatchObject({ version: "1.0.0" });
            }),
          ],
          options: { allowErroredWorkflows: true },
        }),
      );
    });
  });

  test("rejects an upgrade atomically when an unchanged asserted file changes after planning", async () => {
    await withTwoFileMarketplaceVersions(async () => {
      const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
        targetScope: { kind: "org", orgId: "org-1" },
        listingId: MARKETPLACE_LISTING_ID,
        version: "1.1.0",
      });
      let changeAssertedFileDuringPreparation = false;

      await runBackofficeScenario(
        defineBackofficeScenario({
          name: "reject a marketplace batch after an asserted file changes",
          objectFactories: {
            UPLOAD: ({ name, state, env, runtime }) => {
              const destinationObject = name.endsWith("v1:org:org-1");
              return new (class extends InMemoryUploadObject {
                async fetch(request: Request): Promise<Response> {
                  const url = new URL(request.url);
                  if (
                    destinationObject &&
                    changeAssertedFileDuringPreparation &&
                    request.method === "POST" &&
                    url.pathname.endsWith("/uploads")
                  ) {
                    const payload = (await request.clone().json()) as {
                      fileKey?: string;
                    };
                    if (payload.fileKey === MARKETPLACE_ARTIFACT_FILE_KEY) {
                      changeAssertedFileDuringPreparation = false;
                      await writeUploadFile({
                        upload: {
                          fetch: (nextRequest) => super.fetch(nextRequest),
                        },
                        fileKey: MARKETPLACE_UNCHANGED_FILE_KEY,
                        content: "locally changed after planning",
                      });
                    }
                  }
                  return await super.fetch(request);
                }
              })({ state, env: env as never, runtime });
            },
          },
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
              await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
                {
                  listingId: MARKETPLACE_LISTING_ID,
                  version: "1.0.0",
                  targetScope: { kind: "org", orgId: "org-1" },
                },
                {
                  execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                  propagationContext: null,
                },
              );
            }),
            runner.drain(),
            then.assert(
              "version 1.1.0 is requested before the asserted file changes",
              async (ctx) => {
                changeAssertedFileDuringPreparation = true;
                await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
                  {
                    listingId: MARKETPLACE_LISTING_ID,
                    version: "1.1.0",
                    targetScope: { kind: "org", orgId: "org-1" },
                  },
                  {
                    execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                    propagationContext: null,
                  },
                );
              },
            ),
            runner.drain(),
            then.workflow.instance({
              workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
              instanceId: workflowInstanceId,
              status: "errored",
            }),
            then.assert("the rejected batch publishes none of its prepared writes", async (ctx) => {
              const upload = ctx.runtime.objects.upload.forOrg("org-1");
              const mainUrl = new URL("https://upload.test/api/upload/files/by-key/content");
              mainUrl.searchParams.set("provider", "database");
              mainUrl.searchParams.set("key", MARKETPLACE_ARTIFACT_FILE_KEY);
              const mainResponse = await upload.fetch(new Request(mainUrl));
              assert(mainResponse.ok);
              await expect(mainResponse.text()).resolves.toBe(
                TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE,
              );

              const assertedUrl = new URL("https://upload.test/api/upload/files/by-key/content");
              assertedUrl.searchParams.set("provider", "database");
              assertedUrl.searchParams.set("key", MARKETPLACE_UNCHANGED_FILE_KEY);
              const assertedResponse = await upload.fetch(new Request(assertedUrl));
              assert(assertedResponse.ok);
              await expect(assertedResponse.text()).resolves.toBe("locally changed after planning");

              await expect(
                ctx.runtime.objects.automations.forOrg("org-1").getMarketplaceIngestion({
                  targetScope: { kind: "org", orgId: "org-1" },
                  listingId: MARKETPLACE_LISTING_ID,
                }),
              ).resolves.toMatchObject({ version: "1.0.0" });
            }),
          ],
          options: { allowErroredWorkflows: true },
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
              await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
                {
                  listingId: MARKETPLACE_LISTING_ID,
                  version: "1.0.0",
                  targetScope: { kind: "org", orgId: "org-1" },
                },
                {
                  execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                  propagationContext: null,
                },
              );
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
              await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
                {
                  listingId: MARKETPLACE_LISTING_ID,
                  version: "1.1.0",
                  targetScope: { kind: "org", orgId: "org-1" },
                },
                {
                  execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                  propagationContext: null,
                },
              );
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

  test("rejects source bytes changed between upload creation and transfer", async () => {
    const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
      targetScope: { kind: "org", orgId: "org-1" },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.0.0",
    });
    let mutateSourceAfterUploadCreation = true;
    let destinationTransferAttempts = 0;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "reject Marketplace source changed before transfer",
        objectFactories: {
          UPLOAD: ({ name, state, env, runtime }) => {
            const destinationObject = name.endsWith("v1:org:org-1");
            return new (class extends InMemoryUploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  destinationObject &&
                  request.method === "POST" &&
                  url.pathname.endsWith("/uploads")
                ) {
                  const response = await super.fetch(request);
                  if (response.ok && mutateSourceAfterUploadCreation) {
                    mutateSourceAfterUploadCreation = false;
                    await writeUploadFile({
                      upload: runtime.objects.upload.forName(
                        marketplaceArtifactUploadName(MARKETPLACE_LISTING_ID),
                      ),
                      fileKey: `1.0.0/${MARKETPLACE_ARTIFACT_FILE_KEY}`,
                      content: "source changed after destination upload creation",
                    });
                  }
                  return response;
                }
                if (
                  destinationObject &&
                  request.method === "PUT" &&
                  /\/uploads\/[^/]+\/content$/u.test(url.pathname)
                ) {
                  destinationTransferAttempts += 1;
                }
                return await super.fetch(request);
              }
            })({ state, env: env as never, runtime });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("the Marketplace artifact is published", async (ctx) => {
            await createMarketplacePublicationWorkflow(ctx, "1.0.0");
          }),
          runner.drain(),
          then.assert("ingestion is requested", async (ctx) => {
            await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
              {
                listingId: MARKETPLACE_LISTING_ID,
                targetScope: { kind: "org", orgId: "org-1" },
              },
              {
                execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                propagationContext: null,
              },
            );
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "errored",
          }),
          then.assert("the changed source is rejected before destination transfer", async (ctx) => {
            expect(destinationTransferAttempts).toBe(0);
            const url = new URL("https://upload.test/api/upload/files/by-key/content");
            url.searchParams.set("provider", "database");
            url.searchParams.set("key", MARKETPLACE_ARTIFACT_FILE_KEY);
            const response = await ctx.runtime.objects.upload
              .forOrg("org-1")
              .fetch(new Request(url));
            assert(response.status === 404);
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
            await ctx.runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion(
              {
                listingId: MARKETPLACE_LISTING_ID,
                version: "1.0.0",
                targetScope: { kind: "org", orgId: "org-1" },
              },
              {
                execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                propagationContext: null,
              },
            );
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
              context: {
                execution: createBackofficeSystemExecution({
                  kind: "org",
                  orgId: "org-1",
                }),
                propagationContext: null,
              },
            });
            const invalidPublication = await workflows("POST", "/:workflowName/instances", {
              pathParams: {
                workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
              },
              body: {
                id: "invalid-marketplace-publication",
                params: {
                  slug: "Invalid Slug",
                  version: "not-semver",
                } as never,
              },
            });
            assert(invalidPublication.type === "error");
            assert(invalidPublication.status === 400);
            assert(invalidPublication.error.code === "WORKFLOW_PARAMS_INVALID");

            const invalidIngestion = await workflows("POST", "/:workflowName/instances", {
              pathParams: {
                workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
              },
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
              context: {
                execution: createBackofficeSystemExecution({
                  kind: "org",
                  orgId: "org-1",
                }),
                propagationContext: null,
              },
            });
            const created = await workflows("POST", "/:workflowName/instances", {
              pathParams: {
                workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
              },
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
                expect.objectContaining({
                  listingId,
                  slug: "telegram-test-command",
                  version: "1.1.0",
                  state: "queued",
                  blockedByVersion: "1.0.0",
                }),
                expect.objectContaining({
                  listingId,
                  slug: "telegram-test-command",
                  version: "1.2.1",
                  state: "queued",
                  blockedByVersion: "1.0.0",
                }),
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
              versions: ["1.2.1", "1.1.0", "1.0.0"],
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
