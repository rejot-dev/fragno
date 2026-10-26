import { assert, describe, expect, test, vi } from "vitest";

import { automationActorsSchema } from "@fragno-dev/backoffice-api/v0/automation";
import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  backofficeScopeOrganization,
  type BackofficeOrganizationContextScope,
  type BackofficeRoutableScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

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

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import {
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import type { BackofficeActionRpcContext } from "@/backoffice-runtime/object-registry";
import { BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY } from "@/fragno/automation/actors";
import {
  CODEMODE_CAPABILITY_ACTOR,
  CODEMODE_WORKFLOW,
} from "@/fragno/automation/engine/codemode-invocation";
import { captureBundledMarketplaceRelease } from "@/fragno/marketplace/bundled-release";
import { marketplaceListingId } from "@/fragno/marketplace/owner";
import {
  MARKETPLACE_INSTALL_WORKFLOW_PATH,
  marketplacePackageUploadName,
} from "@/fragno/marketplace/package-files";
import type { MarketplacePackagePublishRequest } from "@/fragno/marketplace/package-publishing";
import {
  STATIC_MARKETPLACE_ENTRIES,
  getStaticMarketplaceEntry,
} from "@/fragno/marketplace/static-entries";

import { ApiObject } from "../../../workers/api-object";
import { AppInstallationsObject } from "../../../workers/app-installations-object";
import { AppsObject } from "../../../workers/apps-object";
import { AuthObject } from "../../../workers/auth-object";
import { AutomationsObject } from "../../../workers/automations-object";
import { BillingObject } from "../../../workers/billing-object";
import { CodemodeObject } from "../../../workers/codemode-object";
import { FormsObject } from "../../../workers/forms-object";
import { MarketplaceObject } from "../../../workers/marketplace-object";
import { McpObject } from "../../../workers/mcp-object";
import { ResendObject } from "../../../workers/resend-object";
import { TelegramObject } from "../../../workers/telegram-object";
import { UploadObject } from "../../../workers/upload-object";
import {
  buildMarketplacePackageInstallWorkflowInstanceId,
  MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
} from "./marketplace-package-install-identity";
import { MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME } from "./marketplace-package-publish-workflow";
import { createAutomationsRouteCaller, createWorkflowsRouteCaller } from "./route-callers";
import {
  bundledMarketplacePermissions,
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "./scenario";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  BILLING: (input) => new BillingObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  FORMS: (input) => new FormsObject(input),
  MARKETPLACE: (input) => new MarketplaceObject(input),
  MCP: (input) => new McpObject(input),
  // The Telegram channel's install workflow defines its agent.
  PI_MANAGER: allLocalObjects.PI_MANAGER,
  RESEND: (input) => new ResendObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const MARKETPLACE_LISTING_ID = marketplaceListingId({
  ownerScope: { kind: "system" },
  slug: "telegram-test-command",
});
const MARKETPLACE_PACKAGE_UPLOAD_OBJECT_NAME = `v1:named:${encodeURIComponent(
  marketplacePackageUploadName({
    marketplace: { kind: "system" },
    listingId: MARKETPLACE_LISTING_ID,
  }),
)}`;
const MARKETPLACE_PACKAGE_FILE_KEY = "automations/telegram-test-command.workflow.js";
const MARKETPLACE_PACKAGE_CONFLICT_MESSAGE =
  "Marketplace ingestion conflicts with workspace file '/workspace/automations/telegram-test-command.workflow.js'.";
const MARKETPLACE_UNCHANGED_FILE_KEY = "prompts/marketplace.md";
const MARKETPLACE_UNCHANGED_FILE_SOURCE = "# Marketplace\n";
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
  (version) => version.version === "2.0.0",
);
if (
  !BASE_STATIC_MARKETPLACE_VERSION ||
  !UPDATED_STATIC_MARKETPLACE_VERSION ||
  !INSTALLER_STATIC_MARKETPLACE_VERSION
) {
  throw new Error("Expected all Telegram test command Marketplace versions.");
}
const TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE =
  BASE_STATIC_MARKETPLACE_VERSION.files[MARKETPLACE_PACKAGE_FILE_KEY];
const CURRENT_TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE = getStaticMarketplaceEntry({
  slug: "telegram-test-command",
  version: "2.0.0",
})?.files[MARKETPLACE_PACKAGE_FILE_KEY];
const TELEGRAM_TEST_COMMAND_PERMISSIONS = bundledMarketplacePermissions({
  slug: "telegram-test-command",
  version: "2.0.0",
});

/**
 * The test command's install workflow waits for its reply message before the installation is
 * recorded. Project installers run in their organization's automations object.
 */
async function submitTelegramTestCommandInstaller(
  ctx: BackofficeScenarioContext,
  targetScope:
    | BackofficeOrganizationContextScope
    | { kind: "project"; owner: BackofficeOrganizationContextScope; projectId: string },
) {
  const coordinator = backofficeScopeOrganization(targetScope);
  const ingestionInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
    marketplace: { kind: "system" },
    installationRoot: "/workspace",
    targetScope,
    listingId: MARKETPLACE_LISTING_ID,
    version: "2.0.0",
  });
  const workflows = createWorkflowsRouteCaller({
    object: ctx.runtime.objects.automations.for(coordinator),
    context: { execution: createBackofficeSystemExecution(coordinator), propagationContext: null },
  });
  const submitted = await workflows("POST", "/:workflowName/instances/:instanceId/events", {
    pathParams: {
      workflowName: CODEMODE_WORKFLOW,
      instanceId: `${ingestionInstanceId}:installation`,
    },
    body: {
      // Event IDs are unique within the coordinating object, which hosts every project installer.
      id: `configure:${ingestionInstanceId}`,
      type: "telegram-test-command.message-configured",
      payload: { message: "Telegram integration verified after a 3 second delay." },
    },
  });
  assert(submitted.type === "json");
}

async function readPackageInstallation(
  ctx: BackofficeScenarioContext,
  input: { targetScope: BackofficeRoutableScope; listingId: string },
) {
  return await ctx.runtime.objects.automations
    .for(input.targetScope)
    .commands.getPackageInstallation({ listingId: input.listingId });
}

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
    scopeRestriction: null,
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
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
    causation: { kind: "origin" },
  };
}

/** Routes come only from a package's declaration, so its install workflow can't write them. */
const ROUTE_WRITING_MARKETPLACE_INSTALL_WORKFLOW_SOURCE = `export default defineWorkflow(
  { name: "route-writing-marketplace-install" },
  async (_event, step) => {
    await step.do("attempt to create a route", async () => {
      await router.create({
        id: "undeclared-route",
        name: "Undeclared route",
        trigger: { kind: "event", source: "telegram", eventType: "message.received" },
        action: { kind: "notify_agent", agentName: "telegram", authority: { kind: "linked-user", grants: "inherit" } },
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

const createMarketplacePublicationWorkflow = async (
  ctx: BackofficeScenarioContext,
  version: string,
) => {
  const entry = getStaticMarketplaceEntry({ slug: "telegram-test-command", version });
  assert(entry);
  const result = await ctx.runtime.objects.marketplace.singleton().commands.publishRelease(
    {
      release: await captureBundledMarketplaceRelease(entry),
      dryRun: false,
      skipAuthorCheck: false,
      skipVersionCheck: true,
    },
    { execution: createBackofficeSystemExecution({ kind: "system" }), propagationContext: null },
  );
  assert(result.state === "requested");
  return result.workflowInstanceId;
};

const writeUploadFile = async (input: {
  content: string;
  fileKey: string;
  upload: { http: { fetch(request: Request): Promise<Response> } };
}) => {
  const form = new FormData();
  form.set("provider", "database");
  form.set("fileKey", input.fileKey);
  form.set("filename", input.fileKey.split("/").at(-1) ?? "package");
  form.set("file", new File([input.content], input.fileKey.split("/").at(-1) ?? "package"));
  const response = await input.upload.http.fetch(
    new Request("https://upload.test/api/upload/files", {
      method: "POST",
      body: form,
    }),
  );
  assert(response.ok);
};

describe("marketplace scenarios", { concurrent: false }, () => {
  test("normal seeding skips published bundled bytes before capture and does not enqueue more workflows", async () => {
    const files = BASE_STATIC_MARKETPLACE_VERSION.files as Record<string, string>;
    const original = files[MARKETPLACE_PACKAGE_FILE_KEY];
    try {
      await runBackofficeScenario(
        defineBackofficeScenario({
          objects: scenarioObjects,
          name: "No capture work for already-published bundled versions",
          steps: ({ then, runner }) => [
            then.assert("request the bundled releases", async (ctx) => {
              const requested = await ctx.runtime.objects.automations
                .singleton()
                .commands.requestStaticMarketplacePublications();
              assert(requested.publications.every((entry) => entry.state === "requested"));
            }),
            runner.drain(),
            then.assert(
              "skip published releases even when current source bytes cannot be captured",
              async (ctx) => {
                files[MARKETPLACE_PACKAGE_FILE_KEY] = "x".repeat(1_048_577);
                const result = await ctx.runtime.objects.automations
                  .singleton()
                  .commands.requestStaticMarketplacePublications();
                assert(result.publications.every((entry) => entry.state === "published"));
                expect(
                  (
                    await ctx.runtime.objects.marketplace
                      .singleton()
                      .commands.getListingStorage({ listingId: MARKETPLACE_LISTING_ID })
                  )?.versions,
                ).toContain("1.0.0");
                const url = new URL("https://upload.test/api/upload/files/by-key/content");
                url.searchParams.set("provider", "database");
                url.searchParams.set("key", `1.0.0/${MARKETPLACE_PACKAGE_FILE_KEY}`);
                const response = await ctx.runtime.objects.upload
                  .forName(
                    marketplacePackageUploadName({
                      marketplace: { kind: "system" },
                      listingId: MARKETPLACE_LISTING_ID,
                    }),
                  )
                  .http.fetch(new Request(url));
                await expect(response.text()).resolves.toBe(original);
              },
            ),
            runner.drain(),
          ],
        }),
      );
    } finally {
      files[MARKETPLACE_PACKAGE_FILE_KEY] = original;
    }
  });

  test("force-publishes with fresh workflow IDs and overwrites package files", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "force-publish bundled Marketplace packages",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("the normal publication is requested", async (ctx) => {
            const requested = await ctx.runtime.objects.automations
              .singleton()
              .commands.requestStaticMarketplacePublications();
            ctx.vars.originalPublicationIds = requested.publications.flatMap((publication) =>
              publication.state === "requested" ? [publication.workflowInstanceId] : [],
            );
          }),
          runner.drain(),
          then.assert(
            "the forced publication repairs changed files with a fresh workflow",
            async (ctx) => {
              await writeUploadFile({
                content: "Changed outside the publisher",
                fileKey: `1.0.0/${MARKETPLACE_PACKAGE_FILE_KEY}`,
                upload: ctx.runtime.objects.upload.forName(
                  marketplacePackageUploadName({
                    marketplace: { kind: "system" },
                    listingId: MARKETPLACE_LISTING_ID,
                  }),
                ),
              });
              const forced = await ctx.runtime.objects.automations
                .singleton()
                .commands.requestStaticMarketplacePublications({ force: true });
              const repair = forced.publications.find(
                (publication) =>
                  publication.listingId === MARKETPLACE_LISTING_ID &&
                  publication.version === "1.0.0",
              );
              assert(repair?.state === "requested");
              expect(ctx.vars.originalPublicationIds).not.toContain(repair.workflowInstanceId);
            },
          ),
          runner.drain(),
          then.assert("the overwritten packages remain published", async (ctx) => {
            await expect(
              ctx.runtime.objects.marketplace
                .singleton()
                .commands.getListingStorage({ listingId: MARKETPLACE_LISTING_ID }),
            ).resolves.toMatchObject({
              listingStatus: "published",
              versions: ["2.0.0", "1.4.0", "1.3.0", "1.2.1", "1.1.0", "1.0.0"],
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
        objects: scenarioObjects,
        name: "install the built-in Telegram and GitHub channels",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then, runner }) => [
          then.assert("publish the built-in Marketplace channels", async (ctx) => {
            await ctx.runtime.objects.automations
              .singleton()
              .commands.requestStaticMarketplacePublications();
          }),
          runner.drain(),
          then.assert("request both channel installations", async (ctx) => {
            const automations = ctx.runtime.objects.automations.for({
              kind: "org",
              orgId: "org-1",
              jurisdiction: null,
            });
            const execution = {
              execution: createBackofficeSystemExecution({
                kind: "org",
                orgId: "org-1",
                jurisdiction: null,
              }),
              propagationContext: null,
            };

            await expect(
              automations.commands.requestMarketplaceIngestion(
                {
                  marketplace: { kind: "system" },
                  installationRoot: "/workspace",
                  listingId: telegramChannelListingId,
                  version: "2.1.0",
                  targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
                  permissions: bundledMarketplacePermissions({
                    slug: "telegram-channel",
                    version: "2.1.0",
                  }),
                },
                execution,
              ),
            ).resolves.toMatchObject({ state: "requested", version: "2.1.0" });
            await expect(
              automations.commands.requestMarketplaceIngestion(
                {
                  marketplace: { kind: "system" },
                  installationRoot: "/workspace",
                  listingId: githubChannelListingId,
                  version: "1.2.0",
                  targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
                  permissions: bundledMarketplacePermissions({
                    slug: "github-channel",
                    version: "1.2.0",
                  }),
                },
                execution,
              ),
            ).resolves.toMatchObject({ state: "requested", version: "1.2.0" });
          }),
          runner.drain(),
          then.assert("both channels manage their declared routes and events", async (ctx) => {
            const automations = ctx.runtime.objects.automations.for({
              kind: "org",
              orgId: "org-1",
              jurisdiction: null,
            });
            const expectedRoutes = [
              ["telegram-start-linking", telegramChannelListingId],
              ["telegram-identity-claim-completed", telegramChannelListingId],
              ["telegram-pi-linking", telegramChannelListingId],
              ["telegram-pi-turn-completed", telegramChannelListingId],
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
                steward: { kind: "package", listingId },
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
                steward: { kind: "package", listingId: githubChannelListingId },
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
            scope: { kind: "org", orgId: "org-1", jurisdiction: null },
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
            scope: { kind: "org", orgId: "org-1", jurisdiction: null },
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
        objects: scenarioObjects,
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
            owner: { kind: "org", orgId: "org-1", jurisdiction: null },
            slug: "telegram-project",
            name: "Telegram Project",
            createdByUserId: "user-1",
            captureIdAs: "projectId",
          }),
          runner.drain(),
          then.assert("publish the built-in Marketplace channels", async (ctx) => {
            await ctx.runtime.objects.automations
              .singleton()
              .commands.requestStaticMarketplacePublications();
          }),
          runner.drain(),
          then.assert("request project and personal installations", async (ctx) => {
            const projectId = ctx.vars.projectId;
            assert(typeof projectId === "string");
            const automations = ctx.runtime.objects.automations.for({
              kind: "org",
              orgId: "org-1",
              jurisdiction: null,
            });
            const execution = {
              execution: createBackofficeSystemExecution({
                kind: "org",
                orgId: "org-1",
                jurisdiction: null,
              }),
              propagationContext: null,
            };

            for (const targetScope of [
              {
                kind: "project",
                owner: { kind: "org" as const, orgId: "org-1", jurisdiction: null },
                projectId,
              },
              { kind: "user", userId: "user-1", jurisdiction: null },
            ] as const) {
              await expect(
                automations.commands.requestMarketplaceIngestion(
                  {
                    marketplace: { kind: "system" },
                    installationRoot: "/workspace",
                    listingId: telegramChannelListingId,
                    version: "2.1.0",
                    targetScope,
                    permissions: bundledMarketplacePermissions({
                      slug: "telegram-channel",
                      version: "2.1.0",
                    }),
                  },
                  execution,
                ),
              ).resolves.toMatchObject({ state: "requested", version: "2.1.0" });
            }
          }),
          runner.drain(),
          then.assert("both scopes contain the installed Telegram routes", async (ctx) => {
            const projectId = ctx.vars.projectId;
            assert(typeof projectId === "string");

            for (const targetScope of [
              {
                kind: "project",
                owner: { kind: "org" as const, orgId: "org-1", jurisdiction: null },
                projectId,
              },
              { kind: "user", userId: "user-1", jurisdiction: null },
            ] as const) {
              await expect(
                readPackageInstallation(ctx, {
                  listingId: telegramChannelListingId,
                  targetScope,
                }),
              ).resolves.toMatchObject({ version: "2.1.0" });

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
                  steward: { kind: "package", listingId: telegramChannelListingId },
                });
              }
            }
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("ingests a published package into organization and project workspaces", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "ingest marketplace package into scoped workspaces",

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then, runner }) => [
          when.codemode.run({
            scope: { kind: "system" },
            label: "publish the bundled marketplace package",
            code: "async () => await admin.marketplacePushStatic({})",
            assertToolCalls: ["admin.marketplace.push-static"],
          }),

          then.assert("organization and project ingestions are requested", async (ctx) => {
            const automations = ctx.runtime.objects.automations.for({
              kind: "org",
              orgId: "org-1",
              jurisdiction: null,
            });
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
                  marketplace: { kind: "system" },
                  installationRoot: "/workspace",
                  listingId,
                  version: "2.0.0",
                  targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
                  permissions: TELEGRAM_TEST_COMMAND_PERMISSIONS,
                },
                {
                  execution: createBackofficeSystemExecution({
                    kind: "org",
                    orgId: "org-1",
                    jurisdiction: null,
                  }),
                  propagationContext: null,
                },
              ),
            ).resolves.toMatchObject({ state: "requested", version: "2.0.0" });
            await expect(
              automations.commands.requestMarketplaceIngestion(
                {
                  marketplace: { kind: "system" },
                  installationRoot: "/workspace",
                  listingId,
                  version: "2.0.0",
                  targetScope: {
                    kind: "project",
                    owner: { kind: "org" as const, orgId: "org-1", jurisdiction: null },
                    projectId: project.id,
                  },
                  permissions: TELEGRAM_TEST_COMMAND_PERMISSIONS,
                },
                {
                  execution: createBackofficeSystemExecution({
                    kind: "org",
                    orgId: "org-1",
                    jurisdiction: null,
                  }),
                  propagationContext: null,
                },
              ),
            ).resolves.toMatchObject({ state: "requested", version: "2.0.0" });

            ctx.vars.projectId = project.id;
          }),

          runner.drain(),
          then.assert("each installer receives its reply message", async (ctx) => {
            await submitTelegramTestCommandInstaller(ctx, {
              kind: "org",
              orgId: "org-1",
              jurisdiction: null,
            });
            await submitTelegramTestCommandInstaller(ctx, {
              kind: "project",
              owner: { kind: "org" as const, orgId: "org-1", jurisdiction: null },
              projectId: String(ctx.vars.projectId),
            });
          }),
          runner.drain(),

          then.assert(
            "each destination has independent successful ingestion state",
            async (ctx) => {
              for (const targetScope of [
                { kind: "org" as const, orgId: "org-1", jurisdiction: null },
                {
                  kind: "project" as const,
                  owner: { kind: "org" as const, orgId: "org-1", jurisdiction: null },
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
                  CURRENT_TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE,
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
                  steward: { kind: "package", listingId: MARKETPLACE_LISTING_ID },
                });
              }
            },
          ),
        ],
      }),
    );
  });

  test("an install workflow cannot write routes, even when its installer may", async () => {
    const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      installationRoot: "/workspace",
      targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
      listingId: MARKETPLACE_LISTING_ID,
      version: "2.0.0",
    });

    await withMarketplaceInstallerSource(
      ROUTE_WRITING_MARKETPLACE_INSTALL_WORKFLOW_SOURCE,
      async () => {
        await runBackofficeScenario(
          defineBackofficeScenario({
            objects: scenarioObjects,
            name: "deny a Marketplace install workflow writing routes",
            setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
            steps: ({ then, runner }) => [
              then.assert("publish the Marketplace package", async (ctx) => {
                await ctx.runtime.objects.automations
                  .singleton()
                  .commands.requestStaticMarketplacePublications();
              }),
              runner.drain(),
              then.assert("request Marketplace ingestion", async (ctx) => {
                await ctx.runtime.objects.automations
                  .for({ kind: "org", orgId: "org-1", jurisdiction: null })
                  .commands.requestMarketplaceIngestion(
                    {
                      marketplace: { kind: "system" },
                      installationRoot: "/workspace",
                      listingId: MARKETPLACE_LISTING_ID,
                      version: "2.0.0",
                      targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
                      permissions: TELEGRAM_TEST_COMMAND_PERMISSIONS,
                    },
                    {
                      execution: createBackofficeSystemExecution({
                        kind: "org",
                        orgId: "org-1",
                        jurisdiction: null,
                      }),
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
                workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
                instanceId: workflowInstanceId,
                status: "errored",
              }),
              then.assert(
                "the installer failed at the delegated capability boundary",
                async (ctx) => {
                  const workflows = createWorkflowsRouteCaller({
                    object: ctx.runtime.objects.automations.for({
                      kind: "org",
                      orgId: "org-1",
                      jurisdiction: null,
                    }),
                    context: {
                      execution: createBackofficeSystemExecution({
                        kind: "org",
                        orgId: "org-1",
                        jurisdiction: null,
                      }),
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
                    `Delegated capability '${CODEMODE_WORKFLOW}' is not granted router.modify`,
                  );
                },
              ),
              then.router.missing({ orgId: "org-1", id: "undeclared-route" }),
              then.router.missing({ orgId: "org-1", id: "telegram-test-command" }),
            ],
            options: { allowErroredWorkflows: true },
          }),
        );
      },
    );
  });

  test("records the installer as the author of the routes a package declares", async () => {
    const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      installationRoot: "/workspace",
      targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
      listingId: MARKETPLACE_LISTING_ID,
      version: "2.0.0",
    });
    const installerExecution = createBackofficeUserExecution({
      scope: { kind: "org", orgId: "org-1", jurisdiction: null },
      userId: "marketplace-installer",
    });

    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "record the installer of a package's routes",
        setup: ({ given }) => [
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "marketplace-installer",
          }),
        ],
        steps: ({ then, runner }) => [
          then.assert("the Marketplace package is published", async (ctx) => {
            await ctx.runtime.objects.automations
              .singleton()
              .commands.requestStaticMarketplacePublications();
          }),
          runner.drain(),
          then.assert("a member requests the installation twice", async (ctx) => {
            const automations = ctx.runtime.objects.automations.for({
              kind: "org",
              orgId: "org-1",
              jurisdiction: null,
            });
            const firstRequest = await automations.commands.requestMarketplaceIngestion(
              {
                marketplace: { kind: "system" },
                installationRoot: "/workspace",
                listingId: MARKETPLACE_LISTING_ID,
                version: "2.0.0",
                targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
                permissions: TELEGRAM_TEST_COMMAND_PERMISSIONS,
              },
              { execution: installerExecution, propagationContext: null },
            );
            const replayedRequest = await automations.commands.requestMarketplaceIngestion(
              {
                marketplace: { kind: "system" },
                installationRoot: "/workspace",
                listingId: MARKETPLACE_LISTING_ID,
                version: "2.0.0",
                targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
                permissions: TELEGRAM_TEST_COMMAND_PERMISSIONS,
              },
              { execution: installerExecution, propagationContext: null },
            );
            expect(replayedRequest.workflowInstanceId).toBe(firstRequest.workflowInstanceId);
          }),
          runner.drain(),
          then.assert("the installer receives its reply message", (ctx) =>
            submitTelegramTestCommandInstaller(ctx, {
              kind: "org",
              orgId: "org-1",
              jurisdiction: null,
            }),
          ),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "complete",
            actors: installerExecution.actors,
          }),
          then.assert("ingestion and installation preserve requester actors", async (ctx) => {
            const workflows = createWorkflowsRouteCaller({
              object: ctx.runtime.objects.automations.for({
                kind: "org",
                orgId: "org-1",
                jurisdiction: null,
              }),
              context: {
                execution: createBackofficeSystemExecution({
                  kind: "org",
                  orgId: "org-1",
                  jurisdiction: null,
                }),
                propagationContext: null,
              },
            });
            const requesterActors = installerExecution.actors;

            const ingestion = await workflows("GET", "/:workflowName/instances/:instanceId", {
              pathParams: {
                workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
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
              scope: { kind: "org", orgId: "org-1", jurisdiction: null },
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
                targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
              },
            });
          }),
          then.assert("the package's route records the installer as its author", async (ctx) => {
            const routes = createAutomationsRouteCaller({
              object: ctx.runtime.objects.automations.for({
                kind: "org",
                orgId: "org-1",
                jurisdiction: null,
              }),
              context: {
                execution: createBackofficeSystemExecution({
                  kind: "org",
                  orgId: "org-1",
                  jurisdiction: null,
                }),
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
              enabled: true,
              priority: 110,
              action: {
                kind: "start_workflow",
                authority: {
                  kind: "organization-automation",
                  grants: [
                    BACKOFFICE_PERMISSION.integrations.execute,
                    BACKOFFICE_PERMISSION.packages.read,
                  ],
                },
                workflowScriptPath: "/workspace/automations/telegram-test-command.workflow.js",
                instanceIdTemplate: "telegram-test-${event.id}",
              },
              steward: { kind: "package", listingId: MARKETPLACE_LISTING_ID },
              metadata: {
                createdByActors: installerExecution.actors,
                updatedByActors: installerExecution.actors,
              },
            });
          }),
        ],
      }),
    );
  });

  test("refuses to install a package whose route id a member already uses", async () => {
    const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      installationRoot: "/workspace",
      targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
      listingId: MARKETPLACE_LISTING_ID,
      version: "2.0.0",
    });

    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "reject an unrelated Marketplace route collision",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then, runner }) => [
          when.codemode.run({
            scope: { kind: "system" },
            label: "publish the bundled marketplace package",
            code: "async () => await admin.marketplacePushStatic({})",
            assertToolCalls: ["admin.marketplace.push-static"],
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
              authority: { kind: "organization-automation", grants: [] },
              workflowScriptPath: "/workspace/automations/unrelated.workflow.js",
              instanceIdTemplate: "unrelated-${event.id}",
            },
          }),
          then.assert("the conflicting ingestion is requested", async (ctx) => {
            await ctx.runtime.objects.automations
              .for({ kind: "org", orgId: "org-1", jurisdiction: null })
              .commands.requestMarketplaceIngestion(
                {
                  marketplace: { kind: "system" },
                  installationRoot: "/workspace",
                  listingId: MARKETPLACE_LISTING_ID,
                  version: "2.0.0",
                  targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
                  permissions: TELEGRAM_TEST_COMMAND_PERMISSIONS,
                },
                {
                  execution: createBackofficeSystemExecution({
                    kind: "org",
                    orgId: "org-1",
                    jurisdiction: null,
                  }),
                  propagationContext: null,
                },
              );
          }),
          runner.drain(),
          then.assert("the install workflow receives its reply message", (ctx) =>
            submitTelegramTestCommandInstaller(ctx, {
              kind: "org",
              orgId: "org-1",
              jurisdiction: null,
            }),
          ),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "errored",
          }),
          then.assert(
            "the member's route is preserved and no installation is recorded",
            async (ctx) => {
              const automations = ctx.runtime.objects.automations.for({
                kind: "org",
                orgId: "org-1",
                jurisdiction: null,
              });
              await expect(
                readPackageInstallation(ctx, {
                  targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
                  listingId: MARKETPLACE_LISTING_ID,
                }),
              ).resolves.toBeNull();

              const response = await automations.http.fetch(
                new Request(
                  "https://automations.test/api/automations/routes/telegram-test-command",
                ),
              );
              assert(response.ok);
              await expect(response.json()).resolves.toMatchObject({
                name: "Unrelated route",
                priority: 1,
                action: {
                  workflowScriptPath: "/workspace/automations/unrelated.workflow.js",
                },
                steward: { kind: "members" },
              });
            },
          ),
        ],
        options: { allowErroredWorkflows: true },
      }),
    );
  });

  test("retries a lost ingestion transfer response without creating another upload session", async () => {
    const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      installationRoot: "/workspace",
      targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.0.0",
    });
    let createUploadAttempts = 0;
    let transferUploadAttempts = 0;
    let loseFirstTransferResponse = true;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "replay marketplace ingestion transfer without recreating its upload",
        objects: {
          ...scenarioObjects,
          UPLOAD: ({ name, state, env, implementation }) => {
            const destinationObject = name.endsWith("v1:org:org-1");
            return new (class extends UploadObject {
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
            })({ state, env: env as never, implementation });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner, when }) => [
          then.assert("the Marketplace package is published", async (ctx) => {
            await createMarketplacePublicationWorkflow(ctx, "1.0.0");
          }),
          runner.drain(),
          then.assert("ingestion is requested", async (ctx) => {
            await ctx.runtime.objects.automations
              .for({ kind: "org", orgId: "org-1", jurisdiction: null })
              .commands.requestMarketplaceIngestion(
                {
                  marketplace: { kind: "system" },
                  installationRoot: "/workspace",
                  listingId: MARKETPLACE_LISTING_ID,
                  targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
                },
                {
                  execution: createBackofficeSystemExecution({
                    kind: "org",
                    orgId: "org-1",
                    jurisdiction: null,
                  }),
                  propagationContext: null,
                },
              );
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "waiting",
          }),
          then.assert("the completed create step is not repeated", () => {
            expect(createUploadAttempts).toBe(1);
            expect(transferUploadAttempts).toBe(1);
          }),
          runner.restartObject({
            binding: "AUTOMATIONS",
            scope: { kind: "org", orgId: "org-1", jurisdiction: null },
          }),
          when.time.advance("1 s"),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "complete",
          }),
          then.assert("only the ingestion transfer step is replayed", async (ctx) => {
            expect(createUploadAttempts).toBe(1);
            expect(transferUploadAttempts).toBe(2);

            const url = new URL("https://upload.test/api/upload/files/by-key/content");
            url.searchParams.set("provider", "database");
            url.searchParams.set("key", MARKETPLACE_PACKAGE_FILE_KEY);
            const response = await ctx.runtime.objects.upload
              .for({ kind: "org", orgId: "org-1", jurisdiction: null })
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
      const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
        marketplace: { kind: "system" },
        installationRoot: "/workspace",
        targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
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
          objects: {
            ...scenarioObjects,
            UPLOAD: ({ name, state, env, implementation }) => {
              const destinationObject = name.endsWith("v1:org:org-1");
              return new (class extends UploadObject {
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
              })({ state, env: env as never, implementation });
            },
          },
          setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
          steps: ({ then, runner, when }) => [
            then.assert("the two-file Marketplace package is published", async (ctx) => {
              await createMarketplacePublicationWorkflow(ctx, "1.0.0");
            }),
            runner.drain(),
            then.assert("the two-file ingestion is requested", async (ctx) => {
              await ctx.runtime.objects.automations
                .for({ kind: "org", orgId: "org-1", jurisdiction: null })
                .commands.requestMarketplaceIngestion(
                  {
                    marketplace: { kind: "system" },
                    installationRoot: "/workspace",
                    listingId: MARKETPLACE_LISTING_ID,
                    targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
                  },
                  {
                    execution: createBackofficeSystemExecution({
                      kind: "org",
                      orgId: "org-1",
                      jurisdiction: null,
                    }),
                    propagationContext: null,
                  },
                );
            }),
            runner.drain(),
            then.workflow.instance({
              workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
              instanceId: workflowInstanceId,
              status: "waiting",
            }),
            then.assert("both upload sessions were created exactly once", () => {
              expect(createAttempts).toEqual(
                new Map([
                  [MARKETPLACE_PACKAGE_FILE_KEY, 1],
                  [MARKETPLACE_UNCHANGED_FILE_KEY, 1],
                ]),
              );
              expect(transferAttempts).toEqual(
                new Map([
                  [MARKETPLACE_PACKAGE_FILE_KEY, 1],
                  [MARKETPLACE_UNCHANGED_FILE_KEY, 1],
                ]),
              );
            }),
            runner.restartObject({
              binding: "AUTOMATIONS",
              scope: { kind: "org", orgId: "org-1", jurisdiction: null },
            }),
            when.time.advance("1 s"),
            then.workflow.instance({
              workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
              instanceId: workflowInstanceId,
              status: "complete",
            }),
            then.assert(
              "replay transfers only the incomplete step and commits every write",
              async (ctx) => {
                expect(createAttempts).toEqual(
                  new Map([
                    [MARKETPLACE_PACKAGE_FILE_KEY, 1],
                    [MARKETPLACE_UNCHANGED_FILE_KEY, 1],
                  ]),
                );
                expect(transferAttempts).toEqual(
                  new Map([
                    [MARKETPLACE_PACKAGE_FILE_KEY, 1],
                    [MARKETPLACE_UNCHANGED_FILE_KEY, 2],
                  ]),
                );

                const upload = ctx.runtime.objects.upload.for({
                  kind: "org",
                  orgId: "org-1",
                  jurisdiction: null,
                });
                for (const [fileKey, expectedContent] of [
                  [MARKETPLACE_PACKAGE_FILE_KEY, TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE],
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
    const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      installationRoot: "/workspace",
      targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.0.0",
    });
    let createUploadAttempts = 0;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "reject permanent marketplace ingestion Upload errors",
        objects: {
          ...scenarioObjects,
          UPLOAD: ({ name, state, env, implementation }) => {
            const destinationObject = name.endsWith("v1:org:org-1");
            return new (class extends UploadObject {
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
            })({ state, env: env as never, implementation });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("the Marketplace package is published", async (ctx) => {
            await createMarketplacePublicationWorkflow(ctx, "1.0.0");
          }),
          runner.drain(),
          then.assert("ingestion is requested", async (ctx) => {
            await ctx.runtime.objects.automations
              .for({ kind: "org", orgId: "org-1", jurisdiction: null })
              .commands.requestMarketplaceIngestion(
                {
                  marketplace: { kind: "system" },
                  installationRoot: "/workspace",
                  listingId: MARKETPLACE_LISTING_ID,
                  targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
                },
                {
                  execution: createBackofficeSystemExecution({
                    kind: "org",
                    orgId: "org-1",
                    jurisdiction: null,
                  }),
                  propagationContext: null,
                },
              );
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
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
    const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      installationRoot: "/workspace",
      targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.2.1",
    });

    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "preserve an existing Marketplace ingestion target file",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then, runner }) => [
          when.codemode.run({
            scope: { kind: "system" },
            label: "publish the bundled marketplace package",
            code: "async () => await admin.marketplacePushStatic({})",
            assertToolCalls: ["admin.marketplace.push-static"],
          }),
          then.assert("a file already exists at the Marketplace target path", async (ctx) => {
            const upload = ctx.runtime.objects.upload.for({
              kind: "org",
              orgId: "org-1",
              jurisdiction: null,
            });
            await writeUploadFile({
              upload,
              fileKey: MARKETPLACE_PACKAGE_FILE_KEY,
              content: "locally modified",
            });

            await expect(
              ctx.runtime.objects.automations
                .for({ kind: "org", orgId: "org-1", jurisdiction: null })
                .commands.requestMarketplaceIngestion(
                  {
                    marketplace: { kind: "system" },
                    installationRoot: "/workspace",
                    listingId: MARKETPLACE_LISTING_ID,
                    version: "1.2.1",
                    targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
                  },
                  {
                    execution: createBackofficeSystemExecution({
                      kind: "org",
                      orgId: "org-1",
                      jurisdiction: null,
                    }),
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
              object: ctx.runtime.objects.automations.for({
                kind: "org",
                orgId: "org-1",
                jurisdiction: null,
              }),
              context: {
                execution: createBackofficeSystemExecution({
                  kind: "org",
                  orgId: "org-1",
                  jurisdiction: null,
                }),
                propagationContext: null,
              },
            });
            const instance = await workflows("GET", "/:workflowName/instances/:instanceId", {
              pathParams: {
                workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
                instanceId: workflowInstanceId,
              },
            });
            assert(instance.type === "json");
            expect(instance.data.details).toMatchObject({
              status: "errored",
              error: {
                name: "NonRetryableError",
                message: MARKETPLACE_PACKAGE_CONFLICT_MESSAGE,
              },
            });
          }),
          then.assert(
            "the existing file remains unchanged and is not recorded as installed",
            async (ctx) => {
              const contentUrl = new URL("https://upload.test/api/upload/files/by-key/content");
              contentUrl.searchParams.set("provider", "database");
              contentUrl.searchParams.set("key", MARKETPLACE_PACKAGE_FILE_KEY);
              const response = await ctx.runtime.objects.upload
                .for({ kind: "org", orgId: "org-1", jurisdiction: null })
                .http.fetch(new Request(contentUrl));
              assert(response.ok);
              await expect(response.text()).resolves.toBe("locally modified");

              await expect(
                readPackageInstallation(ctx, {
                  targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
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
    const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      installationRoot: "/workspace",
      targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.2.1",
    });

    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "reject Marketplace ingestion over a legacy starter-seeded version",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then, runner }) => [
          when.codemode.run({
            scope: { kind: "system" },
            label: "publish both bundled Marketplace versions",
            code: "async () => await admin.marketplacePushStatic({})",
            assertToolCalls: ["admin.marketplace.push-static"],
          }),
          then.assert(
            "the legacy starter seeded the version 1.0.0 file without a lock entry",
            async (ctx) => {
              const automations = ctx.runtime.objects.automations.for({
                kind: "org",
                orgId: "org-1",
                jurisdiction: null,
              });
              const upload = ctx.runtime.objects.upload.for({
                kind: "org",
                orgId: "org-1",
                jurisdiction: null,
              });
              await writeUploadFile({
                upload,
                fileKey: MARKETPLACE_PACKAGE_FILE_KEY,
                content: TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE,
              });
              await expect(
                readPackageInstallation(ctx, {
                  targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
                  listingId: MARKETPLACE_LISTING_ID,
                }),
              ).resolves.toBeNull();

              await expect(
                automations.commands.requestMarketplaceIngestion(
                  {
                    marketplace: { kind: "system" },
                    installationRoot: "/workspace",
                    listingId: MARKETPLACE_LISTING_ID,
                    version: "1.2.1",
                    targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
                  },
                  {
                    execution: createBackofficeSystemExecution({
                      kind: "org",
                      orgId: "org-1",
                      jurisdiction: null,
                    }),
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
            "the existing legacy file conflicts with the requested package",
            async (ctx) => {
              const workflows = createWorkflowsRouteCaller({
                object: ctx.runtime.objects.automations.for({
                  kind: "org",
                  orgId: "org-1",
                  jurisdiction: null,
                }),
                context: {
                  execution: createBackofficeSystemExecution({
                    kind: "org",
                    orgId: "org-1",
                    jurisdiction: null,
                  }),
                  propagationContext: null,
                },
              });
              const instance = await workflows("GET", "/:workflowName/instances/:instanceId", {
                pathParams: {
                  workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
                  instanceId: workflowInstanceId,
                },
              });
              assert(instance.type === "json");
              expect(instance.data.details).toMatchObject({
                status: "errored",
                error: {
                  name: "NonRetryableError",
                  message: MARKETPLACE_PACKAGE_CONFLICT_MESSAGE,
                },
              });
            },
          ),
          then.assert(
            "the version 1.0.0 file remains and Marketplace is not installed",
            async (ctx) => {
              const contentUrl = new URL("https://upload.test/api/upload/files/by-key/content");
              contentUrl.searchParams.set("provider", "database");
              contentUrl.searchParams.set("key", MARKETPLACE_PACKAGE_FILE_KEY);
              const response = await ctx.runtime.objects.upload
                .for({ kind: "org", orgId: "org-1", jurisdiction: null })
                .http.fetch(new Request(contentUrl));
              assert(response.ok);
              await expect(response.text()).resolves.toBe(TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE);

              await expect(
                readPackageInstallation(ctx, {
                  targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
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
    const originalSource = baseEntryFiles[MARKETPLACE_PACKAGE_FILE_KEY];
    let rejectReservation = true;

    try {
      await runBackofficeScenario(
        defineBackofficeScenario({
          name: "replay marketplace publication from a durable static snapshot",
          objects: {
            ...scenarioObjects,
            MARKETPLACE: ({ state, env, runtime, implementation }) =>
              new (class extends MarketplaceObject {
                async beginPackagePublish(
                  input: MarketplacePackagePublishRequest,
                  context: BackofficeActionRpcContext,
                ) {
                  if (rejectReservation) {
                    rejectReservation = false;
                    throw new Error("Temporary Marketplace reservation failure.");
                  }
                  return await super.beginPackagePublish(input, context);
                }
              })({ state, env, runtime, implementation }),
          },
          setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
          steps: ({ when, then, runner }) => [
            then.assert("version 1.0.0 publication is requested without draining", async (ctx) => {
              await createMarketplacePublicationWorkflow(ctx, "1.0.0");
            }),
            runner.drain(),
            then.workflow.instance({
              workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
              status: "waiting",
            }),
            then.assert("the bundled source changes after capture and acceptance", () => {
              baseEntryFiles[MARKETPLACE_PACKAGE_FILE_KEY] = "changed after snapshot";
            }),
            runner.restartObject({
              binding: "AUTOMATIONS",
              scope: { kind: "singleton" },
            }),
            when.time.advance("1 s"),
            then.workflow.instance({
              workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
              status: "complete",
            }),
            then.assert("publication uses the source captured before restart", async (ctx) => {
              const upload = ctx.runtime.objects.upload.forName(
                marketplacePackageUploadName({
                  marketplace: { kind: "system" },
                  listingId: MARKETPLACE_LISTING_ID,
                }),
              );
              const url = new URL("https://upload.test/api/upload/files/by-key/content");
              url.searchParams.set("provider", "database");
              url.searchParams.set("key", `1.0.0/${MARKETPLACE_PACKAGE_FILE_KEY}`);
              const response = await upload.http.fetch(new Request(url));
              assert(response.ok);
              await expect(response.text()).resolves.toBe(originalSource);
            }),
          ],
        }),
      );
    } finally {
      if (originalSource !== undefined) {
        baseEntryFiles[MARKETPLACE_PACKAGE_FILE_KEY] = originalSource;
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
        objects: {
          ...scenarioObjects,
          UPLOAD: ({ name, state, env, implementation }) => {
            const packageUploadObject = name.endsWith(MARKETPLACE_PACKAGE_UPLOAD_OBJECT_NAME);
            return new (class extends UploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  packageUploadObject &&
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
                  packageUploadObject &&
                  request.method === "PUT" &&
                  /\/uploads\/[^/]+\/content$/u.test(url.pathname)
                ) {
                  transferUploadAttempts += 1;
                }
                return await super.fetch(request);
              }
            })({ state, env: env as never, implementation });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner, when }) => [
          then.assert("publication is requested", async (ctx) => {
            await createMarketplacePublicationWorkflow(ctx, "1.0.0");
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
            status: "waiting",
          }),
          then.assert("the lost response leaves one reusable upload", () => {
            expect(createUploadAttempts).toBe(1);
            expect(transferUploadAttempts).toBe(0);
            expect(uploadIds).toHaveLength(1);
          }),
          runner.restartObject({
            binding: "AUTOMATIONS",
            scope: { kind: "singleton" },
          }),
          when.time.advance("1 s"),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
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

  test("retries a lost package transfer response without creating another upload session", async () => {
    let createUploadAttempts = 0;
    let transferUploadAttempts = 0;
    let loseFirstTransferResponse = true;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "replay marketplace package transfer without recreating its upload",
        objects: {
          ...scenarioObjects,
          UPLOAD: ({ name, state, env, implementation }) => {
            const packageUploadObject = name.endsWith(MARKETPLACE_PACKAGE_UPLOAD_OBJECT_NAME);
            return new (class extends UploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  packageUploadObject &&
                  request.method === "POST" &&
                  url.pathname.endsWith("/uploads")
                ) {
                  createUploadAttempts += 1;
                }
                if (
                  packageUploadObject &&
                  request.method === "PUT" &&
                  /\/uploads\/[^/]+\/content$/u.test(url.pathname)
                ) {
                  transferUploadAttempts += 1;
                  const response = await super.fetch(request);
                  if (response.ok && loseFirstTransferResponse) {
                    loseFirstTransferResponse = false;
                    throw new Error("Marketplace package transfer response was lost.");
                  }
                  return response;
                }
                return await super.fetch(request);
              }
            })({ state, env: env as never, implementation });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner, when }) => [
          then.assert("publication is requested", async (ctx) => {
            await createMarketplacePublicationWorkflow(ctx, "1.0.0");
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
            status: "waiting",
          }),
          then.assert("the completed create step is not repeated", () => {
            expect(createUploadAttempts).toBe(1);
            expect(transferUploadAttempts).toBe(1);
          }),
          runner.restartObject({
            binding: "AUTOMATIONS",
            scope: { kind: "singleton" },
          }),
          when.time.advance("1 s"),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
            status: "complete",
          }),
          then.assert("only the failed transfer step is replayed", async (ctx) => {
            expect(createUploadAttempts).toBe(2);
            expect(transferUploadAttempts).toBe(3);

            const upload = ctx.runtime.objects.upload.forName(
              marketplacePackageUploadName({
                marketplace: { kind: "system" },
                listingId: MARKETPLACE_LISTING_ID,
              }),
            );
            const url = new URL("https://upload.test/api/upload/files/by-key/content");
            url.searchParams.set("provider", "database");
            url.searchParams.set("key", `1.0.0/${MARKETPLACE_PACKAGE_FILE_KEY}`);
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
        name: "reject permanent marketplace package upload errors",
        objects: {
          ...scenarioObjects,
          UPLOAD: ({ name, state, env, implementation }) => {
            const packageUploadObject = name.endsWith(MARKETPLACE_PACKAGE_UPLOAD_OBJECT_NAME);
            return new (class extends UploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  packageUploadObject &&
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
            })({ state, env: env as never, implementation });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publication is requested", async (ctx) => {
            await createMarketplacePublicationWorkflow(ctx, "1.0.0");
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
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
        objects: {
          ...scenarioObjects,
          UPLOAD: ({ name, state, env, implementation }) => {
            const packageUploadObject = name.endsWith(MARKETPLACE_PACKAGE_UPLOAD_OBJECT_NAME);
            return new (class extends UploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  packageUploadObject &&
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
            })({ state, env: env as never, implementation });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner, when }) => [
          then.assert("publication is requested", async (ctx) => {
            await createMarketplacePublicationWorkflow(ctx, "1.0.0");
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
            status: "waiting",
          }),
          runner.restartObject({
            binding: "AUTOMATIONS",
            scope: { kind: "singleton" },
          }),
          when.time.advance("1 s"),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
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
        objects: {
          ...scenarioObjects,
          UPLOAD: ({ name, state, env, implementation }) => {
            const packageUploadObject = name.endsWith(MARKETPLACE_PACKAGE_UPLOAD_OBJECT_NAME);
            return new (class extends UploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  packageUploadObject &&
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
            })({ state, env: env as never, implementation });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner, when }) => [
          then.assert("publication is requested", async (ctx) => {
            await createMarketplacePublicationWorkflow(ctx, "1.0.0");
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
            status: "waiting",
          }),
          then.assert(
            "the committed package is ready before Marketplace publication",
            async (ctx) => {
              const upload = ctx.runtime.objects.upload.forName(
                marketplacePackageUploadName({
                  marketplace: { kind: "system" },
                  listingId: MARKETPLACE_LISTING_ID,
                }),
              );
              const url = new URL("https://upload.test/api/upload/files/by-key/content");
              url.searchParams.set("provider", "database");
              url.searchParams.set("key", `1.0.0/${MARKETPLACE_PACKAGE_FILE_KEY}`);
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
            scope: { kind: "singleton" },
          }),
          when.time.advance("1 s"),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
            status: "complete",
          }),
          then.assert("the committed inventory is recognized without another Upload commit", () => {
            expect(batchCommitAttempts).toBe(1);
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
        objects: {
          ...scenarioObjects,
          UPLOAD: ({ name, state, env, implementation }) => {
            const packageUploadObject = name.endsWith(MARKETPLACE_PACKAGE_UPLOAD_OBJECT_NAME);
            return new (class extends UploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  packageUploadObject &&
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
            })({ state, env: env as never, implementation });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner, when }) => [
          then.assert("publication is requested", async (ctx) => {
            await createMarketplacePublicationWorkflow(ctx, "1.0.0");
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
            status: "waiting",
          }),
          when.time.advance("2 hours"),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
            status: "waiting",
          }),
          when.time.advance("2 hours"),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
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
              marketplacePackageUploadName({
                marketplace: { kind: "system" },
                listingId: MARKETPLACE_LISTING_ID,
              }),
            );
            const url = new URL("https://upload.test/api/upload/files/by-key/content");
            url.searchParams.set("provider", "database");
            url.searchParams.set("key", `1.0.0/${MARKETPLACE_PACKAGE_FILE_KEY}`);
            const response = await upload.http.fetch(new Request(url));
            assert(response.status === 404);
          }),
        ],
        options: { allowErroredWorkflows: true },
      }),
    );
  });

  test("replays ingestion after the prepared batch commits but its response is lost", async () => {
    const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      installationRoot: "/workspace",
      targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.0.0",
    });
    let loseFirstBatchCommitResponse = true;
    let batchCommitAttempts = 0;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "replay a committed marketplace ingestion batch",
        objects: {
          ...scenarioObjects,
          UPLOAD: ({ name, state, env, implementation }) => {
            const destinationObject = name.endsWith("v1:org:org-1");
            return new (class extends UploadObject {
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
            })({ state, env: env as never, implementation });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then, runner }) => [
          when.codemode.run({
            scope: { kind: "system" },
            label: "publish the bundled marketplace package",
            code: "async () => await admin.marketplacePushStatic({})",
            assertToolCalls: ["admin.marketplace.push-static"],
          }),
          then.assert("ingestion is requested without draining", async (ctx) => {
            await expect(
              ctx.runtime.objects.automations
                .for({ kind: "org", orgId: "org-1", jurisdiction: null })
                .commands.requestMarketplaceIngestion(
                  {
                    marketplace: { kind: "system" },
                    installationRoot: "/workspace",
                    listingId: MARKETPLACE_LISTING_ID,
                    version: "1.0.0",
                    targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
                  },
                  {
                    execution: createBackofficeSystemExecution({
                      kind: "org",
                      orgId: "org-1",
                      jurisdiction: null,
                    }),
                    propagationContext: null,
                  },
                ),
            ).resolves.toMatchObject({ state: "requested" });
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "waiting",
          }),
          then.assert("the committed batch remains readable", async (ctx) => {
            const url = new URL("https://upload.test/api/upload/files/by-key/content");
            url.searchParams.set("provider", "database");
            url.searchParams.set("key", MARKETPLACE_PACKAGE_FILE_KEY);
            const response = await ctx.runtime.objects.upload
              .for({ kind: "org", orgId: "org-1", jurisdiction: null })
              .http.fetch(new Request(url));
            assert(response.ok);
            await expect(response.text()).resolves.toBe(TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE);
          }),
          runner.restartObject({
            binding: "AUTOMATIONS",
            scope: { kind: "org", orgId: "org-1", jurisdiction: null },
          }),
          when.time.advance("1 s"),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "complete",
          }),
          then.assert(
            "the replay reuses the committed batch and records ingestion",
            async (ctx) => {
              expect(batchCommitAttempts).toBe(2);
              await expect(
                readPackageInstallation(ctx, {
                  targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
                  listingId: MARKETPLACE_LISTING_ID,
                }),
              ).resolves.toMatchObject({ version: "1.0.0" });
            },
          ),
        ],
      }),
    );
  });

  test("rejects source bytes changed between upload creation and transfer", async () => {
    const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      installationRoot: "/workspace",
      targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.0.0",
    });
    let mutateSourceAfterUploadCreation = true;
    let destinationTransferAttempts = 0;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "reject Marketplace source changed before transfer",
        objects: {
          ...scenarioObjects,
          UPLOAD: ({ name, state, env, runtime, implementation }) => {
            const destinationObject = name.endsWith("v1:org:org-1");
            return new (class extends UploadObject {
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
                        marketplacePackageUploadName({
                          marketplace: { kind: "system" },
                          listingId: MARKETPLACE_LISTING_ID,
                        }),
                      ),
                      fileKey: `1.0.0/${MARKETPLACE_PACKAGE_FILE_KEY}`,
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
            })({ state, env: env as never, implementation });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("the Marketplace package is published", async (ctx) => {
            await createMarketplacePublicationWorkflow(ctx, "1.0.0");
          }),
          runner.drain(),
          then.assert("ingestion is requested", async (ctx) => {
            await ctx.runtime.objects.automations
              .for({ kind: "org", orgId: "org-1", jurisdiction: null })
              .commands.requestMarketplaceIngestion(
                {
                  marketplace: { kind: "system" },
                  installationRoot: "/workspace",
                  listingId: MARKETPLACE_LISTING_ID,
                  targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
                },
                {
                  execution: createBackofficeSystemExecution({
                    kind: "org",
                    orgId: "org-1",
                    jurisdiction: null,
                  }),
                  propagationContext: null,
                },
              );
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "errored",
          }),
          then.assert("the changed source is rejected before destination transfer", async (ctx) => {
            expect(destinationTransferAttempts).toBe(0);
            const url = new URL("https://upload.test/api/upload/files/by-key/content");
            url.searchParams.set("provider", "database");
            url.searchParams.set("key", MARKETPLACE_PACKAGE_FILE_KEY);
            const response = await ctx.runtime.objects.upload
              .for({ kind: "org", orgId: "org-1", jurisdiction: null })
              .http.fetch(new Request(url));
            assert(response.status === 404);
            await expect(
              readPackageInstallation(ctx, {
                targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
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
    const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      installationRoot: "/workspace",
      targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
      listingId: MARKETPLACE_LISTING_ID,
      version: "1.0.0",
    });
    let mutateSourceAfterListing = true;

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "reject a marketplace source changed during ingestion",
        objects: {
          ...scenarioObjects,
          UPLOAD: ({ name, state, env, runtime, implementation }) => {
            const destinationObject = name.endsWith("v1:org:org-1");
            return new (class extends UploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  destinationObject &&
                  request.method === "GET" &&
                  url.pathname.endsWith("/files/by-key") &&
                  url.searchParams.get("key") === MARKETPLACE_PACKAGE_FILE_KEY &&
                  mutateSourceAfterListing
                ) {
                  mutateSourceAfterListing = false;
                  await writeUploadFile({
                    upload: runtime.objects.upload.forName(
                      marketplacePackageUploadName({
                        marketplace: { kind: "system" },
                        listingId: MARKETPLACE_LISTING_ID,
                      }),
                    ),
                    fileKey: `1.0.0/${MARKETPLACE_PACKAGE_FILE_KEY}`,
                    content: "source changed after durable listing",
                  });
                }
                return await super.fetch(request);
              }
            })({ state, env: env as never, implementation });
          },
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ when, then, runner }) => [
          when.codemode.run({
            scope: { kind: "system" },
            label: "publish the bundled marketplace package",
            code: "async () => await admin.marketplacePushStatic({})",
            assertToolCalls: ["admin.marketplace.push-static"],
          }),
          then.assert("ingestion is requested", async (ctx) => {
            await ctx.runtime.objects.automations
              .for({ kind: "org", orgId: "org-1", jurisdiction: null })
              .commands.requestMarketplaceIngestion(
                {
                  marketplace: { kind: "system" },
                  installationRoot: "/workspace",
                  listingId: MARKETPLACE_LISTING_ID,
                  version: "1.0.0",
                  targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
                },
                {
                  execution: createBackofficeSystemExecution({
                    kind: "org",
                    orgId: "org-1",
                    jurisdiction: null,
                  }),
                  propagationContext: null,
                },
              );
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "errored",
          }),
          then.assert("the changed source was never written or recorded", async (ctx) => {
            const contentUrl = new URL("https://upload.test/api/upload/files/by-key/content");
            contentUrl.searchParams.set("provider", "database");
            contentUrl.searchParams.set("key", MARKETPLACE_PACKAGE_FILE_KEY);
            const contentResponse = await ctx.runtime.objects.upload
              .for({ kind: "org", orgId: "org-1", jurisdiction: null })
              .http.fetch(new Request(contentUrl));
            assert(contentResponse.status === 404);
            await expect(
              readPackageInstallation(ctx, {
                targetScope: { kind: "org", orgId: "org-1", jurisdiction: null },
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
        objects: scenarioObjects,
        name: "validate marketplace workflow params",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert("invalid publication and ingestion params are rejected", async (ctx) => {
            const workflows = createWorkflowsRouteCaller({
              object: ctx.runtime.objects.automations.for({
                kind: "org",
                orgId: "org-1",
                jurisdiction: null,
              }),
              context: {
                execution: createBackofficeSystemExecution({
                  kind: "org",
                  orgId: "org-1",
                  jurisdiction: null,
                }),
                propagationContext: null,
              },
            });
            const invalidPublication = await workflows("POST", "/:workflowName/instances", {
              pathParams: {
                workflowName: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
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
                workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
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
        objects: scenarioObjects,
        name: "preserve archived bundled marketplace listing",

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.codemode.run({
            scope: { kind: "system" },
            label: "publish the bundled marketplace package",
            code: "async () => await admin.marketplacePushStatic({})",
            assertToolCalls: ["admin.marketplace.push-static"],
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
                .singleton()
                .commands.requestStaticMarketplacePublications(),
            ).rejects.toMatchObject({ code: "MARKETPLACE_LISTING_ARCHIVED" });

            await expect(
              marketplace.commands.getPublishedListing({ listingId }),
            ).resolves.toBeNull();
            await expect(
              marketplace.commands.getListingStorage({ listingId }),
            ).resolves.toMatchObject({
              listingStatus: "archived",
              versions: ["2.0.0", "1.4.0", "1.3.0", "1.2.1", "1.1.0", "1.0.0"],
            });
          }),
        ],
      }),
    );
  });

  test("inserts marketplace entries through scenario setup", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
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
                  "This entry is inserted directly by the scenario runner so download scenarios can attach and retrieve fixture packages later.",
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
