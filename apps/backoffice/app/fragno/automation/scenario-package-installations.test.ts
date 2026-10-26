import { assert, describe, expect, test, vi } from "vitest";

import { MARKETPLACE_LOCK_PATH } from "@fragno-dev/backoffice-api/v0/marketplace";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class DurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }
  class RpcTarget {}
  class WorkerEntrypoint {}
  return { DurableObject, RpcTarget, WorkerEntrypoint };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { CODEMODE_WORKFLOW } from "@/fragno/automation/engine/codemode-invocation";
import { marketplaceListingId } from "@/fragno/marketplace/owner";
import { marketplacePackageUploadName } from "@/fragno/marketplace/package-files";
import { getStaticMarketplaceEntry } from "@/fragno/marketplace/static-entries";
import { sha256Hex } from "@/lib/crypto";

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
  RESEND: (input) => new ResendObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const LISTING_ID = marketplaceListingId({
  ownerScope: { kind: "system" },
  slug: "telegram-test-command",
});
const TELEGRAM_CHANNEL_ID = marketplaceListingId({
  ownerScope: { kind: "system" },
  slug: "telegram-channel",
});
const GITHUB_CHANNEL_ID = marketplaceListingId({
  ownerScope: { kind: "system" },
  slug: "github-channel",
});
const LISTING_SLUGS: Record<string, string> = {
  [LISTING_ID]: "telegram-test-command",
  [TELEGRAM_CHANNEL_ID]: "telegram-channel",
  [GITHUB_CHANNEL_ID]: "github-channel",
};
const WORKFLOW_FILE = "automations/telegram-test-command.workflow.js";
const ROUTE_ID = "telegram-test-command";
const TARGET_SCOPE = { kind: "org", orgId: "org-1" } as const;
const SYSTEM_CONTEXT = {
  execution: createBackofficeSystemExecution(TARGET_SCOPE),
  propagationContext: null,
};

async function publishMarketplacePackages(ctx: BackofficeScenarioContext) {
  await ctx.runtime.objects.automations.singleton().commands.requestStaticMarketplacePublications();
}

/** Installs approve exactly what the release declares. */
async function installMarketplacePackage(
  ctx: BackofficeScenarioContext,
  input: { listingId: string; version: string; installationRoot: string },
) {
  return await ctx.runtime.objects.automations.forOrg("org-1").commands.restartMarketplaceIngestion(
    {
      marketplace: { kind: "system" },
      ...input,
      targetScope: TARGET_SCOPE,
      permissions: bundledMarketplacePermissions({
        slug: LISTING_SLUGS[input.listingId],
        version: input.version,
      }),
    },
    SYSTEM_CONTEXT,
  );
}

/** Answers the test command's install workflow, which asks for its reply message. */
async function submitTestCommandMessage(
  ctx: BackofficeScenarioContext,
  input: { installationRoot: string; version: string; message: string; eventId: string },
) {
  const ingestionInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
    marketplace: { kind: "system" },
    targetScope: TARGET_SCOPE,
    installationRoot: input.installationRoot,
    listingId: LISTING_ID,
    version: input.version,
  });
  const workflows = createWorkflowsRouteCaller({
    object: ctx.runtime.objects.automations.for(TARGET_SCOPE),
    context: SYSTEM_CONTEXT,
  });
  const submitted = await workflows("POST", "/:workflowName/instances/:instanceId/events", {
    pathParams: {
      workflowName: CODEMODE_WORKFLOW,
      instanceId: `${ingestionInstanceId}:installation`,
    },
    body: {
      id: input.eventId,
      type: "telegram-test-command.message-configured",
      payload: { message: input.message },
    },
  });
  assert(submitted.type === "json");
}

async function readInstallation(ctx: BackofficeScenarioContext, listingId: string) {
  return await ctx.runtime.objects.automations
    .for(TARGET_SCOPE)
    .commands.getPackageInstallation({ listingId });
}

function routes(ctx: BackofficeScenarioContext) {
  return createAutomationsRouteCaller({
    object: ctx.runtime.objects.automations.for(TARGET_SCOPE),
    context: SYSTEM_CONTEXT,
  });
}

async function readWorkspaceFile(ctx: BackofficeScenarioContext, path: string) {
  const url = new URL("https://upload.test/api/upload/files/by-key/content");
  url.searchParams.set("provider", "database");
  url.searchParams.set("key", path.slice("/workspace/".length));
  return await ctx.runtime.objects.upload.for(TARGET_SCOPE).http.fetch(new Request(url));
}

async function writeUploadFile(input: {
  content: string;
  fileKey: string;
  fetch: (request: Request) => Promise<Response>;
}) {
  const form = new FormData();
  form.set("provider", "database");
  form.set("fileKey", input.fileKey);
  form.set("filename", input.fileKey.split("/").at(-1)!);
  form.set(
    "checksum",
    JSON.stringify({
      algo: "sha256",
      value: await sha256Hex(new TextEncoder().encode(input.content)),
    }),
  );
  form.set("file", new File([input.content], input.fileKey.split("/").at(-1)!));
  const response = await input.fetch(
    new Request("https://upload.test/api/upload/files", { method: "POST", body: form }),
  );
  assert(response.ok);
}

function publishedWorkflowSource(version: string) {
  const entry = getStaticMarketplaceEntry({ slug: "telegram-test-command", version });
  assert(entry);
  return entry.files[WORKFLOW_FILE];
}

describe("package installation scenarios", () => {
  test("installs a package's declared route, which only the package may change, and re-asks for settings", async () => {
    const installationRoot = "/workspace/packages/telegram";
    const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      targetScope: TARGET_SCOPE,
      installationRoot,
      listingId: LISTING_ID,
      version: "2.0.0",
    });
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "install a package with a declared route and settings",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publish packages", publishMarketplacePackages),
          runner.drain(),
          then.assert("installing without approving its permissions is refused", async (ctx) => {
            await expect(
              ctx.runtime.objects.automations.forOrg("org-1").commands.restartMarketplaceIngestion(
                {
                  marketplace: { kind: "system" },
                  listingId: LISTING_ID,
                  version: "2.0.0",
                  installationRoot,
                  targetScope: TARGET_SCOPE,
                  permissions: [],
                },
                SYSTEM_CONTEXT,
              ),
            ).rejects.toThrow(
              "This release declares the permissions integrations.execute, packages.read, but the installation approved none.",
            );
          }),
          then.assert("install version 2.0.0, approving its permissions", async (ctx) => {
            await expect(
              installMarketplacePackage(ctx, {
                listingId: LISTING_ID,
                version: "2.0.0",
                installationRoot: `${installationRoot}/`,
              }),
            ).resolves.toMatchObject({ action: "created", workflowInstanceId });
          }),
          runner.drain(),
          then.assert("nothing is recorded while the install workflow waits", async (ctx) => {
            await expect(readInstallation(ctx, LISTING_ID)).resolves.toBeNull();
            await submitTestCommandMessage(ctx, {
              installationRoot,
              version: "2.0.0",
              message: "  First reply  ",
              eventId: "configure-first",
            });
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "complete",
          }),
          then.assert(
            "the installation holds its settings, and the package manages its route",
            async (ctx) => {
              await expect(readInstallation(ctx, LISTING_ID)).resolves.toEqual({
                marketplace: { kind: "system" },
                listingId: LISTING_ID,
                version: "2.0.0",
                installationRoot,
                permissions: [
                  { namespace: "integrations", permission: "execute" },
                  { namespace: "packages", permission: "read" },
                ],
                settings: { message: "First reply" },
              });
              const file = await readWorkspaceFile(ctx, `${installationRoot}/${WORKFLOW_FILE}`);
              assert(file.ok);
              await expect(file.text()).resolves.toBe(publishedWorkflowSource("2.0.0"));
              const route = await routes(ctx)("GET", "/routes/:routeId", {
                pathParams: { routeId: ROUTE_ID },
              });
              assert(route.type === "json");
              expect(route.data).toMatchObject({
                enabled: true,
                steward: { kind: "package", listingId: LISTING_ID },
                action: { workflowScriptPath: `${installationRoot}/${WORKFLOW_FILE}` },
              });
            },
          ),
          then.assert(
            "members may disable the package's route, but not change or delete it",
            async (ctx) => {
              const rename = await routes(ctx)("PATCH", "/routes/:routeId", {
                pathParams: { routeId: ROUTE_ID },
                body: { name: "My test command" },
              });
              assert(rename.type === "error");
              assert(rename.error.code === "ROUTE_STEWARDED");
              const deletion = await routes(ctx)("DELETE", "/routes/:routeId", {
                pathParams: { routeId: ROUTE_ID },
              });
              assert(deletion.type === "error");
              assert(deletion.error.code === "ROUTE_STEWARDED");
              const disabled = await routes(ctx)("PATCH", "/routes/:routeId", {
                pathParams: { routeId: ROUTE_ID },
                body: { enabled: false },
              });
              assert(disabled.type === "json");
              expect(disabled.data).toMatchObject({
                enabled: false,
                name: "Telegram /test command",
                steward: { kind: "package", listingId: LISTING_ID },
              });
            },
          ),
          then.assert("install the same version again to change its settings", async (ctx) => {
            await expect(
              installMarketplacePackage(ctx, {
                listingId: LISTING_ID,
                version: "2.0.0",
                installationRoot,
              }),
            ).resolves.toMatchObject({ action: "restarted" });
          }),
          runner.drain(),
          then.assert("the install workflow offers the current reply", async (ctx) => {
            const workflows = createWorkflowsRouteCaller({
              object: ctx.runtime.objects.automations.for(TARGET_SCOPE),
              context: SYSTEM_CONTEXT,
            });
            const history = await workflows("GET", "/:workflowName/instances/:instanceId/history", {
              pathParams: {
                workflowName: CODEMODE_WORKFLOW,
                instanceId: `${workflowInstanceId}:installation`,
              },
            });
            assert(history.type === "json");
            expect(
              history.data.steps.find((step) => step.name === "request test message")?.result,
            ).toMatchObject({ $ui: { state: { response: { message: "First reply" } } } });
            await submitTestCommandMessage(ctx, {
              installationRoot,
              version: "2.0.0",
              message: "Second reply",
              eventId: "configure-second",
            });
          }),
          runner.drain(),
          then.assert("the new settings apply, and the route stays disabled", async (ctx) => {
            await expect(readInstallation(ctx, LISTING_ID)).resolves.toMatchObject({
              settings: { message: "Second reply" },
            });
          }),
          then.router.route({ orgId: "org-1", id: ROUTE_ID, enabled: false }),
        ],
      }),
    );
  });

  test("upgrades an installation imported from a legacy lock, keeping edits to files the new version dropped", async () => {
    const installationRoot = "/workspace/first";
    const upgradeWorkflowId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      targetScope: TARGET_SCOPE,
      installationRoot,
      listingId: LISTING_ID,
      version: "2.0.0",
    });
    await runBackofficeScenario(
      defineBackofficeScenario({
        // Writing to the system-scope package upload runs system automations, which load more objects.
        objects: allLocalObjects,
        name: "upgrade a legacy Marketplace installation in place",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publish packages", publishMarketplacePackages),
          runner.drain(),
          then.assert(
            "version 1.0.0 was installed before installation records, with two notes 2.0.0 drops",
            async (ctx) => {
              const packageUpload = ctx.runtime.objects.upload.forName(
                marketplacePackageUploadName({
                  marketplace: { kind: "system" },
                  listingId: LISTING_ID,
                }),
              );
              const upload = ctx.runtime.objects.upload.for(TARGET_SCOPE);
              const installed = {
                [WORKFLOW_FILE]: publishedWorkflowSource("1.0.0"),
                "notes/unchanged.md": "shipped unchanged note",
                "notes/edited.md": "my own notes",
              };
              for (const note of ["unchanged", "edited"]) {
                await writeUploadFile({
                  fileKey: `1.0.0/notes/${note}.md`,
                  content: `shipped ${note} note`,
                  fetch: (request) => packageUpload.http.fetch(request),
                });
              }
              for (const [path, content] of Object.entries(installed)) {
                await writeUploadFile({
                  fileKey: `first/${path}`,
                  content,
                  fetch: (request) => upload.http.fetch(request),
                });
              }
              await writeUploadFile({
                fileKey: "marketplace-lock.json",
                content: JSON.stringify({
                  entries: [
                    {
                      marketplace: { kind: "system" },
                      listingId: LISTING_ID,
                      version: "1.0.0",
                      installationRoot,
                    },
                  ],
                }),
                fetch: (request) => upload.http.fetch(request),
              });
            },
          ),
          then.assert("importing the lock records version 1.0.0 and deletes it", async (ctx) => {
            await expect(
              ctx.runtime.objects.automations
                .for(TARGET_SCOPE)
                .commands.importLegacyPackageInstallations({}),
            ).resolves.toEqual({
              ok: true,
              result: {
                imported: [
                  {
                    marketplace: { kind: "system" },
                    listingId: LISTING_ID,
                    version: "1.0.0",
                    installationRoot,
                    permissions: [],
                    settings: {},
                  },
                ],
                alreadyInstalled: [],
                conflicts: [],
                lock: "deleted",
              },
            });
            assert((await readWorkspaceFile(ctx, MARKETPLACE_LOCK_PATH)).status === 410);
          }),
          then.assert(
            "installing 2.0.0 upgrades the imported installation in place",
            async (ctx) => {
              await expect(
                installMarketplacePackage(ctx, {
                  listingId: LISTING_ID,
                  version: "2.0.0",
                  installationRoot,
                }),
              ).resolves.toMatchObject({ workflowInstanceId: upgradeWorkflowId });
            },
          ),
          runner.drain(),
          then.assert("the upgraded install workflow receives its reply message", (ctx) =>
            submitTestCommandMessage(ctx, {
              installationRoot,
              version: "2.0.0",
              message: "Upgraded reply",
              eventId: "configure-upgrade",
            }),
          ),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
            instanceId: upgradeWorkflowId,
            status: "complete",
          }),
          then.assert(
            "the folder holds version 2.0.0, recorded as an installation",
            async (ctx) => {
              await expect(readInstallation(ctx, LISTING_ID)).resolves.toMatchObject({
                version: "2.0.0",
                installationRoot,
              });
              const file = await readWorkspaceFile(ctx, `${installationRoot}/${WORKFLOW_FILE}`);
              assert(file.ok);
              await expect(file.text()).resolves.toBe(publishedWorkflowSource("2.0.0"));
              assert(
                (await readWorkspaceFile(ctx, `${installationRoot}/notes/unchanged.md`)).status ===
                  410,
              );
              const edited = await readWorkspaceFile(ctx, `${installationRoot}/notes/edited.md`);
              assert(edited.ok);
              await expect(edited.text()).resolves.toBe("my own notes");
            },
          ),
        ],
      }),
    );
  });

  test("downgrading to a release without the route deletes it, and an edited file stops an upgrade", async () => {
    const installationRoot = "/workspace/first";
    const blockedUpgradeId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      targetScope: TARGET_SCOPE,
      installationRoot,
      listingId: LISTING_ID,
      version: "2.0.0",
    });
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "sync a package's routes across versions",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publish packages", publishMarketplacePackages),
          runner.drain(),
          then.assert("install version 2.0.0", async (ctx) => {
            await installMarketplacePackage(ctx, {
              listingId: LISTING_ID,
              version: "2.0.0",
              installationRoot,
            });
          }),
          runner.drain(),
          then.assert("answer its install workflow", (ctx) =>
            submitTestCommandMessage(ctx, {
              installationRoot,
              version: "2.0.0",
              message: "Reply",
              eventId: "configure",
            }),
          ),
          runner.drain(),
          then.router.route({ orgId: "org-1", id: ROUTE_ID }),
          then.assert("installing in another folder is refused", async (ctx) => {
            await expect(
              installMarketplacePackage(ctx, {
                listingId: LISTING_ID,
                version: "2.0.0",
                installationRoot: "/workspace/second",
              }),
            ).rejects.toThrow(
              `Package '${LISTING_ID}' is already installed at '${installationRoot}'. Install it there, or uninstall it first.`,
            );
          }),
          then.assert("install version 1.0.0, which declares no routes", async (ctx) => {
            await installMarketplacePackage(ctx, {
              listingId: LISTING_ID,
              version: "1.0.0",
              installationRoot,
            });
          }),
          runner.drain(),
          then.router.missing({ orgId: "org-1", id: ROUTE_ID }),
          then.assert(
            "edit the installed workflow, then request version 2.0.0 again",
            async (ctx) => {
              await expect(readInstallation(ctx, LISTING_ID)).resolves.toMatchObject({
                version: "1.0.0",
                permissions: [],
                settings: {},
              });
              const upload = ctx.runtime.objects.upload.for(TARGET_SCOPE);
              await writeUploadFile({
                fileKey: `first/${WORKFLOW_FILE}`,
                content: "// edited in the workspace",
                fetch: (request) => upload.http.fetch(request),
              });
              await installMarketplacePackage(ctx, {
                listingId: LISTING_ID,
                version: "2.0.0",
                installationRoot,
              });
            },
          ),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
            instanceId: blockedUpgradeId,
            status: "errored",
          }),
          then.assert("the edited installation is untouched", async (ctx) => {
            await expect(readInstallation(ctx, LISTING_ID)).resolves.toMatchObject({
              version: "1.0.0",
            });
            const file = await readWorkspaceFile(ctx, `${installationRoot}/${WORKFLOW_FILE}`);
            assert(file.ok);
            await expect(file.text()).resolves.toBe("// edited in the workspace");
          }),
          then.router.missing({ orgId: "org-1", id: ROUTE_ID }),
        ],
        options: { allowErroredWorkflows: true },
      }),
    );
  });

  test("installs several packages into one folder, each managing its own routes", async () => {
    const installationRoot = "/workspace/channels";
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "install several packages into one folder",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publish packages", publishMarketplacePackages),
          runner.drain(),
          then.assert("install the GitHub channel and the Telegram test command", async (ctx) => {
            await installMarketplacePackage(ctx, {
              listingId: GITHUB_CHANNEL_ID,
              version: "1.2.0",
              installationRoot,
            });
            await installMarketplacePackage(ctx, {
              listingId: LISTING_ID,
              version: "2.0.0",
              installationRoot,
            });
          }),
          runner.drain(),
          then.assert("answer the test command's install workflow", (ctx) =>
            submitTestCommandMessage(ctx, {
              installationRoot,
              version: "2.0.0",
              message: "Reply",
              eventId: "configure",
            }),
          ),
          runner.drain(),
          then.assert("each installation is recorded once", async (ctx) => {
            const installations = await ctx.runtime.objects.automations
              .for(TARGET_SCOPE)
              .commands.listPackageInstallations();
            expect(
              installations
                .map(({ listingId, version }) => ({ listingId, version }))
                .sort((left, right) => left.listingId.localeCompare(right.listingId)),
            ).toEqual([
              { listingId: GITHUB_CHANNEL_ID, version: "1.2.0" },
              { listingId: LISTING_ID, version: "2.0.0" },
            ]);
          }),
          then.router.route({
            orgId: "org-1",
            id: "github-pull-request-opened-reclassify",
            steward: { kind: "package", listingId: GITHUB_CHANNEL_ID },
          }),
          then.router.route({
            orgId: "org-1",
            id: ROUTE_ID,
            steward: { kind: "package", listingId: LISTING_ID },
          }),
        ],
      }),
    );
  });

  test("upgrading GitHub Channel to 1.2.0 takes over the event definitions 1.1.0 created", async () => {
    const installationRoot = "/workspace/github";
    const eventTypes = [
      "issues.opened",
      "issue_comment.created",
      "pull_request.opened",
      "pull_request.synchronize",
      "push",
    ];
    const install = async (ctx: BackofficeScenarioContext, version: string) => {
      await installMarketplacePackage(ctx, {
        listingId: GITHUB_CHANNEL_ID,
        version,
        installationRoot,
      });
    };
    const definition = (ctx: BackofficeScenarioContext, eventType: string) =>
      ctx.runtime.objects.automations
        .for(TARGET_SCOPE)
        .commands.getEventDefinition({ source: "github", eventType });
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "upgrade GitHub Channel to declared event definitions",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publish packages", publishMarketplacePackages),
          runner.drain(),
          then.assert("install 1.1.0, whose install workflow defines the events", (ctx) =>
            install(ctx, "1.1.0"),
          ),
          runner.drain(),
          then.assert("1.1.0's definitions belong to members", async (ctx) => {
            for (const eventType of eventTypes) {
              await expect(definition(ctx, eventType)).resolves.toMatchObject({
                steward: { kind: "members" },
              });
            }
          }),
          then.assert("upgrade to 1.2.0", (ctx) => install(ctx, "1.2.0")),
          runner.drain(),
          then.assert(
            "1.2.0 manages the definitions, which members may only toggle",
            async (ctx) => {
              for (const eventType of eventTypes) {
                await expect(definition(ctx, eventType)).resolves.toMatchObject({
                  steward: { kind: "package", listingId: GITHUB_CHANNEL_ID },
                });
              }
              const patch = (body: Record<string, unknown>) =>
                routes(ctx)("PATCH", "/event-definitions/:source/:eventType", {
                  pathParams: { source: "github", eventType: "push" },
                  body,
                });
              await expect(patch({ label: "Pushed" })).resolves.toMatchObject({
                type: "error",
                status: 409,
                error: { code: "EVENT_DEFINITION_STEWARDED" },
              });
              await expect(patch({ enabled: false })).resolves.toMatchObject({
                type: "json",
                data: {
                  enabled: false,
                  steward: { kind: "package", listingId: GITHUB_CHANNEL_ID },
                },
              });
            },
          ),
          then.assert("uninstalling removes the definitions with the routes", async (ctx) => {
            await expect(
              ctx.runtime.objects.automations
                .for(TARGET_SCOPE)
                .commands.uninstallPackage({ listingId: GITHUB_CHANNEL_ID }),
            ).resolves.toMatchObject({
              removedRouteIds: expect.arrayContaining(["github-push-reclassify"]),
              removedEventDefinitions: expect.arrayContaining(
                eventTypes.map((eventType) => ({ source: "github", eventType })),
              ),
            });
            for (const eventType of eventTypes) {
              await expect(definition(ctx, eventType)).resolves.toBeNull();
            }
          }),
        ],
      }),
    );
  });

  test("refuses to install into a workspace that still has a legacy lock, before writing files", async () => {
    const installationRoot = "/workspace/locked";
    const lock = JSON.stringify({
      entries: [
        {
          marketplace: { kind: "system" },
          listingId: GITHUB_CHANNEL_ID,
          version: "1.0.0",
          installationRoot: "/workspace/github",
        },
      ],
    });
    const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      targetScope: TARGET_SCOPE,
      installationRoot,
      listingId: LISTING_ID,
      version: "1.0.0",
    });
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "refuse installing next to a legacy Marketplace lock",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publish packages", publishMarketplacePackages),
          runner.drain(),
          then.assert("write a lock and request installation", async (ctx) => {
            const upload = ctx.runtime.objects.upload.for(TARGET_SCOPE);
            await writeUploadFile({
              fileKey: "marketplace-lock.json",
              content: lock,
              fetch: (request) => upload.http.fetch(request),
            });
            await installMarketplacePackage(ctx, {
              listingId: LISTING_ID,
              version: "1.0.0",
              installationRoot,
            });
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "errored",
          }),
          then.assert("no files were installed and the lock is preserved", async (ctx) => {
            await expect(
              (await readWorkspaceFile(ctx, MARKETPLACE_LOCK_PATH)).text(),
            ).resolves.toBe(lock);
            assert(
              (await readWorkspaceFile(ctx, `${installationRoot}/${WORKFLOW_FILE}`)).status === 404,
            );
            await expect(readInstallation(ctx, LISTING_ID)).resolves.toBeNull();
          }),
        ],
        options: { allowErroredWorkflows: true },
      }),
    );
  });

  test.each([
    "not JSON",
    JSON.stringify({ entries: [{ listingId: LISTING_ID }] }),
    JSON.stringify({ entries: [{ listingId: LISTING_ID, version: "1.0.0" }] }),
    JSON.stringify({
      entries: [{ listingId: LISTING_ID, version: "1.0.0", installationRoot: "/tmp/outside" }],
    }),
    JSON.stringify({
      entries: [
        { listingId: LISTING_ID, version: "1.0.0", installationRoot: "/workspace/locked" },
        { listingId: LISTING_ID, version: "1.0.0", installationRoot: " /workspace/locked/ " },
      ],
    }),
  ])("refuses to import an invalid legacy lock, leaving it: %s", async (content) => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "preserve an invalid legacy Marketplace lock",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert("importing the invalid lock is refused", async (ctx) => {
            const upload = ctx.runtime.objects.upload.for(TARGET_SCOPE);
            await writeUploadFile({
              fileKey: "marketplace-lock.json",
              content,
              fetch: (request) => upload.http.fetch(request),
            });
            const outcome = await ctx.runtime.objects.automations
              .for(TARGET_SCOPE)
              .commands.importLegacyPackageInstallations({});
            assert(!outcome.ok);
            expect(outcome.message).toContain(`${MARKETPLACE_LOCK_PATH} is invalid`);
            await expect(
              (await readWorkspaceFile(ctx, MARKETPLACE_LOCK_PATH)).text(),
            ).resolves.toBe(content);
            await expect(
              ctx.runtime.objects.automations.for(TARGET_SCOPE).commands.listPackageInstallations(),
            ).resolves.toEqual([]);
          }),
        ],
      }),
    );
  });

  test("imports a listing the legacy lock records in two folders only once one is chosen", async () => {
    const entry = (listingId: string, installationRoot: string) => ({
      marketplace: { kind: "system" },
      listingId,
      version: "1.0.0",
      installationRoot,
    });
    const importLegacy = (
      ctx: BackofficeScenarioContext,
      keep: { listingId: string; installationRoot: string }[],
    ) =>
      ctx.runtime.objects.automations
        .for(TARGET_SCOPE)
        .commands.importLegacyPackageInstallations({ keep });
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "import a legacy Marketplace lock with a duplicate listing",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert(
            "the duplicate is a conflict; the rest is imported and the lock kept",
            async (ctx) => {
              const upload = ctx.runtime.objects.upload.for(TARGET_SCOPE);
              await writeUploadFile({
                fileKey: "marketplace-lock.json",
                content: JSON.stringify({
                  entries: [
                    entry(LISTING_ID, "/workspace/first"),
                    entry(LISTING_ID, "/workspace/second"),
                    entry(GITHUB_CHANNEL_ID, "/workspace/github"),
                  ],
                }),
                fetch: (request) => upload.http.fetch(request),
              });
              await expect(importLegacy(ctx, [])).resolves.toEqual({
                ok: true,
                result: {
                  imported: [
                    {
                      ...entry(GITHUB_CHANNEL_ID, "/workspace/github"),
                      permissions: [],
                      settings: {},
                    },
                  ],
                  alreadyInstalled: [],
                  conflicts: [
                    {
                      listingId: LISTING_ID,
                      installationRoots: ["/workspace/first", "/workspace/second"],
                    },
                  ],
                  lock: "kept",
                },
              });
              assert((await readWorkspaceFile(ctx, MARKETPLACE_LOCK_PATH)).ok);
            },
          ),
          then.assert("keeping a folder the lock does not record is refused", async (ctx) => {
            await expect(
              importLegacy(ctx, [{ listingId: LISTING_ID, installationRoot: "/workspace/third" }]),
            ).resolves.toEqual({
              ok: false,
              message: `${MARKETPLACE_LOCK_PATH} has no installation of '${LISTING_ID}' at '/workspace/third' to keep.`,
            });
          }),
          then.assert("choosing the folder imports it and deletes the lock", async (ctx) => {
            await expect(
              importLegacy(ctx, [{ listingId: LISTING_ID, installationRoot: "/workspace/second" }]),
            ).resolves.toEqual({
              ok: true,
              result: {
                imported: [
                  { ...entry(LISTING_ID, "/workspace/second"), permissions: [], settings: {} },
                ],
                alreadyInstalled: [
                  { listingId: GITHUB_CHANNEL_ID, installationRoot: "/workspace/github" },
                ],
                conflicts: [],
                lock: "deleted",
              },
            });
            assert((await readWorkspaceFile(ctx, MARKETPLACE_LOCK_PATH)).status === 410);
            await expect(importLegacy(ctx, [])).resolves.toEqual({
              ok: true,
              result: { imported: [], alreadyInstalled: [], conflicts: [], lock: "absent" },
            });
          }),
        ],
      }),
    );
  });

  test("rejects an installation atomically if a matching existing file changes after planning", async () => {
    const installationRoot = "/workspace/atomic";
    const matchingFile = "automations/telegram-user-linking.workflow.js";
    const missingFile = "automations/telegram-user-pi-linking.workflow.js";
    const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      targetScope: TARGET_SCOPE,
      installationRoot,
      listingId: TELEGRAM_CHANNEL_ID,
      version: "1.0.1",
    });
    let changeMatchingFile = true;
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "preserve concurrently changed files during a Marketplace install",
        objects: {
          ...scenarioObjects,
          UPLOAD: ({ name, state, env, implementation }) =>
            new (class extends UploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  name.endsWith("v1:org:org-1") &&
                  changeMatchingFile &&
                  request.method === "POST" &&
                  url.pathname.endsWith("/uploads")
                ) {
                  const payload = (await request.clone().json()) as { fileKey: string };
                  if (payload.fileKey === `atomic/${missingFile}`) {
                    changeMatchingFile = false;
                    await writeUploadFile({
                      fileKey: `atomic/${matchingFile}`,
                      content: "changed after installation planning",
                      fetch: (nextRequest) => super.fetch(nextRequest),
                    });
                  }
                }
                return await super.fetch(request);
              }
            })({ state, env: env as never, implementation }),
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publish packages", publishMarketplacePackages),
          runner.drain(),
          then.assert("seed a matching file and request installation", async (ctx) => {
            const entry = getStaticMarketplaceEntry({ slug: "telegram-channel", version: "1.0.1" });
            assert(entry);
            const upload = ctx.runtime.objects.upload.for(TARGET_SCOPE);
            await writeUploadFile({
              fileKey: `atomic/${matchingFile}`,
              content: entry.files[matchingFile],
              fetch: (request) => upload.http.fetch(request),
            });
            await installMarketplacePackage(ctx, {
              listingId: TELEGRAM_CHANNEL_ID,
              version: "1.0.1",
              installationRoot,
            });
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "errored",
          }),
          then.assert(
            "the rejected batch preserves local changes and records no installation",
            async (ctx) => {
              const existing = await readWorkspaceFile(ctx, `${installationRoot}/${matchingFile}`);
              assert(existing.ok);
              await expect(existing.text()).resolves.toBe("changed after installation planning");
              assert(
                (await readWorkspaceFile(ctx, `${installationRoot}/${missingFile}`)).status === 404,
              );
              await expect(readInstallation(ctx, TELEGRAM_CHANNEL_ID)).resolves.toBeNull();
            },
          ),
        ],
        options: { allowErroredWorkflows: true },
      }),
    );
  });

  test.each(["marketplace-lock.json", "marketplace-lock.json/nested.json"])(
    "refuses a package that would overwrite or use the root lock as a directory: %s",
    async (relativePath) => {
      const installationRoot = "/workspace";
      const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
        marketplace: { kind: "system" },
        targetScope: TARGET_SCOPE,
        installationRoot,
        listingId: LISTING_ID,
        version: "1.0.0",
      });
      await runBackofficeScenario(
        defineBackofficeScenario({
          objects: scenarioObjects,
          name: "reserve marketplace-lock.json for installation bookkeeping",
          setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
          steps: ({ then, runner }) => [
            then.assert("publish packages", publishMarketplacePackages),
            runner.drain(),
            then.assert("add a reserved package file and request installation", async (ctx) => {
              const upload = ctx.runtime.objects.upload.forName(
                marketplacePackageUploadName({
                  marketplace: { kind: "system" },
                  listingId: LISTING_ID,
                }),
              );
              await writeUploadFile({
                fileKey: `1.0.0/${relativePath}`,
                content: "cannot overwrite installation bookkeeping",
                fetch: (request) => upload.http.fetch(request),
              });
              await installMarketplacePackage(ctx, {
                listingId: LISTING_ID,
                version: "1.0.0",
                installationRoot,
              });
            }),
            runner.drain(),
            then.workflow.instance({
              workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
              instanceId: workflowInstanceId,
              status: "errored",
            }),
            then.assert("no package files or installation were recorded", async (ctx) => {
              assert(
                (await readWorkspaceFile(ctx, `${installationRoot}/${WORKFLOW_FILE}`)).status ===
                  404,
              );
              assert(
                (await readWorkspaceFile(ctx, `${installationRoot}/marketplace-lock.json`))
                  .status === 404,
              );
              await expect(readInstallation(ctx, LISTING_ID)).resolves.toBeNull();
            }),
          ],
          options: { allowErroredWorkflows: true },
        }),
      );
    },
  );
});
