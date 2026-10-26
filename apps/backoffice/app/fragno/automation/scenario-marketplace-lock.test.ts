import { assert, describe, expect, test, vi } from "vitest";

import {
  MARKETPLACE_LOCK_PATH,
  marketplaceLockSchema,
} from "@fragno-dev/backoffice-api/v0/marketplace";

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
import { BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY } from "@/fragno/automation/actors";
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
import { createWorkflowsRouteCaller } from "./route-callers";
import {
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
const WORKFLOW_FILE = "automations/telegram-test-command.workflow.js";
const TARGET_SCOPE = { kind: "org", orgId: "org-1" } as const;

async function publishMarketplacePackages(ctx: BackofficeScenarioContext) {
  await ctx.runtime.objects.automations.singleton().commands.requestStaticMarketplacePublications();
}

async function installMarketplacePackage(
  ctx: BackofficeScenarioContext,
  input: {
    listingId: string;
    version: string;
    installationRoot: string;
  },
) {
  return await ctx.runtime.objects.automations
    .forOrg("org-1")
    .commands.restartMarketplaceIngestion(
      { marketplace: { kind: "system" }, ...input, targetScope: TARGET_SCOPE },
      { execution: createBackofficeSystemExecution(TARGET_SCOPE), propagationContext: null },
    );
}

/** From 1.3.0, the test command's installer waits for its reply message before creating its route. */
async function submitTestCommandInstaller(
  ctx: BackofficeScenarioContext,
  installationRoot: string,
) {
  const ingestionInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
    marketplace: { kind: "system" },
    targetScope: TARGET_SCOPE,
    installationRoot,
    listingId: LISTING_ID,
    version: "1.4.0",
  });
  const workflows = createWorkflowsRouteCaller({
    object: ctx.runtime.objects.automations.for(TARGET_SCOPE),
    context: { execution: createBackofficeSystemExecution(TARGET_SCOPE), propagationContext: null },
  });
  const submitted = await workflows("POST", "/:workflowName/instances/:instanceId/events", {
    pathParams: {
      workflowName: CODEMODE_WORKFLOW,
      instanceId: `${ingestionInstanceId}:installation`,
    },
    body: {
      id: `configure:${ingestionInstanceId}`,
      type: "telegram-test-command.message-configured",
      payload: { message: "Telegram integration verified after a 3 second delay." },
    },
  });
  assert(submitted.type === "json");
}

async function readWorkspaceFile(ctx: BackofficeScenarioContext, path: string) {
  const url = new URL("https://upload.test/api/upload/files/by-key/content");
  url.searchParams.set("provider", "database");
  url.searchParams.set("key", path.slice("/workspace/".length));
  return await ctx.runtime.objects.upload.for(TARGET_SCOPE).http.fetch(new Request(url));
}

async function readMarketplaceLock(ctx: BackofficeScenarioContext) {
  const response = await readWorkspaceFile(ctx, MARKETPLACE_LOCK_PATH);
  assert(response.ok);
  return marketplaceLockSchema.parse(await response.json());
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

describe("marketplace lock scenarios", () => {
  test("installs files and the installer into the requested nested directory", async () => {
    const installationRoot = "/workspace/packages/telegram";
    const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      targetScope: TARGET_SCOPE,
      installationRoot,
      listingId: LISTING_ID,
      version: "1.4.0",
    });
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "install Marketplace into a nested directory",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publish packages", publishMarketplacePackages),
          runner.drain(),
          then.assert("start the installation at the chosen path", async (ctx) => {
            await expect(
              installMarketplacePackage(ctx, {
                listingId: LISTING_ID,
                version: "1.4.0",
                installationRoot: `${installationRoot}/`,
              }),
            ).resolves.toMatchObject({ action: "created", workflowInstanceId });
          }),
          runner.drain(),
          then.assert("the installer receives its reply message", (ctx) =>
            submitTestCommandInstaller(ctx, installationRoot),
          ),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "complete",
          }),
          then.assert(
            "files and route use the chosen folder, recorded in the workspace lock",
            async (ctx) => {
              const file = await readWorkspaceFile(ctx, `${installationRoot}/${WORKFLOW_FILE}`);
              assert(file.ok);
              await expect(file.text()).resolves.toBe(publishedWorkflowSource("1.4.0"));
              expect(await readMarketplaceLock(ctx)).toEqual({
                entries: [
                  {
                    marketplace: { kind: "system" },
                    listingId: LISTING_ID,
                    version: "1.4.0",
                    installationRoot,
                  },
                ],
              });
              assert((await readWorkspaceFile(ctx, `/workspace/${WORKFLOW_FILE}`)).status === 404);
              assert(
                (await readWorkspaceFile(ctx, `${installationRoot}/marketplace-lock.json`))
                  .status === 404,
              );
              const route = await ctx.runtime.objects.automations
                .for(TARGET_SCOPE)
                .http.fetch(
                  new Request(
                    "https://automations.test/api/automations/routes/telegram-test-command",
                  ),
                );
              assert(route.ok);
              await expect(route.json()).resolves.toMatchObject({
                action: { workflowScriptPath: `${installationRoot}/${WORKFLOW_FILE}` },
              });
            },
          ),
        ],
      }),
    );
  });

  test("records multiple Marketplace items in one root without duplicating reinstalled entries", async () => {
    const installationRoot = "/workspace/channels";
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "install multiple Marketplace items into one root",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publish packages", publishMarketplacePackages),
          runner.drain(),
          then.assert("install the Telegram channel", async (ctx) => {
            await installMarketplacePackage(ctx, {
              listingId: TELEGRAM_CHANNEL_ID,
              version: "1.1.0",
              installationRoot,
            });
          }),
          runner.drain(),
          then.assert("install the GitHub channel", async (ctx) => {
            await installMarketplacePackage(ctx, {
              listingId: GITHUB_CHANNEL_ID,
              version: "1.0.0",
              installationRoot,
            });
          }),
          runner.drain(),
          then.assert("reinstall the Telegram channel", async (ctx) => {
            await expect(
              installMarketplacePackage(ctx, {
                listingId: TELEGRAM_CHANNEL_ID,
                version: "1.1.0",
                installationRoot,
              }),
            ).resolves.toMatchObject({ action: "restarted" });
          }),
          runner.drain(),
          then.assert("the root records both successful items exactly once", async (ctx) => {
            expect(await readMarketplaceLock(ctx)).toEqual({
              entries: [
                {
                  marketplace: { kind: "system" },
                  listingId: TELEGRAM_CHANNEL_ID,
                  version: "1.1.0",
                  installationRoot,
                },
                {
                  marketplace: { kind: "system" },
                  listingId: GITHUB_CHANNEL_ID,
                  version: "1.0.0",
                  installationRoot,
                },
              ],
            });
            for (const routeId of [
              "telegram-start-linking",
              "github-pull-request-opened-reclassify",
            ]) {
              const response = await ctx.runtime.objects.automations
                .for(TARGET_SCOPE)
                .http.fetch(
                  new Request(`https://automations.test/api/automations/routes/${routeId}`),
                );
              assert(response.ok);
            }
          }),
        ],
      }),
    );
  });

  test("upgrades an installation in place, keeping edits to files the new version dropped", async () => {
    const installationRoot = "/workspace/first";
    const upgradeWorkflowId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      targetScope: TARGET_SCOPE,
      installationRoot,
      listingId: LISTING_ID,
      version: "1.4.0",
    });
    await runBackofficeScenario(
      defineBackofficeScenario({
        // Writing to the system-scope package upload runs system automations, which load more objects.
        objects: allLocalObjects,
        name: "upgrade a Marketplace installation in place",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publish packages", publishMarketplacePackages),
          runner.drain(),
          then.assert("version 1.0.0 also ships two notes that 1.4.0 drops", async (ctx) => {
            const packageUpload = ctx.runtime.objects.upload.forName(
              marketplacePackageUploadName({
                marketplace: { kind: "system" },
                listingId: LISTING_ID,
              }),
            );
            for (const note of ["unchanged", "edited"]) {
              await writeUploadFile({
                fileKey: `1.0.0/notes/${note}.md`,
                content: `shipped ${note} note`,
                fetch: (request) => packageUpload.http.fetch(request),
              });
            }
            await installMarketplacePackage(ctx, {
              listingId: LISTING_ID,
              version: "1.0.0",
              installationRoot,
            });
          }),
          runner.drain(),
          then.assert("edit a note, then install version 1.4.0 at the same root", async (ctx) => {
            const upload = ctx.runtime.objects.upload.for(TARGET_SCOPE);
            await writeUploadFile({
              fileKey: "first/notes/edited.md",
              content: "my own notes",
              fetch: (request) => upload.http.fetch(request),
            });
            await expect(
              installMarketplacePackage(ctx, {
                listingId: LISTING_ID,
                version: "1.4.0",
                installationRoot,
              }),
            ).resolves.toMatchObject({ workflowInstanceId: upgradeWorkflowId });
          }),
          runner.drain(),
          then.assert("the upgraded installer receives its reply message", (ctx) =>
            submitTestCommandInstaller(ctx, installationRoot),
          ),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
            instanceId: upgradeWorkflowId,
            status: "complete",
          }),
          then.assert("the root holds version 1.4.0 and one lock entry", async (ctx) => {
            expect(await readMarketplaceLock(ctx)).toEqual({
              entries: [
                {
                  marketplace: { kind: "system" },
                  listingId: LISTING_ID,
                  version: "1.4.0",
                  installationRoot,
                },
              ],
            });
            const file = await readWorkspaceFile(ctx, `${installationRoot}/${WORKFLOW_FILE}`);
            assert(file.ok);
            await expect(file.text()).resolves.toBe(publishedWorkflowSource("1.4.0"));
            assert(
              (await readWorkspaceFile(ctx, `${installationRoot}/notes/unchanged.md`)).status ===
                410,
            );
            const edited = await readWorkspaceFile(ctx, `${installationRoot}/notes/edited.md`);
            assert(edited.ok);
            await expect(edited.text()).resolves.toBe("my own notes");
          }),
        ],
      }),
    );
  });

  test("refuses to upgrade over an edited file, but allows another version at a different root", async () => {
    const installationRoot = "/workspace/first";
    const upgradeWorkflowId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      targetScope: TARGET_SCOPE,
      installationRoot,
      listingId: LISTING_ID,
      version: "1.4.0",
    });
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "preserve edited files when upgrading a Marketplace installation",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publish packages", publishMarketplacePackages),
          runner.drain(),
          then.assert("install version 1.0.0", async (ctx) => {
            await installMarketplacePackage(ctx, {
              listingId: LISTING_ID,
              version: "1.0.0",
              installationRoot,
            });
          }),
          runner.drain(),
          then.assert("edit the workflow, then request version 1.4.0 at its root", async (ctx) => {
            const upload = ctx.runtime.objects.upload.for(TARGET_SCOPE);
            await writeUploadFile({
              fileKey: `first/${WORKFLOW_FILE}`,
              content: "// edited in the workspace",
              fetch: (request) => upload.http.fetch(request),
            });
            await installMarketplacePackage(ctx, {
              listingId: LISTING_ID,
              version: "1.4.0",
              installationRoot,
            });
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
            instanceId: upgradeWorkflowId,
            status: "errored",
          }),
          then.assert("the edited installation is untouched", async (ctx) => {
            expect(await readMarketplaceLock(ctx)).toEqual({
              entries: [
                {
                  marketplace: { kind: "system" },
                  listingId: LISTING_ID,
                  version: "1.0.0",
                  installationRoot,
                },
              ],
            });
            const file = await readWorkspaceFile(ctx, `${installationRoot}/${WORKFLOW_FILE}`);
            assert(file.ok);
            await expect(file.text()).resolves.toBe("// edited in the workspace");
            await installMarketplacePackage(ctx, {
              listingId: LISTING_ID,
              version: "1.4.0",
              installationRoot: "/workspace/second",
            });
          }),
          runner.drain(),
          then.assert("the second installer receives its reply message", (ctx) =>
            submitTestCommandInstaller(ctx, "/workspace/second"),
          ),
          runner.drain(),
          then.assert("both versions have separate entries in the workspace lock", async (ctx) => {
            expect(await readMarketplaceLock(ctx)).toEqual({
              entries: [
                {
                  marketplace: { kind: "system" },
                  listingId: LISTING_ID,
                  version: "1.0.0",
                  installationRoot,
                },
                {
                  marketplace: { kind: "system" },
                  listingId: LISTING_ID,
                  version: "1.4.0",
                  installationRoot: "/workspace/second",
                },
              ],
            });
            const file = await readWorkspaceFile(ctx, `/workspace/second/${WORKFLOW_FILE}`);
            assert(file.ok);
            await expect(file.text()).resolves.toBe(publishedWorkflowSource("1.4.0"));
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
  ])(
    "preserves invalid lock content and rejects installation before writing files: %s",
    async (content) => {
      const installationRoot = "/workspace/locked";
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
          name: "preserve an invalid Marketplace lock",
          setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
          steps: ({ then, runner }) => [
            then.assert("publish packages", publishMarketplacePackages),
            runner.drain(),
            then.assert("write an invalid lock and request installation", async (ctx) => {
              const upload = ctx.runtime.objects.upload.for(TARGET_SCOPE);
              await writeUploadFile({
                fileKey: "marketplace-lock.json",
                content,
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
            then.assert(
              "no files were installed and the invalid lock is preserved",
              async (ctx) => {
                const lock = await readWorkspaceFile(ctx, MARKETPLACE_LOCK_PATH);
                await expect(lock.text()).resolves.toBe(content);
                assert(
                  (await readWorkspaceFile(ctx, `${installationRoot}/${WORKFLOW_FILE}`)).status ===
                    404,
                );
              },
            ),
          ],
          options: { allowErroredWorkflows: true },
        }),
      );
    },
  );

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
            "the rejected batch preserves local changes and publishes no new files or lock",
            async (ctx) => {
              const existing = await readWorkspaceFile(ctx, `${installationRoot}/${matchingFile}`);
              assert(existing.ok);
              await expect(existing.text()).resolves.toBe("changed after installation planning");
              assert(
                (await readWorkspaceFile(ctx, `${installationRoot}/${missingFile}`)).status === 404,
              );
              assert((await readWorkspaceFile(ctx, MARKETPLACE_LOCK_PATH)).status === 404);
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
            then.assert("no package files or lock were installed", async (ctx) => {
              assert(
                (await readWorkspaceFile(ctx, `${installationRoot}/${WORKFLOW_FILE}`)).status ===
                  404,
              );
              assert(
                (await readWorkspaceFile(ctx, `${installationRoot}/marketplace-lock.json`))
                  .status === 404,
              );
            }),
          ],
          options: { allowErroredWorkflows: true },
        }),
      );
    },
  );

  test("replays a successful lock write after losing its commit response", async () => {
    const installationRoot = "/workspace/replay";
    const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      targetScope: TARGET_SCOPE,
      installationRoot,
      listingId: LISTING_ID,
      version: "1.0.0",
    });
    let lockWriteAttempts = 0;
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "replay a committed Marketplace lock write",
        objects: {
          ...scenarioObjects,
          UPLOAD: ({ name, state, env, implementation }) =>
            new (class extends UploadObject {
              async fetch(request: Request): Promise<Response> {
                const destination = name.endsWith("v1:org:org-1");
                const url = new URL(request.url);
                if (destination && request.method === "POST" && url.pathname.endsWith("/files")) {
                  const form = await request.clone().formData();
                  const response = await super.fetch(request);
                  if (response.ok && form.get("fileKey") === "marketplace-lock.json") {
                    lockWriteAttempts += 1;
                    if (lockWriteAttempts === 1) {
                      throw new Error("Marketplace lock write response was lost.");
                    }
                  }
                  return response;
                }
                return await super.fetch(request);
              }
            })({ state, env: env as never, implementation }),
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner, when }) => [
          then.assert("publish packages", publishMarketplacePackages),
          runner.drain(),
          then.assert("request installation", async (ctx) => {
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
            status: "waiting",
          }),
          then.assert("the committed lock is already visible", async (ctx) => {
            expect(await readMarketplaceLock(ctx)).toEqual({
              entries: [
                {
                  marketplace: { kind: "system" },
                  listingId: LISTING_ID,
                  version: "1.0.0",
                  installationRoot,
                },
              ],
            });
          }),
          runner.restartObject({ binding: "AUTOMATIONS", scope: TARGET_SCOPE }),
          when.time.advance("1 s"),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "complete",
          }),
          then.assert("replay neither rewrites the lock nor duplicates the entry", async (ctx) => {
            expect(lockWriteAttempts).toBe(1);
            expect(await readMarketplaceLock(ctx)).toEqual({
              entries: [
                {
                  marketplace: { kind: "system" },
                  listingId: LISTING_ID,
                  version: "1.0.0",
                  installationRoot,
                },
              ],
            });
          }),
        ],
      }),
    );
  });

  test("merges a concurrently written lock entry after a revision conflict", async () => {
    const installationRoot = "/workspace/concurrent";
    const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
      marketplace: { kind: "system" },
      targetScope: TARGET_SCOPE,
      installationRoot,
      listingId: LISTING_ID,
      version: "1.0.0",
    });
    let writeConcurrentEntry = true;
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "preserve a concurrent Marketplace lock writer",
        objects: {
          ...scenarioObjects,
          UPLOAD: ({ name, state, env, implementation }) =>
            new (class extends UploadObject {
              async fetch(request: Request): Promise<Response> {
                const url = new URL(request.url);
                if (
                  name.endsWith("v1:org:org-1") &&
                  writeConcurrentEntry &&
                  request.method === "POST" &&
                  url.pathname.endsWith("/files")
                ) {
                  const form = await request.clone().formData();
                  if (form.get("fileKey") === "marketplace-lock.json") {
                    writeConcurrentEntry = false;
                    await writeUploadFile({
                      fileKey: "marketplace-lock.json",
                      content: JSON.stringify({
                        entries: [
                          {
                            listingId: LISTING_ID,
                            version: "1.0.0",
                            installationRoot: "/workspace/other",
                          },
                        ],
                      }),
                      fetch: (nextRequest) => super.fetch(nextRequest),
                    });
                  }
                }
                return await super.fetch(request);
              }
            })({ state, env: env as never, implementation }),
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner, when }) => [
          then.assert("publish packages", publishMarketplacePackages),
          runner.drain(),
          then.assert("request installation", async (ctx) => {
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
            status: "waiting",
          }),
          runner.restartObject({ binding: "AUTOMATIONS", scope: TARGET_SCOPE }),
          when.time.advance("1 s"),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
            instanceId: workflowInstanceId,
            status: "complete",
          }),
          then.assert("the retried write preserves both entries", async (ctx) => {
            expect(await readMarketplaceLock(ctx)).toEqual({
              entries: [
                {
                  marketplace: { kind: "system" },
                  listingId: LISTING_ID,
                  version: "1.0.0",
                  installationRoot: "/workspace/other",
                },
                {
                  marketplace: { kind: "system" },
                  listingId: LISTING_ID,
                  version: "1.0.0",
                  installationRoot,
                },
              ],
            });
            const file = await readWorkspaceFile(ctx, `${installationRoot}/${WORKFLOW_FILE}`);
            assert(file.ok);
            await expect(file.text()).resolves.toBe(publishedWorkflowSource("1.0.0"));
          }),
        ],
      }),
    );
  });

  test.each([
    "",
    "/tmp/install",
    "/workspace/../outside",
    "/workspace/nested/./install",
    "/workspace/nested\\outside",
    "/workspace/nested\u0000outside",
    MARKETPLACE_LOCK_PATH,
    `${MARKETPLACE_LOCK_PATH}/nested`,
  ])(
    "rejects invalid installation paths before creating workflows: %s",
    async (installationRoot) => {
      await runBackofficeScenario(
        defineBackofficeScenario({
          objects: scenarioObjects,
          name: "validate Marketplace installation paths at the workflow boundary",
          setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
          steps: ({ then }) => [
            then.assert("invalid paths never create a workflow", async (ctx) => {
              const workflows = createWorkflowsRouteCaller({
                object: ctx.runtime.objects.automations.for(TARGET_SCOPE),
                context: {
                  execution: createBackofficeSystemExecution(TARGET_SCOPE),
                  propagationContext: null,
                },
              });
              const response = await workflows("POST", "/:workflowName/instances", {
                pathParams: { workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME },
                body: {
                  id: "invalid-install-path",
                  params: {
                    targetScope: TARGET_SCOPE,
                    installationRoot,
                    listingId: LISTING_ID,
                    version: "1.0.0",
                    metadata: {
                      [BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY]:
                        createBackofficeSystemExecution(TARGET_SCOPE).actors,
                    },
                  },
                },
              });
              assert(response.type === "error");
              assert(response.status === 400);
              assert(response.error.code === "WORKFLOW_PARAMS_INVALID");
              const instance = await workflows("GET", "/:workflowName/instances/:instanceId", {
                pathParams: {
                  workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
                  instanceId: "invalid-install-path",
                },
              });
              assert(instance.type === "error");
              assert(instance.status === 404);
            }),
          ],
        }),
      );
    },
  );
});
