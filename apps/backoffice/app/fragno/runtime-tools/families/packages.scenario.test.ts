import { assert, describe, expect, test, vi } from "vitest";

import { packagesInstallResultSchema } from "@fragno-dev/backoffice-api/v0/marketplace";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import {
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { createBackofficeExecutionForPrincipal } from "@/fragno/auth/backoffice-principal.server";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { ApiObject } from "../../../../workers/api-object";
import { AppInstallationsObject } from "../../../../workers/app-installations-object";
import { AppsObject } from "../../../../workers/apps-object";
import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
import { BillingObject } from "../../../../workers/billing-object";
import { CodemodeObject } from "../../../../workers/codemode-object";
import { FormsObject } from "../../../../workers/forms-object";
import { MarketplaceObject } from "../../../../workers/marketplace-object";
import { McpObject } from "../../../../workers/mcp-object";
import { TelegramObject } from "../../../../workers/telegram-object";
import { UploadObject } from "../../../../workers/upload-object";

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
  // Installing syncs each package's agents.
  PI_MANAGER: allLocalObjects.PI_MANAGER,
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const LISTING_ID = "system#telegram-test-command";
const ORG_SCOPE = { kind: "org", orgId: "org-1", jurisdiction: null } as const;
const INSTALLATION_ROOT = "/workspace/packages/telegram";
const WORKFLOW_FILE = "automations/telegram-test-command.workflow.js";

async function publishPackages(ctx: BackofficeScenarioContext) {
  await ctx.runtime.objects.automations.singleton().commands.requestStaticMarketplacePublications();
}

async function createScenarioShell(ctx: BackofficeScenarioContext, scope: BackofficeContextScope) {
  return (
    await createInteractiveBashHost({
      context: createCodemodeRouteBackedRuntimeContext({
        emitter: { kind: "caller" },
        runtime: ctx.runtime.services,
        kernel: new BackofficeKernel(ctx.runtime.services),
        execution: createBackofficeSystemExecution(scope),
      }),
    })
  ).bash;
}

describe("Workspace package runtime scenarios", () => {
  test("an agent installs a package with approved permissions, reads its settings, and uninstalls it", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<{ instanceId: string }>({
        objects: scenarioObjects,
        name: "Package tools install, inspect, and uninstall a package",
        vars: () => ({ instanceId: "" }),
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publish packages", publishPackages),
          runner.drain(),
          then.assert(
            "installation from the terminal approves the permissions the release declares",
            async (ctx) => {
              const bash = await createScenarioShell(ctx, ORG_SCOPE);
              const view = await bash.exec(
                `marketplace.view --listing-id '${LISTING_ID}' --version 2.0.0`,
              );
              assert(view.exitCode === 0, view.stderr);
              expect(view.stdout).toContain(
                "Permissions to approve for 2.0.0: integrations.execute, packages.read\n",
              );
              const unapproved = await bash.exec(
                `packages.install --listing-id '${LISTING_ID}' --version 2.0.0 --installation-root ${INSTALLATION_ROOT}`,
              );
              expect(unapproved.exitCode).not.toBe(0);
              expect(unapproved.stderr).toContain(
                "This release declares the permissions integrations.execute, packages.read",
              );
              const installed = await bash.exec(
                `packages.install --listing-id '${LISTING_ID}' --version 2.0.0 --installation-root ${INSTALLATION_ROOT}/ --permission integrations.execute --permission packages.read --format json`,
              );
              assert(installed.exitCode === 0, installed.stderr);
              const result = packagesInstallResultSchema.parse(JSON.parse(installed.stdout));
              expect(result).toMatchObject({
                action: "created",
                version: "2.0.0",
                installationRoot: INSTALLATION_ROOT,
                workflowScope: ORG_SCOPE,
              });
              ctx.vars.instanceId = result.workflowInstanceId;
            },
          ),
          runner.drain(),
          then.assert("the agent answers the install workflow its status names", async (ctx) => {
            const status = await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: `async () => await packages.status(${JSON.stringify({ workflowInstanceId: ctx.vars.instanceId, workflowScope: ORG_SCOPE })})`,
              assertToolCalls: ["packages.status"],
            });
            expect(status.result).toEqual({
              listingId: LISTING_ID,
              version: "2.0.0",
              installationRoot: INSTALLATION_ROOT,
              status: "waiting",
              installer: {
                workflowInstanceId: `${ctx.vars.instanceId}:installation`,
                status: "waiting",
              },
            });
            await expect(
              ctx.runCodemode({ scope: ORG_SCOPE, code: "async () => await packages.ls({})" }),
            ).resolves.toMatchObject({ result: { installations: [] } });
            const answered = await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: `async () => {
                const { installer } = await packages.status(${JSON.stringify({ workflowInstanceId: ctx.vars.instanceId, workflowScope: ORG_SCOPE })});
                const { waitingFor } = await workflow.getInstance({ instanceId: installer.workflowInstanceId });
                await workflow.sendEvent({
                  instanceId: installer.workflowInstanceId,
                  type: waitingFor[0],
                  payload: { message: "Configured through the installer event." },
                });
                return waitingFor;
              }`,
              assertToolCalls: ["packages.status", "workflow.getInstance", "workflow.sendEvent"],
            });
            expect(answered.result).toEqual(["telegram-test-command.message-configured"]);
          }),
          runner.drain(),
          then.assert("the run completes", async (ctx) => {
            const run = await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: `async () => await packages.status(${JSON.stringify({ workflowInstanceId: ctx.vars.instanceId, workflowScope: ORG_SCOPE })})`,
            });
            expect(run.result).toMatchObject({
              status: "complete",
              installer: { status: "complete" },
            });
          }),
          then.assert("the installation lists, with its settings", async (ctx) => {
            const bash = await createScenarioShell(ctx, ORG_SCOPE);
            const text = await bash.exec("packages.ls");
            assert(
              text.stdout === `${LISTING_ID}@2.0.0\t${INSTALLATION_ROOT}\tpublic\n`,
              text.stdout,
            );
            const run = await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: `async () => await packages.get({ listingId: ${JSON.stringify(LISTING_ID)} })`,
              assertToolCalls: ["packages.get"],
            });
            expect(run.result).toEqual({
              marketplace: { kind: "system" },
              listingId: LISTING_ID,
              version: "2.0.0",
              installationRoot: INSTALLATION_ROOT,
              permissions: [
                { namespace: "integrations", permission: "execute" },
                { namespace: "packages", permission: "read" },
              ],
              settings: { message: "Configured through the installer event." },
            });
          }),
          then.router.route({
            orgId: "org-1",
            id: "telegram-test-command",
            steward: { kind: "package", listingId: LISTING_ID },
            action: { workflowScriptPath: `${INSTALLATION_ROOT}/${WORKFLOW_FILE}` },
          }),
          then.assert("uninstalling removes the route and record but keeps files", async (ctx) => {
            const run = await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: `async () => await packages.uninstall({ listingId: ${JSON.stringify(LISTING_ID)} })`,
              assertToolCalls: ["packages.uninstall"],
            });
            expect(run.result).toMatchObject({
              installation: { listingId: LISTING_ID, version: "2.0.0" },
              removedRouteIds: ["telegram-test-command"],
            });
            const after = await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: `async () => ({ installed: await packages.ls({}), again: await packages.uninstall({ listingId: ${JSON.stringify(LISTING_ID)} }), file: await state.exists({ path: ${JSON.stringify(`${INSTALLATION_ROOT}/${WORKFLOW_FILE}`)} }) })`,
            });
            expect(after.result).toEqual({
              installed: { installations: [] },
              again: null,
              file: true,
            });
          }),
          then.router.missing({ orgId: "org-1", id: "telegram-test-command" }),
        ],
      }),
    );
  });

  test("an agent answers an install workflow waiting for two settings at once, in either order", async () => {
    const listingId = "org:org-1#two-settings";
    const packageRoot = "/workspace/authoring/two-settings";
    const installationRoot = "/workspace/packages/two-settings";
    const files = {
      "manifest.json": JSON.stringify({
        name: "@ada-labs/two-settings",
        version: "1.0.0",
        metadata: {
          name: "Two settings",
          summary: "A package whose installer asks for two settings at once.",
          description: "Its install workflow waits for a greeting and a signature in parallel.",
          category: "developer-tools",
          tags: ["testing"],
        },
        files: ["README.md", ".marketplace/install.workflow.js"],
      }),
      "README.md": "Two settings",
      ".marketplace/install.workflow.js": `export default defineWorkflow({ name: "install-two-settings" }, async (event, step) => {
  const [greeting, signature] = await Promise.all([
    step.waitForEvent("wait for greeting", { type: "two-settings.greeting" }),
    step.waitForEvent("wait for signature", { type: "two-settings.signature" }),
  ]);
  return { greeting: greeting.payload.text, signature: signature.payload.text };
});`,
    };
    const waitsOfInstaller = (instanceId: string) =>
      `async () => {
        const { installer } = await packages.status(${JSON.stringify({ workflowInstanceId: instanceId, workflowScope: ORG_SCOPE })});
        return (await workflow.getInstance({ instanceId: installer.workflowInstanceId })).waitingFor;
      }`;
    const answer = (instanceId: string, type: string, text: string) =>
      `async () => {
        const { installer } = await packages.status(${JSON.stringify({ workflowInstanceId: instanceId, workflowScope: ORG_SCOPE })});
        return await workflow.sendEvent({ instanceId: installer.workflowInstanceId, type: ${JSON.stringify(type)}, payload: { text: ${JSON.stringify(text)} } });
      }`;
    await runBackofficeScenario(
      defineBackofficeScenario<{ instanceId: string }>({
        objects: scenarioObjects,
        name: "Package installers wait for several events at once",
        vars: () => ({ instanceId: "" }),
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
        ],
        steps: ({ then, runner }) => [
          then.assert("the agent publishes the package to its organization", async (ctx) => {
            for (const [path, content] of Object.entries(files)) {
              await ctx.runCodemode({
                scope: ORG_SCOPE,
                code: `async () => await state.writeFile(${JSON.stringify({ path: `${packageRoot}/${path}`, content })})`,
              });
            }
            await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: `async () => await marketplace.publish({ packageRoot: ${JSON.stringify(packageRoot)}, visibility: "organization" })`,
              assertToolCalls: ["marketplace.publish"],
            });
          }),
          runner.drain(),
          then.assert("the agent installs it", async (ctx) => {
            const run = await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: `async () => {
                const { release } = await marketplace.view({ listingId: ${JSON.stringify(listingId)}, visibility: "organization" });
                return await packages.install({ listingId: ${JSON.stringify(listingId)}, version: release.version, installationRoot: ${JSON.stringify(installationRoot)}, permissions: release.permissions, visibility: "organization" });
              }`,
            });
            ctx.vars.instanceId = packagesInstallResultSchema.parse(run.result).workflowInstanceId;
          }),
          runner.drain(),
          then.assert(
            "the installer waits for both, and the agent sends the second",
            async (ctx) => {
              const waits = await ctx.runCodemode({
                scope: ORG_SCOPE,
                code: waitsOfInstaller(ctx.vars.instanceId),
              });
              expect(waits.result).toEqual(["two-settings.greeting", "two-settings.signature"]);
              await ctx.runCodemode({
                scope: ORG_SCOPE,
                code: answer(ctx.vars.instanceId, "two-settings.signature", "Ada"),
              });
            },
          ),
          runner.drain(),
          then.assert(
            "the installer still waits for the first, which the agent sends",
            async (ctx) => {
              const waits = await ctx.runCodemode({
                scope: ORG_SCOPE,
                code: waitsOfInstaller(ctx.vars.instanceId),
              });
              expect(waits.result).toEqual(["two-settings.greeting"]);
              await ctx.runCodemode({
                scope: ORG_SCOPE,
                code: answer(ctx.vars.instanceId, "two-settings.greeting", "Hello"),
              });
            },
          ),
          runner.drain(),
          then.assert("the installation records both settings", async (ctx) => {
            const run = await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: `async () => ({
                status: await packages.status(${JSON.stringify({ workflowInstanceId: ctx.vars.instanceId, workflowScope: ORG_SCOPE })}),
                installation: await packages.get({ listingId: ${JSON.stringify(listingId)} }),
              })`,
            });
            expect(run.result).toMatchObject({
              status: { status: "complete", installer: { status: "complete" } },
              installation: { settings: { greeting: "Hello", signature: "Ada" } },
            });
          }),
        ],
      }),
    );
  });

  test("an agent imports a legacy lock from the terminal, choosing between duplicate folders", async () => {
    const entry = (installationRoot: string) => ({
      marketplace: { kind: "system" },
      listingId: LISTING_ID,
      version: "1.0.0",
      installationRoot,
    });
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Package tools import a legacy Marketplace lock",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert("the duplicate stays until a folder is kept", async (ctx) => {
            await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: `async () => await state.writeFile({ path: "/workspace/marketplace-lock.json", content: ${JSON.stringify(JSON.stringify({ entries: [entry("/workspace/a"), entry("/workspace/b")] }))} })`,
            });
            const bash = await createScenarioShell(ctx, ORG_SCOPE);
            const conflicted = await bash.exec("packages.importLegacy");
            assert(conflicted.exitCode === 0, conflicted.stderr);
            expect(conflicted.stdout).toBe(
              `conflict\t${LISTING_ID}\t/workspace/a,/workspace/b\nlock\tkept\n`,
            );
            const kept = await bash.exec(
              `packages.importLegacy --keep '${LISTING_ID}=/workspace/b'`,
            );
            assert(kept.exitCode === 0, kept.stderr);
            expect(kept.stdout).toBe(
              `imported\t${LISTING_ID}@1.0.0\t/workspace/b\nlock\tdeleted\n`,
            );
            await expect(
              ctx.runCodemode({
                scope: ORG_SCOPE,
                code: `async () => ({ installed: await packages.ls({}), lock: await state.exists({ path: "/workspace/marketplace-lock.json" }) })`,
              }),
            ).resolves.toMatchObject({
              result: {
                installed: {
                  installations: [{ ...entry("/workspace/b"), permissions: [], settings: {} }],
                },
                lock: false,
              },
            });
          }),
        ],
      }),
    );
  });

  test("personal and project installations use organization coordination but record installations in their own workspace", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<{ projectId: string }>({
        objects: scenarioObjects,
        name: "Package installation scopes are destinations, not publishers or workflow coordinators",
        vars: () => ({ projectId: "" }),
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs", ownerUserId: "owner-1" }),
          given.organization.exists({ id: "org-2", name: "Second Org", ownerUserId: "owner-1" }),
        ],
        steps: ({ when, then, runner }) => [
          when.project.create({
            owner: { kind: "org", orgId: "org-1", jurisdiction: null },
            name: "Delivery",
            slug: "delivery",
            createdByUserId: "owner-1",
            captureIdAs: "projectId",
          }),
          then.assert("publish packages", publishPackages),
          runner.drain(),
          then.assert(
            "personal installation selects the active organization and keeps its user destination",
            async (ctx) => {
              const context = createCodemodeRouteBackedRuntimeContext({
                emitter: { kind: "caller" },
                runtime: ctx.runtime.services,
                kernel: new BackofficeKernel(ctx.runtime.services),
                execution: await createBackofficeExecutionForPrincipal(
                  {
                    user: {
                      id: "owner-1",
                      email: "owner@example.test",
                      role: "user",
                      personalScope: { kind: "user", userId: "owner-1", jurisdiction: null },
                    },
                    auth: {
                      transport: "bearer",
                      expiresAt: new Date(Date.now() + 60_000),
                      organization: {
                        id: "org-2",
                        slug: "second-org",
                        jurisdiction: null,
                        roles: ["owner"],
                      },
                      scopeRestriction: null,
                    },
                  },
                  { kind: "user", userId: "owner-1", jurisdiction: null },
                  ctx.runtime.objects.auth.singleton().commands,
                ),
              });
              const { bash } = await createInteractiveBashHost({ context });
              const personal = await bash.exec(
                `packages.install --listing-id '${LISTING_ID}' --version 1.0.0 --installation-root ${INSTALLATION_ROOT} --format json`,
              );
              assert(personal.exitCode === 0, personal.stderr);
              expect(JSON.parse(personal.stdout)).toMatchObject({
                workflowScope: { kind: "org", orgId: "org-2", jurisdiction: null },
              });
              const project = await ctx.runCodemode({
                scope: ORG_SCOPE,
                code: `async () => await context.project(${JSON.stringify(ctx.vars.projectId)}).packages.install(${JSON.stringify({ listingId: LISTING_ID, version: "1.0.0", installationRoot: INSTALLATION_ROOT })})`,
              });
              expect(project.result).toMatchObject({ workflowScope: ORG_SCOPE, action: "created" });
            },
          ),
          runner.drain(),
          then.assert(
            "the organization has no installation while the user and project workspaces do",
            async (ctx) => {
              const scope = {
                kind: "project",
                owner: { kind: "org", orgId: "org-1", jurisdiction: null },
                projectId: ctx.vars.projectId,
              } as const;
              const expected = {
                installations: [
                  {
                    marketplace: { kind: "system" },
                    listingId: LISTING_ID,
                    version: "1.0.0",
                    installationRoot: INSTALLATION_ROOT,
                    permissions: [],
                    settings: {},
                  },
                ],
              };
              for (const target of [
                { kind: "user", userId: "owner-1", jurisdiction: null } as const,
                scope,
              ]) {
                const list = await ctx.runCodemode({
                  scope: target,
                  code: "async () => await packages.ls({})",
                });
                expect(list.result).toEqual(expected);
              }
              const organization = await ctx.runCodemode({
                scope: ORG_SCOPE,
                code: "async () => await packages.ls({})",
              });
              expect(organization.result).toEqual({ installations: [] });
            },
          ),
        ],
      }),
    );
  });

  test("authenticated personal installations use the request's organization for coordination", async () => {
    // A request authenticated for the organization, as the owner's active one.
    const personalShell = async (
      ctx: BackofficeScenarioContext,
      organization: { id: string; slug: string },
    ) => {
      const principal = {
        user: {
          id: "owner-1",
          email: "owner@example.test",
          role: "user" as const,
          personalScope: { kind: "user" as const, userId: "owner-1", jurisdiction: null },
        },
        auth: {
          transport: "bearer" as const,
          expiresAt: new Date(Date.now() + 60_000),
          organization: { ...organization, jurisdiction: null, roles: ["owner"] },
          scopeRestriction: null,
        },
      };
      const context = createCodemodeRouteBackedRuntimeContext({
        emitter: { kind: "caller" },
        runtime: ctx.runtime.services,
        kernel: new BackofficeKernel(ctx.runtime.services),
        execution: await createBackofficeExecutionForPrincipal(
          principal,
          { kind: "user", userId: "owner-1", jurisdiction: null },
          ctx.runtime.objects.auth.singleton().commands,
        ),
      });
      return (await createInteractiveBashHost({ context })).bash;
    };
    await runBackofficeScenario(
      defineBackofficeScenario<{ instanceId: string }>({
        objects: scenarioObjects,
        name: "Request authority selects personal package installation coordination",
        vars: () => ({ instanceId: "" }),
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs", ownerUserId: "owner-1" }),
          given.organization.exists({ id: "org-2", name: "Second Org", ownerUserId: "owner-1" }),
        ],
        steps: ({ then, runner }) => [
          then.assert("publish packages", publishPackages),
          runner.drain(),
          then.assert("the authenticated organization coordinates installation", async (ctx) => {
            const result = await (
              await personalShell(ctx, { id: "org-1", slug: "ada-labs" })
            ).exec(
              `packages.install --listing-id '${LISTING_ID}' --version 1.0.0 --installation-root ${INSTALLATION_ROOT} --format json`,
            );
            assert(result.exitCode === 0, result.stderr);
            const installed = packagesInstallResultSchema.parse(JSON.parse(result.stdout));
            expect(installed).toMatchObject({ workflowScope: ORG_SCOPE });
            ctx.vars.instanceId = installed.workflowInstanceId;
          }),
          runner.drain(),
          then.assert("the deferred workflow installs into the personal workspace", async (ctx) => {
            const result = await ctx.runCodemode({
              scope: { kind: "user", userId: "owner-1", jurisdiction: null },
              code: "async () => await packages.ls({})",
            });
            expect(result.result).toMatchObject({
              installations: [{ listingId: LISTING_ID, version: "1.0.0" }],
            });
          }),
          then.assert(
            "the personal workspace reads the run's status with another organization active; the organization's workspace does not",
            async (ctx) => {
              const status = await (
                await personalShell(ctx, { id: "org-2", slug: "second-org" })
              ).exec(
                `packages.status --workflow-instance-id ${ctx.vars.instanceId} --workflow-scope '${JSON.stringify(ORG_SCOPE)}' --format json`,
              );
              assert(status.exitCode === 0, status.stderr);
              expect(JSON.parse(status.stdout)).toEqual({
                listingId: LISTING_ID,
                version: "1.0.0",
                installationRoot: INSTALLATION_ROOT,
                status: "complete",
                installer: null,
              });
              const organization = await ctx.runCodemode({
                scope: ORG_SCOPE,
                code: `async () => await packages.status(${JSON.stringify({ workflowInstanceId: ctx.vars.instanceId, workflowScope: ORG_SCOPE })})`,
              });
              expect(organization.result).toBeNull();
              await expect(
                ctx.runCodemode({
                  scope: ORG_SCOPE,
                  code: `async () => await packages.status(${JSON.stringify({ workflowInstanceId: ctx.vars.instanceId, workflowScope: { kind: "org", orgId: "org-2", jurisdiction: null } })})`,
                }),
              ).rejects.toThrow(
                "This workspace installs through organization 'org-1', not 'org-2'.",
              );
            },
          ),
        ],
      }),
    );
  });

  test("invalid install inputs are rejected without scheduling installation", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Package tool boundaries reject invalid input",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert("validation does not schedule workflows", async (ctx) => {
            const bash = await createScenarioShell(ctx, ORG_SCOPE);
            for (const args of [
              "",
              "--installation-root /static/telegram",
              "--installation-root /workspace/../telegram",
              "--installation-root /workspace/marketplace-lock.json",
              "--installation-root /workspace/telegram --force",
              "--installation-root /workspace/telegram --version latest",
              "--installation-root /workspace/telegram --permission telegram.send",
            ]) {
              const result = await bash.exec(
                `packages.install --listing-id '${LISTING_ID}' ${args}`,
              );
              expect(result.exitCode).not.toBe(0);
            }
            await expect(
              ctx.runCodemode({
                scope: ORG_SCOPE,
                code: `async () => await packages.install(${JSON.stringify({ listingId: LISTING_ID, installationRoot: INSTALLATION_ROOT, targetScope: { kind: "org", orgId: "org-2", jurisdiction: null } })})`,
              }),
            ).rejects.toThrow("targetScope");
            const missing = await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: "async () => await packages.ls({})",
            });
            expect(missing.result).toEqual({ installations: [] });
          }),
        ],
      }),
    );
  });

  test("file conflicts still fail in the existing workflow without replacing local content or recording success", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<{ instanceId: string }>({
        objects: scenarioObjects,
        name: "Package runtime retains non-destructive installation",
        vars: () => ({ instanceId: "" }),
        options: { allowErroredWorkflows: true },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publish packages", publishPackages),
          runner.drain(),
          then.assert("a local file conflicts with the selected package", async (ctx) => {
            await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: `async () => await state.writeFile({ path: ${JSON.stringify(`${INSTALLATION_ROOT}/${WORKFLOW_FILE}`)}, content: "local changes" })`,
            });
            const run = await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: `async () => {
                const { release } = await marketplace.view({ listingId: ${JSON.stringify(LISTING_ID)}, version: "1.0.0" });
                return await packages.install({ listingId: ${JSON.stringify(LISTING_ID)}, version: release.version, installationRoot: ${JSON.stringify(INSTALLATION_ROOT)}, permissions: release.permissions });
              }`,
              assertToolCalls: ["marketplace.view", "packages.install"],
            });
            ctx.vars.instanceId = packagesInstallResultSchema.parse(run.result).workflowInstanceId;
          }),
          runner.drain(),
          then.assert("failure preserves the file and records no installation", async (ctx) => {
            const status = await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: `async () => await packages.status(${JSON.stringify({ workflowInstanceId: ctx.vars.instanceId, workflowScope: ORG_SCOPE })})`,
            });
            expect(status.result).toEqual({
              listingId: LISTING_ID,
              version: "1.0.0",
              installationRoot: INSTALLATION_ROOT,
              status: "errored",
              error: {
                name: "NonRetryableError",
                message: `Marketplace ingestion conflicts with workspace file '${INSTALLATION_ROOT}/${WORKFLOW_FILE}'.`,
              },
              installer: null,
            });
            const state = await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: `async () => ({ content: await state.readFile({ path: ${JSON.stringify(`${INSTALLATION_ROOT}/${WORKFLOW_FILE}`)} }), installed: await packages.ls({}) })`,
            });
            expect(state.result).toEqual({
              content: "local changes",
              installed: { installations: [] },
            });
          }),
        ],
      }),
    );
  });

  test("tools retain authorization, unavailable scopes, and personal organization membership requirements", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Package runtime permission and scope boundaries",
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs", ownerUserId: "owner-1" }),
          given.auth.user({ id: "outsider-1", email: "outsider@example.test" }),
        ],
        steps: ({ then }) => [
          then.assert(
            "denied contexts cannot discover, install or read workspace packages",
            async (ctx) => {
              const agentContext = createCodemodeRouteBackedRuntimeContext({
                emitter: { kind: "caller" },
                runtime: ctx.runtime.services,
                kernel: new BackofficeKernel(ctx.runtime.services),
                execution: createBackofficeServiceExecution({
                  scope: ORG_SCOPE,
                  service: { type: "agent", id: "limited-agent" },
                }),
              });
              const { bash } = await createInteractiveBashHost({ context: agentContext });
              for (const [command, permission] of [
                ["marketplace.search --query telegram", "marketplace.read"],
                ["packages.ls", "packages.read"],
                [
                  `packages.install --listing-id '${LISTING_ID}' --installation-root ${INSTALLATION_ROOT}`,
                  "packages.install",
                ],
                [`packages.uninstall --listing-id '${LISTING_ID}'`, "packages.install"],
              ]) {
                const result = await bash.exec(command);
                expect(result.exitCode).not.toBe(0);
                expect(result.stderr).toContain(`Required permission: ${permission}.`);
              }
              const system = await createScenarioShell(ctx, { kind: "system" });
              const unavailable = await system.exec("packages.ls");
              expect(unavailable.exitCode).not.toBe(0);
              expect(unavailable.stderr).toContain("Backoffice command unavailable");
              const personalContext = createCodemodeRouteBackedRuntimeContext({
                emitter: { kind: "caller" },
                runtime: ctx.runtime.services,
                kernel: new BackofficeKernel(ctx.runtime.services),
                execution: createBackofficeUserExecution({
                  scope: { kind: "user", userId: "outsider-1", jurisdiction: null },
                  userId: "outsider-1",
                }),
              });
              const personalShell = (await createInteractiveBashHost({ context: personalContext }))
                .bash;
              const membership = await personalShell.exec(
                `packages.install --listing-id '${LISTING_ID}' --installation-root ${INSTALLATION_ROOT}`,
              );
              expect(membership.exitCode).not.toBe(0);
              expect(membership.stderr).toContain("Join an organization");
              const deniedContext = createCodemodeRouteBackedRuntimeContext({
                emitter: { kind: "caller" },
                runtime: ctx.runtime.services,
                kernel: new BackofficeKernel(ctx.runtime.services),
                execution: createBackofficeUserExecution({
                  scope: ORG_SCOPE,
                  userId: "outsider-1",
                }),
              });
              const denied = await (
                await createInteractiveBashHost({
                  context: deniedContext,
                })
              ).bash.exec("packages.ls");
              expect(denied.exitCode).not.toBe(0);
              expect(denied.stderr).toContain("Required permission: packages.read.");
            },
          ),
        ],
      }),
    );
  });
});
