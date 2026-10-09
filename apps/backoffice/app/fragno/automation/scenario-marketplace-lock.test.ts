import { assert, describe, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class DurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }
  class RpcTarget {}
  class WorkerEntrypoint {}
  return { DurableObject, RpcTarget, WorkerEntrypoint };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY } from "@/fragno/automation/actors";
import { marketplaceArtifactUploadName } from "@/fragno/marketplace/artifacts";
import {
  MARKETPLACE_LOCK_PATH,
  marketplaceLockSchema,
} from "@/fragno/marketplace/marketplace-lock";
import { marketplaceListingId } from "@/fragno/marketplace/owner";
import { getStaticMarketplaceEntry } from "@/fragno/marketplace/static-entries";
import { sha256Hex } from "@/lib/crypto";

import { InMemoryApiObject } from "../../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../workers/forms.do";
import { InMemoryMarketplaceObject } from "../../../workers/marketplace.do";
import { InMemoryMcpObject } from "../../../workers/mcp.do";
import { InMemoryTelegramObject } from "../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
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

async function publishMarketplaceArtifacts(ctx: BackofficeScenarioContext) {
  await ctx.runtime.objects.automations.singleton().commands.requestStaticMarketplacePublications();
}

async function installMarketplaceArtifact(
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
      { ...input, targetScope: TARGET_SCOPE },
      { execution: createBackofficeSystemExecution(TARGET_SCOPE), propagationContext: null },
    );
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
      targetScope: TARGET_SCOPE,
      installationRoot,
      listingId: LISTING_ID,
      version: "1.2.1",
    });
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "install Marketplace into a nested directory",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publish artifacts", publishMarketplaceArtifacts),
          runner.drain(),
          then.assert("start the installation at the chosen path", async (ctx) => {
            await expect(
              installMarketplaceArtifact(ctx, {
                listingId: LISTING_ID,
                version: "1.2.1",
                installationRoot: `${installationRoot}/`,
              }),
            ).resolves.toMatchObject({ action: "created", workflowInstanceId });
          }),
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
              await expect(file.text()).resolves.toBe(publishedWorkflowSource("1.2.1"));
              expect(await readMarketplaceLock(ctx)).toEqual({
                entries: [{ listingId: LISTING_ID, version: "1.2.1", installationRoot }],
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
          then.assert("publish artifacts", publishMarketplaceArtifacts),
          runner.drain(),
          then.assert("install the Telegram channel", async (ctx) => {
            await installMarketplaceArtifact(ctx, {
              listingId: TELEGRAM_CHANNEL_ID,
              version: "1.0.1",
              installationRoot,
            });
          }),
          runner.drain(),
          then.assert("install the GitHub channel", async (ctx) => {
            await installMarketplaceArtifact(ctx, {
              listingId: GITHUB_CHANNEL_ID,
              version: "1.0.0",
              installationRoot,
            });
          }),
          runner.drain(),
          then.assert("reinstall the Telegram channel", async (ctx) => {
            await expect(
              installMarketplaceArtifact(ctx, {
                listingId: TELEGRAM_CHANNEL_ID,
                version: "1.0.1",
                installationRoot,
              }),
            ).resolves.toMatchObject({ action: "restarted" });
          }),
          runner.drain(),
          then.assert("the root records both successful items exactly once", async (ctx) => {
            expect(await readMarketplaceLock(ctx)).toEqual({
              entries: [
                { listingId: TELEGRAM_CHANNEL_ID, version: "1.0.1", installationRoot },
                { listingId: GITHUB_CHANNEL_ID, version: "1.0.0", installationRoot },
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

  test("does not upgrade an existing installation, but allows another version at a different root", async () => {
    const installationRoot = "/workspace/first";
    const newerWorkflowId = await buildMarketplacePackageInstallWorkflowInstanceId({
      targetScope: TARGET_SCOPE,
      installationRoot,
      listingId: LISTING_ID,
      version: "1.2.1",
    });
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "install another Marketplace version at a separate root",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publish artifacts", publishMarketplaceArtifacts),
          runner.drain(),
          then.assert("install version 1.0.0", async (ctx) => {
            await installMarketplaceArtifact(ctx, {
              listingId: LISTING_ID,
              version: "1.0.0",
              installationRoot,
            });
          }),
          runner.drain(),
          then.assert("request another version at the occupied root", async (ctx) => {
            await installMarketplaceArtifact(ctx, {
              listingId: LISTING_ID,
              version: "1.2.1",
              installationRoot,
            });
          }),
          runner.drain(),
          then.workflow.instance({
            workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
            instanceId: newerWorkflowId,
            status: "errored",
          }),
          then.assert("the first installation is untouched", async (ctx) => {
            expect(await readMarketplaceLock(ctx)).toEqual({
              entries: [{ listingId: LISTING_ID, version: "1.0.0", installationRoot }],
            });
            const file = await readWorkspaceFile(ctx, `${installationRoot}/${WORKFLOW_FILE}`);
            assert(file.ok);
            await expect(file.text()).resolves.toBe(publishedWorkflowSource("1.0.0"));
            const result = await installMarketplaceArtifact(ctx, {
              listingId: LISTING_ID,
              version: "1.2.1",
              installationRoot: "/workspace/second",
            });
            expect(result.workflowInstanceId).not.toBe(newerWorkflowId);
          }),
          runner.drain(),
          then.assert(
            "both versions have separate files and entries in the workspace lock",
            async (ctx) => {
              expect(await readMarketplaceLock(ctx)).toEqual({
                entries: [
                  { listingId: LISTING_ID, version: "1.0.0", installationRoot },
                  {
                    listingId: LISTING_ID,
                    version: "1.2.1",
                    installationRoot: "/workspace/second",
                  },
                ],
              });
              for (const root of [installationRoot, "/workspace/second"]) {
                assert(
                  (await readWorkspaceFile(ctx, `${root}/marketplace-lock.json`)).status === 404,
                );
              }
              const file = await readWorkspaceFile(ctx, `/workspace/second/${WORKFLOW_FILE}`);
              assert(file.ok);
              await expect(file.text()).resolves.toBe(publishedWorkflowSource("1.2.1"));
            },
          ),
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
            then.assert("publish artifacts", publishMarketplaceArtifacts),
            runner.drain(),
            then.assert("write an invalid lock and request installation", async (ctx) => {
              const upload = ctx.runtime.objects.upload.for(TARGET_SCOPE);
              await upload.commands.setAdminConfig({ provider: "database" }, "org-1");
              await writeUploadFile({
                fileKey: "marketplace-lock.json",
                content,
                fetch: (request) => upload.http.fetch(request),
              });
              await installMarketplaceArtifact(ctx, {
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
          UPLOAD: ({ name, state, env, runtime, implementation }) =>
            new (class extends InMemoryUploadObject {
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
            })({ state, env: env as never, runtime, implementation }),
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publish artifacts", publishMarketplaceArtifacts),
          runner.drain(),
          then.assert("seed a matching file and request installation", async (ctx) => {
            const entry = getStaticMarketplaceEntry({ slug: "telegram-channel", version: "1.0.1" });
            assert(entry);
            const upload = ctx.runtime.objects.upload.for(TARGET_SCOPE);
            await upload.commands.setAdminConfig({ provider: "database" }, "org-1");
            await writeUploadFile({
              fileKey: `atomic/${matchingFile}`,
              content: entry.files[matchingFile],
              fetch: (request) => upload.http.fetch(request),
            });
            await installMarketplaceArtifact(ctx, {
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
    "refuses an artifact that would overwrite or use the root lock as a directory: %s",
    async (relativePath) => {
      const installationRoot = "/workspace";
      const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
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
            then.assert("publish artifacts", publishMarketplaceArtifacts),
            runner.drain(),
            then.assert("add a reserved artifact file and request installation", async (ctx) => {
              const upload = ctx.runtime.objects.upload.forName(
                marketplaceArtifactUploadName(LISTING_ID),
              );
              await writeUploadFile({
                fileKey: `1.0.0/${relativePath}`,
                content: "cannot overwrite installation bookkeeping",
                fetch: (request) => upload.http.fetch(request),
              });
              await installMarketplaceArtifact(ctx, {
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
            then.assert("no artifact files or lock were installed", async (ctx) => {
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
          UPLOAD: ({ name, state, env, runtime, implementation }) =>
            new (class extends InMemoryUploadObject {
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
            })({ state, env: env as never, runtime, implementation }),
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner, when }) => [
          then.assert("publish artifacts", publishMarketplaceArtifacts),
          runner.drain(),
          then.assert("request installation", async (ctx) => {
            await installMarketplaceArtifact(ctx, {
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
              entries: [{ listingId: LISTING_ID, version: "1.0.0", installationRoot }],
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
              entries: [{ listingId: LISTING_ID, version: "1.0.0", installationRoot }],
            });
          }),
        ],
      }),
    );
  });

  test("merges a concurrently written lock entry after a revision conflict", async () => {
    const installationRoot = "/workspace/concurrent";
    const workflowInstanceId = await buildMarketplacePackageInstallWorkflowInstanceId({
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
          UPLOAD: ({ name, state, env, runtime, implementation }) =>
            new (class extends InMemoryUploadObject {
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
            })({ state, env: env as never, runtime, implementation }),
        },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner, when }) => [
          then.assert("publish artifacts", publishMarketplaceArtifacts),
          runner.drain(),
          then.assert("request installation", async (ctx) => {
            await installMarketplaceArtifact(ctx, {
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
                { listingId: LISTING_ID, version: "1.0.0", installationRoot: "/workspace/other" },
                { listingId: LISTING_ID, version: "1.0.0", installationRoot },
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
