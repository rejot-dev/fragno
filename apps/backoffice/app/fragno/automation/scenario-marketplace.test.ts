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
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import {
  automationActorsSchema,
  BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY,
} from "@/fragno/automation/actors";
import type { AutomationEvent } from "@/fragno/automation/contracts";
import {
  CODEMODE_CAPABILITY_ACTOR,
  CODEMODE_WORKFLOW,
} from "@/fragno/automation/engine/codemode-invocation";
import {
  MARKETPLACE_INSTALL_WORKFLOW_PATH,
  marketplaceArtifactUploadName,
} from "@/fragno/marketplace/artifacts";
import type { MarketplaceCreateDraftListingInput } from "@/fragno/marketplace/contracts";
import { marketplaceListingId } from "@/fragno/marketplace/owner";
import { STATIC_MARKETPLACE_ENTRIES } from "@/fragno/marketplace/static-entries";

import { InMemoryMarketplaceObject } from "../../../workers/marketplace.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import {
  buildMarketplaceIngestionWorkflowInstanceId,
  MARKETPLACE_INGEST_WORKFLOW_NAME,
} from "./marketplace-ingest-identity";
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
const CONFIGURABLE_STATIC_MARKETPLACE_VERSION = STATIC_TELEGRAM_TEST_COMMAND.versions.find(
  (version) => version.version === "1.3.0",
);
if (
  !BASE_STATIC_MARKETPLACE_VERSION ||
  !UPDATED_STATIC_MARKETPLACE_VERSION ||
  !INSTALLER_STATIC_MARKETPLACE_VERSION ||
  !CONFIGURABLE_STATIC_MARKETPLACE_VERSION
) {
  throw new Error("Expected all Telegram test command Marketplace versions.");
}
const TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE =
  BASE_STATIC_MARKETPLACE_VERSION.files[MARKETPLACE_ARTIFACT_FILE_KEY];
const UPDATED_TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE =
  UPDATED_STATIC_MARKETPLACE_VERSION.files[MARKETPLACE_ARTIFACT_FILE_KEY];
function githubPullRequestWebhookEvent(action: "opened" | "synchronize"): AutomationEvent {
  const repository = {
    id: 1001,
    name: "backoffice",
    full_name: "ada-labs/backoffice",
    private: false,
    html_url: "https://github.com/ada-labs/backoffice",
  };
  const sender = {
    id: 42,
    login: "ada",
    type: "User",
    html_url: "https://github.com/ada",
  };

  return {
    id: `github:pull-request:${action}:delivery-1`,
    scope: { kind: "org", orgId: "org-1" },
    source: "github",
    eventType: "webhook.received",
    occurredAt: "2026-08-24T12:00:00.000Z",
    payload: {
      deliveryId: `delivery-${action}`,
      githubEvent: "pull_request",
      action,
      installationId: "installation-1",
      repository,
      pullRequest: {
        id: 2001,
        number: 17,
        title: "Accept complete GitHub pull request refs",
        state: "open",
        head: {
          label: "ada:feature/pull-request-refs",
          ref: "feature/pull-request-refs",
          sha: "head-sha",
          user: sender,
          repo: repository,
        },
        base: {
          label: "ada-labs:main",
          ref: "main",
          sha: "base-sha",
          user: sender,
          repo: repository,
        },
      },
      sender,
      raw: {},
    },
    actors: {
      initiator: {
        scope: "external",
        source: "github",
        type: "user",
        id: String(sender.id),
        role: "initiator",
      },
      principal: null,
      delegation: [],
    },
    subject: {
      orgId: "org-1",
      installationId: "installation-1",
      accountId: String(sender.id),
      accountLogin: sender.login,
      repositoryId: String(repository.id),
      repositoryFullName: repository.full_name,
      pullRequestNumber: "17",
    },
  };
}

const UNAUTHORIZED_MARKETPLACE_INSTALL_WORKFLOW_SOURCE = `defineWorkflow(
  { name: "unauthorized-marketplace-install" },
  async (_event, step) => {
    await step.do("attempt unauthorized Telegram send", async () => {
      await telegram.sendMessage({
        chatId: "unauthorized",
        text: "should-not-be-sent",
      });
    });
  },
);
`;

const withUpdatedStaticMarketplaceEntry = async (run: () => Promise<void>) => {
  const files = UPDATED_STATIC_MARKETPLACE_VERSION.files as Record<string, string>;
  const installer = files[MARKETPLACE_INSTALL_WORKFLOW_PATH];
  delete files[MARKETPLACE_INSTALL_WORKFLOW_PATH];
  try {
    await run();
  } finally {
    if (installer !== undefined) {
      files[MARKETPLACE_INSTALL_WORKFLOW_PATH] = installer;
    }
  }
};

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
  upload: { http: { fetch(request: Request): Promise<Response> } };
}) => {
  const form = new FormData();
  form.set("provider", "database");
  form.set("fileKey", input.fileKey);
  form.set("filename", input.fileKey.split("/").at(-1) ?? "artifact");
  form.set("file", new File([input.content], input.fileKey.split("/").at(-1) ?? "artifact"));
  const response = await input.upload.http.fetch(
    new Request("https://upload.test/api/upload/files", {
      method: "POST",
      body: form,
    }),
  );
  assert(response.ok);
};

describe("marketplace scenarios", { concurrent: false }, () => {
  test("force-publishes with fresh workflow IDs and overwrites artifact files", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "force-publish bundled Marketplace artifacts",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("the normal publication is requested", async (ctx) => {
            await ctx.runtime.objects.automations
              .forOrg("org-1")
              .commands.requestStaticMarketplacePublications();
          }),
          runner.drain(),
          then.assert("the forced publication uses fresh workflow IDs", async (ctx) => {
            const forced = await ctx.runtime.objects.automations
              .forOrg("org-1")
              .commands.requestStaticMarketplacePublications({ force: true });
            expect(forced.publications[0]).toMatchObject({
              state: "requested",
              workflowStatus: "active",
            });
            expect(forced.publications[0]?.workflowInstanceId).not.toBe(
              buildMarketplacePublicationWorkflowInstanceId({
                listingId: MARKETPLACE_LISTING_ID,
                version: "1.0.0",
              }),
            );
          }),
          runner.drain(),
          then.assert("the overwritten artifacts remain published", async (ctx) => {
            await expect(
              ctx.runtime.objects.marketplace
                .singleton()
                .commands.getArtifactManifest({ listingId: MARKETPLACE_LISTING_ID }),
            ).resolves.toMatchObject({
              listingStatus: "published",
              versions: ["1.3.0", "1.2.1", "1.1.0", "1.0.0"],
            });
          }),
        ],
      }),
    );
  });

  test("installs Telegram and GitHub Channel event definitions and routes", async () => {
    const telegramChannelListingId = marketplaceListingId({
      ownerScope: { kind: "system" },
      slug: "telegram-channel",
    });
    const githubChannelListingId = marketplaceListingId({
      ownerScope: { kind: "system" },
      slug: "github-channel",
    });

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "install the built-in Telegram and GitHub channels",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then, runner }) => [
          then.assert("publish the built-in Marketplace channels", async (ctx) => {
            await ctx.runtime.objects.automations
              .forOrg("org-1")
              .commands.requestStaticMarketplacePublications();
          }),
          runner.drain(),
          then.assert("request both channel installations", async (ctx) => {
            const automations = ctx.runtime.objects.automations.forOrg("org-1");
            const execution = {
              execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
              propagationContext: null,
            };

            await expect(
              automations.commands.requestMarketplaceIngestion(
                {
                  listingId: telegramChannelListingId,
                  version: "1.0.0",
                  targetScope: { kind: "org", orgId: "org-1" },
                },
                execution,
              ),
            ).resolves.toMatchObject({ state: "requested", version: "1.0.0" });
            await expect(
              automations.commands.requestMarketplaceIngestion(
                {
                  listingId: githubChannelListingId,
                  version: "1.0.0",
                  targetScope: { kind: "org", orgId: "org-1" },
                },
                execution,
              ),
            ).resolves.toMatchObject({ state: "requested", version: "1.0.0" });
          }),
          runner.drain(),
          then.assert("both channels own their installed routes", async (ctx) => {
            const automations = ctx.runtime.objects.automations.forOrg("org-1");
            const expectedRoutes = [
              ["telegram-start-linking", telegramChannelListingId],
              ["telegram-identity-claim-completed", telegramChannelListingId],
              ["telegram-pi-linking", telegramChannelListingId],
              ["github-issues-opened-reclassify", githubChannelListingId],
              ["github-issue-comment-created-reclassify", githubChannelListingId],
              ["github-pull-request-opened-reclassify", githubChannelListingId],
              ["github-pull-request-synchronize-reclassify", githubChannelListingId],
              ["github-push-reclassify", githubChannelListingId],
            ] as const;

            for (const [routeId, listingId] of expectedRoutes) {
              const response = await automations.http.fetch(
                new Request(`https://automations.test/api/automations/routes/${routeId}`),
              );
              assert(response.ok);
              await expect(response.json()).resolves.toMatchObject({
                id: routeId,
                metadata: {
                  managedBy: {
                    kind: "marketplace",
                    listingId,
                    version: "1.0.0",
                  },
                },
              });
            }

            for (const eventType of [
              "issues.opened",
              "issue_comment.created",
              "pull_request.opened",
              "pull_request.synchronize",
              "push",
            ]) {
              await expect(
                automations.commands.getEventDefinition({ source: "github", eventType }),
              ).resolves.toMatchObject({
                source: "github",
                eventType,
                enabled: true,
              });
            }
          }),
          then.files.exists({
            orgId: "org-1",
            path: "/workspace/automations/telegram-user-linking.workflow.js",
          }),
          then.files.exists({
            orgId: "org-1",
            path: "/workspace/automations/telegram-user-pi-linking.workflow.js",
          }),
          when.automation.ingestEvent(githubPullRequestWebhookEvent("opened")),
          when.automation.ingestEvent(githubPullRequestWebhookEvent("synchronize")),
          runner.drain(),
          then.automation.event({
            scope: { kind: "org", orgId: "org-1" },
            where: { source: "github", eventType: "pull_request.opened" },
            expected: {
              payload: {
                pullRequest: {
                  head: {
                    label: "ada:feature/pull-request-refs",
                    user: { login: "ada" },
                    repo: { full_name: "ada-labs/backoffice" },
                  },
                  base: {
                    label: "ada-labs:main",
                    user: { login: "ada" },
                    repo: { full_name: "ada-labs/backoffice" },
                  },
                },
              },
            },
          }),
          then.automation.event({
            scope: { kind: "org", orgId: "org-1" },
            where: { source: "github", eventType: "pull_request.synchronize" },
            expected: {
              payload: {
                pullRequest: {
                  head: {
                    label: "ada:feature/pull-request-refs",
                    user: { login: "ada" },
                    repo: { full_name: "ada-labs/backoffice" },
                  },
                  base: {
                    label: "ada-labs:main",
                    user: { login: "ada" },
                    repo: { full_name: "ada-labs/backoffice" },
                  },
                },
              },
            },
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("installs Telegram Channel into project and personal scopes", async () => {
    const telegramChannelListingId = marketplaceListingId({
      ownerScope: { kind: "system" },
      slug: "telegram-channel",
    });

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "install Telegram Channel outside the organization scope",
        setup: ({ given }) => [
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "user-1",
          }),
        ],
        steps: ({ when, then, runner }) => [
          when.project.create({
            orgId: "org-1",
            slug: "telegram-project",
            name: "Telegram Project",
            createdByUserId: "user-1",
            captureIdAs: "projectId",
          }),
          runner.drain(),
          then.assert("publish the built-in Marketplace channels", async (ctx) => {
            await ctx.runtime.objects.automations
              .forOrg("org-1")
              .commands.requestStaticMarketplacePublications();
          }),
          runner.drain(),
          then.assert("request project and personal installations", async (ctx) => {
            const projectId = ctx.vars.projectId;
            assert(typeof projectId === "string");
            const automations = ctx.runtime.objects.automations.forOrg("org-1");
            const execution = {
              execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
              propagationContext: null,
            };

            for (const targetScope of [
              { kind: "project", orgId: "org-1", projectId },
              { kind: "user", userId: "user-1" },
            ] as const) {
              await expect(
                automations.commands.requestMarketplaceIngestion(
                  {
                    listingId: telegramChannelListingId,
                    version: "1.0.0",
                    targetScope,
                  },
                  execution,
                ),
              ).resolves.toMatchObject({ state: "requested", version: "1.0.0" });
            }
          }),
          runner.drain(),
          then.assert("both scopes contain the installed Telegram routes", async (ctx) => {
            const projectId = ctx.vars.projectId;
            assert(typeof projectId === "string");
            const installationOwner = ctx.runtime.objects.automations.forOrg("org-1");

            for (const targetScope of [
              { kind: "project", orgId: "org-1", projectId },
              { kind: "user", userId: "user-1" },
            ] as const) {
              await expect(
                installationOwner.commands.getMarketplaceIngestion({
                  listingId: telegramChannelListingId,
                  targetScope,
                }),
              ).resolves.toMatchObject({ version: "1.0.0" });

              const targetAutomations = ctx.runtime.objects.automations.for(targetScope);
              for (const routeId of [
                "telegram-start-linking",
                "telegram-identity-claim-completed",
                "telegram-pi-linking",
              ]) {
                const response = await targetAutomations.http.fetch(
                  new Request(`https://automations.test/api/automations/routes/${routeId}`),
                );
                assert(response.ok);
                await expect(response.json()).resolves.toMatchObject({
                  id: routeId,
                  metadata: {
                    managedBy: {
                      kind: "marketplace",
                      listingId: telegramChannelListingId,
                      version: "1.0.0",
                    },
                  },
                });
              }
            }
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
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
            const projectResponse = await automations.http.fetch(
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
              automations.commands.requestMarketplaceIngestion(
                {
                  listingId,
                  version: "1.2.1",
                  targetScope: { kind: "org", orgId: "org-1" },
                },
                {
                  execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                  propagationContext: null,
                },
              ),
            ).resolves.toMatchObject({ state: "requested", version: "1.2.1" });
            await expect(
              automations.commands.requestMarketplaceIngestion(
                {
                  listingId,
                  version: "1.2.1",
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
              const ingestions = await automations.commands.listMarketplaceIngestions();
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
                const response = await upload.http.fetch(new Request(url));
                assert(response.ok);
                await expect(response.text()).resolves.toBe(
                  UPDATED_TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE,
                );

                const listingReadmeUrl = new URL(
                  "https://upload.test/api/upload/files/by-key/content",
                );
                listingReadmeUrl.searchParams.set("provider", "database");
                listingReadmeUrl.searchParams.set("key", "README.md");
                const listingReadmeResponse = await upload.http.fetch(
                  new Request(listingReadmeUrl),
                );
                assert(listingReadmeResponse.status === 404);

                const installerUrl = new URL("https://upload.test/api/upload/files/by-key/content");
                installerUrl.searchParams.set("provider", "database");
                installerUrl.searchParams.set("key", MARKETPLACE_INSTALL_WORKFLOW_PATH);
                const installerResponse = await upload.http.fetch(new Request(installerUrl));
                assert(installerResponse.status === 404);

                const routeResponse = await ctx.runtime.objects.automations
                  .for(targetScope)
                  .http.fetch(
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

  test("configures the Telegram test message through generated installer UI", async () => {
    const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
      targetScope: { kind: "org", orgId: "org-1" },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.3.0",
    });
    const installationWorkflowInstanceId = `${workflowInstanceId}:installation`;
    const configuredMessage = "Marketplace generated UI configured this reply.";

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "configure the Marketplace Telegram test command",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("the Marketplace artifact is published", async (ctx) => {
            await ctx.runtime.objects.automations
              .forOrg("org-1")
              .commands.requestStaticMarketplacePublications();
          }),
          runner.drain(),
          then.assert("version 1.3.0 installation is requested", async (ctx) => {
            await expect(
              ctx.runtime.objects.automations.forOrg("org-1").commands.requestMarketplaceIngestion(
                {
                  listingId: MARKETPLACE_LISTING_ID,
                  version: "1.3.0",
                  targetScope: { kind: "org", orgId: "org-1" },
                },
                {
                  execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                  propagationContext: null,
                },
              ),
            ).resolves.toMatchObject({
              state: "requested",
              version: "1.3.0",
              workflowInstanceId,
            });
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: CODEMODE_WORKFLOW,
            instanceId: installationWorkflowInstanceId,
            status: "waiting",
          }),
          then.assert(
            "the installer exposes generated UI and waits for its submission",
            async (ctx) => {
              const workflows = createWorkflowsRouteCaller({
                object: ctx.runtime.objects.automations.forOrg("org-1"),
                context: {
                  execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
                  propagationContext: null,
                },
              });
              const history = await workflows(
                "GET",
                "/:workflowName/instances/:instanceId/history",
                {
                  pathParams: {
                    workflowName: CODEMODE_WORKFLOW,
                    instanceId: installationWorkflowInstanceId,
                  },
                },
              );
              assert(history.type === "json");
              expect(history.data.steps).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    name: "request test message",
                    status: "completed",
                    result: expect.objectContaining({
                      $ui: expect.objectContaining({ version: 1 }),
                    }),
                  }),
                  expect.objectContaining({
                    name: "wait for test message",
                    status: "waiting",
                    waitEventType: "telegram-test-command.message-configured",
                  }),
                ]),
              );

              const submitted = await workflows(
                "POST",
                "/:workflowName/instances/:instanceId/events",
                {
                  pathParams: {
                    workflowName: CODEMODE_WORKFLOW,
                    instanceId: installationWorkflowInstanceId,
                  },
                  body: {
                    id: "configure-telegram-test-command",
                    type: "telegram-test-command.message-configured",
                    payload: { message: configuredMessage },
                  },
                },
              );
              assert(submitted.type === "json");
            },
          ),
          runner.drain(),
          then.store.entry({
            orgId: "org-1",
            key: "marketplace/telegram-test-command/message",
            value: configuredMessage,
          }),
          then.workflow.instance({
            workflowName: CODEMODE_WORKFLOW,
            instanceId: installationWorkflowInstanceId,
            status: "complete",
          }),
          then.workflow.instance({
            workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "complete",
          }),
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
                  .commands.requestStaticMarketplacePublications();
              }),
              runner.drain(),
              then.assert("request Marketplace ingestion", async (ctx) => {
                await ctx.runtime.objects.automations
                  .forOrg("org-1")
                  .commands.requestMarketplaceIngestion(
                    {
                      listingId: MARKETPLACE_LISTING_ID,
                      version: "1.2.1",
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
                workflowName: CODEMODE_WORKFLOW,
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
                      workflowName: CODEMODE_WORKFLOW,
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
              .commands.requestStaticMarketplacePublications();
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
            const firstRequest = await automations.commands.requestMarketplaceIngestion(
              {
                listingId: MARKETPLACE_LISTING_ID,
                version: "1.2.1",
                targetScope: { kind: "org", orgId: "org-1" },
              },
              { execution: installerExecution, propagationContext: null },
            );
            const replayedRequest = await automations.commands.requestMarketplaceIngestion(
              {
                listingId: MARKETPLACE_LISTING_ID,
                version: "1.2.1",
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
                workflowName: CODEMODE_WORKFLOW,
                instanceId: `${workflowInstanceId}:installation`,
              },
            });
            assert(installation.type === "json");
            const installationParams = installation.data.meta.params as {
              trigger?: { type?: unknown; payload?: unknown };
              execution?: { actors?: unknown };
            };
            const installationActors = automationActorsSchema.parse(
              installationParams.execution?.actors,
            );
            const installationBaseActors = createBackofficeServiceExecution({
              scope: { kind: "org", orgId: "org-1" },
              service: {
                type: "automation",
                id: `automation:${workflowInstanceId}:installation`,
              },
            }).actors;
            expect(installationActors).toEqual({
              ...installationBaseActors,
              delegation: [...installationBaseActors.delegation, CODEMODE_CAPABILITY_ACTOR],
            });

            expect(installationParams.trigger).toMatchObject({
              type: "manual",
              payload: {
                listingId: MARKETPLACE_LISTING_ID,
                targetScope: { kind: "org", orgId: "org-1" },
              },
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
                      id: CODEMODE_WORKFLOW,
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
              workflowScriptPath: "/workspace/automations/legacy-test.workflow.js",
              instanceIdTemplate: "legacy-${event.id}",
            },
          }),
          then.assert("ingestion is requested", async (ctx) => {
            await ctx.runtime.objects.automations
              .forOrg("org-1")
              .commands.requestMarketplaceIngestion(
                {
                  listingId: MARKETPLACE_LISTING_ID,
                  version: "1.2.1",
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
              await expect(automations.commands.listMarketplaceIngestions()).resolves.toEqual([]);

              const response = await automations.http.fetch(
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
              workflowScriptPath: "/workspace/automations/unrelated.workflow.js",
              instanceIdTemplate: "unrelated-${event.id}",
            },
          }),
          then.assert("the conflicting ingestion is requested", async (ctx) => {
            await ctx.runtime.objects.automations
              .forOrg("org-1")
              .commands.requestMarketplaceIngestion(
                {
                  listingId: MARKETPLACE_LISTING_ID,
                  version: "1.2.1",
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
            await expect(automations.commands.listMarketplaceIngestions()).resolves.toEqual([]);

            const response = await automations.http.fetch(
              new Request("https://automations.test/api/automations/routes/telegram-test-command"),
            );
            assert(response.ok);
            await expect(response.json()).resolves.toMatchObject({
              name: "Unrelated route",
              priority: 1,
              action: {
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
            await ctx.runtime.objects.automations
              .forOrg("org-1")
              .commands.requestMarketplaceIngestion(
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
              .http.fetch(new Request(url));
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
              await ctx.runtime.objects.automations
                .forOrg("org-1")
                .commands.requestMarketplaceIngestion(
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
                  const response = await upload.http.fetch(new Request(url));
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
            await ctx.runtime.objects.automations
              .forOrg("org-1")
              .commands.requestMarketplaceIngestion(
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
            await upload.commands.setAdminConfig({ provider: "database" }, "org-1");
            await writeUploadFile({
              upload,
              fileKey: MARKETPLACE_ARTIFACT_FILE_KEY,
              content: "locally modified",
            });

            await expect(
              ctx.runtime.objects.automations.forOrg("org-1").commands.requestMarketplaceIngestion(
                {
                  listingId: MARKETPLACE_LISTING_ID,
                  version: "1.2.1",
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
                .http.fetch(new Request(contentUrl));
              assert(response.ok);
              await expect(response.text()).resolves.toBe("locally modified");

              await expect(
                ctx.runtime.objects.automations.forOrg("org-1").commands.getMarketplaceIngestion({
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
              await upload.commands.setAdminConfig({ provider: "database" }, "org-1");
              await writeUploadFile({
                upload,
                fileKey: MARKETPLACE_ARTIFACT_FILE_KEY,
                content: TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE,
              });
              await expect(
                automations.commands.getMarketplaceIngestion({
                  targetScope: { kind: "org", orgId: "org-1" },
                  listingId: MARKETPLACE_LISTING_ID,
                }),
              ).resolves.toBeNull();

              await expect(
                automations.commands.requestMarketplaceIngestion(
                  {
                    listingId: MARKETPLACE_LISTING_ID,
                    version: "1.2.1",
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
                .http.fetch(new Request(contentUrl));
              assert(response.ok);
              await expect(response.text()).resolves.toBe(TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE);

              await expect(
                ctx.runtime.objects.automations.forOrg("org-1").commands.getMarketplaceIngestion({
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
              const response = await upload.http.fetch(new Request(url));
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
            const response = await upload.http.fetch(new Request(url));
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
              const response = await upload.http.fetch(new Request(url));
              assert(response.ok);
              await expect(response.text()).resolves.toBe(TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE);
              await expect(
                ctx.runtime.objects.marketplace.singleton().commands.getPublishedListing({
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
            expect(batchCommitAttempts).toBe(3);
            await expect(
              ctx.runtime.objects.marketplace.singleton().commands.getPublishedListing({
                listingId: MARKETPLACE_LISTING_ID,
              }),
            ).resolves.toBeNull();

            const upload = ctx.runtime.objects.upload.forName(
              marketplaceArtifactUploadName(MARKETPLACE_LISTING_ID),
            );
            const url = new URL("https://upload.test/api/upload/files/by-key/content");
            url.searchParams.set("provider", "database");
            url.searchParams.set("key", `1.0.0/${MARKETPLACE_ARTIFACT_FILE_KEY}`);
            const response = await upload.http.fetch(new Request(url));
            assert(response.status === 404);
          }),
        ],
        options: { allowErroredWorkflows: true },
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
              ctx.runtime.objects.automations.forOrg("org-1").commands.requestMarketplaceIngestion(
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
              .http.fetch(new Request(url));
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
                ctx.runtime.objects.automations.forOrg("org-1").commands.getMarketplaceIngestion({
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
              await ctx.runtime.objects.automations
                .forOrg("org-1")
                .commands.requestMarketplaceIngestion(
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
                  .commands.getMarketplaceIngestion({
                    targetScope: { kind: "org", orgId: "org-1" },
                    listingId: MARKETPLACE_LISTING_ID,
                  });
                const latest = await ctx.runtime.objects.marketplace
                  .singleton()
                  .commands.getLatestPublishedVersions({
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
              await ctx.runtime.objects.automations
                .forOrg("org-1")
                .commands.requestMarketplaceIngestion(
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
              await ctx.runtime.objects.automations
                .forOrg("org-1")
                .commands.requestMarketplaceIngestion(
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
                ctx.runtime.objects.automations.forOrg("org-1").commands.getMarketplaceIngestion({
                  targetScope: { kind: "org", orgId: "org-1" },
                  listingId: MARKETPLACE_LISTING_ID,
                }),
              ).resolves.toMatchObject({ version: "1.1.0" });

              const url = new URL("https://upload.test/api/upload/files/by-key/content");
              url.searchParams.set("provider", "database");
              url.searchParams.set("key", MARKETPLACE_ARTIFACT_FILE_KEY);
              const response = await ctx.runtime.objects.upload
                .forOrg("org-1")
                .http.fetch(new Request(url));
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
              await ctx.runtime.objects.automations
                .forOrg("org-1")
                .commands.requestMarketplaceIngestion(
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
                .http.fetch(new Request(url));
              assert(response.ok);
              await expect(response.text()).resolves.toBe(MARKETPLACE_REMOVED_FILE_SOURCE);
            }),
            then.assert(
              "version 1.1.0 is requested before losing the commit response",
              async (ctx) => {
                loseUpgradeCommitResponse = true;
                await ctx.runtime.objects.automations
                  .forOrg("org-1")
                  .commands.requestMarketplaceIngestion(
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
                .http.fetch(new Request(url));
              assert(response.status === 410);
              await expect(
                ctx.runtime.objects.automations.forOrg("org-1").commands.getMarketplaceIngestion({
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
                ctx.runtime.objects.automations.forOrg("org-1").commands.getMarketplaceIngestion({
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
              await ctx.runtime.objects.automations
                .forOrg("org-1")
                .commands.requestMarketplaceIngestion(
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
              await ctx.runtime.objects.automations
                .forOrg("org-1")
                .commands.requestMarketplaceIngestion(
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
                .http.fetch(new Request(url));
              assert(response.ok);
              await expect(response.text()).resolves.toBe(
                "locally modified and must not be deleted",
              );
              await expect(
                ctx.runtime.objects.automations.forOrg("org-1").commands.getMarketplaceIngestion({
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
                          http: {
                            fetch: async (nextRequest) => await super.fetch(nextRequest),
                          },
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
              await ctx.runtime.objects.automations
                .forOrg("org-1")
                .commands.requestMarketplaceIngestion(
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
                await ctx.runtime.objects.automations
                  .forOrg("org-1")
                  .commands.requestMarketplaceIngestion(
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
              const mainResponse = await upload.http.fetch(new Request(mainUrl));
              assert(mainResponse.ok);
              await expect(mainResponse.text()).resolves.toBe(
                TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE,
              );

              const assertedUrl = new URL("https://upload.test/api/upload/files/by-key/content");
              assertedUrl.searchParams.set("provider", "database");
              assertedUrl.searchParams.set("key", MARKETPLACE_UNCHANGED_FILE_KEY);
              const assertedResponse = await upload.http.fetch(new Request(assertedUrl));
              assert(assertedResponse.ok);
              await expect(assertedResponse.text()).resolves.toBe("locally changed after planning");

              await expect(
                ctx.runtime.objects.automations.forOrg("org-1").commands.getMarketplaceIngestion({
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
              await ctx.runtime.objects.automations
                .forOrg("org-1")
                .commands.requestMarketplaceIngestion(
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
              await ctx.runtime.objects.automations
                .forOrg("org-1")
                .commands.requestMarketplaceIngestion(
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
                  ctx.runtime.objects.automations.forOrg("org-1").commands.getMarketplaceIngestion({
                    targetScope: { kind: "org", orgId: "org-1" },
                    listingId: MARKETPLACE_LISTING_ID,
                  }),
                ).resolves.toMatchObject({ version: "1.0.0" });

                const url = new URL("https://upload.test/api/upload/files/by-key/content");
                url.searchParams.set("provider", "database");
                url.searchParams.set("key", MARKETPLACE_ARTIFACT_FILE_KEY);
                const response = await ctx.runtime.objects.upload
                  .forOrg("org-1")
                  .http.fetch(new Request(url));
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
            await ctx.runtime.objects.automations
              .forOrg("org-1")
              .commands.requestMarketplaceIngestion(
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
              .http.fetch(new Request(url));
            assert(response.status === 404);
            await expect(
              ctx.runtime.objects.automations.forOrg("org-1").commands.getMarketplaceIngestion({
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
            await ctx.runtime.objects.automations
              .forOrg("org-1")
              .commands.requestMarketplaceIngestion(
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
              .http.fetch(new Request(contentUrl));
            assert(contentResponse.status === 404);
            await expect(
              ctx.runtime.objects.automations.forOrg("org-1").commands.getMarketplaceIngestion({
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
            const archived = await marketplace.commands.archiveListing({
              owner: { scope: { kind: "system" }, publisherName: "Fragno" },
              listingId,
            });
            assert(archived.ok);
            expect(archived.value).toMatchObject({ archived: true });

            await expect(
              ctx.runtime.objects.automations
                .forOrg("org-1")
                .commands.requestStaticMarketplacePublications(),
            ).rejects.toMatchObject({ code: "MARKETPLACE_LISTING_ARCHIVED" });

            await expect(
              marketplace.commands.getPublishedListing({ listingId }),
            ).resolves.toBeNull();
            await expect(
              marketplace.commands.getArtifactManifest({ listingId }),
            ).resolves.toMatchObject({
              listingStatus: "archived",
              versions: ["1.3.0", "1.2.1", "1.1.0", "1.0.0"],
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
            const detail = await ctx.runtime.objects.marketplace
              .singleton()
              .commands.getPublishedListing({
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
