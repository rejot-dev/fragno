import { assert, describe, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import {
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
  type BackofficeContextScope,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { createBackofficeExecutionForPrincipal } from "@/fragno/auth/backoffice-principal.server";
import { CODEMODE_WORKFLOW } from "@/fragno/automation/engine/codemode-invocation";
import { MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME } from "@/fragno/automation/marketplace-package-install-identity";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createRouteBackedAutomationWorkflowRuntime } from "@/fragno/automation/workflow-route-runtime";
import { MARKETPLACE_LOCK_PATH } from "@/fragno/marketplace/marketplace-lock";
import { getStaticMarketplaceEntry } from "@/fragno/marketplace/static-entries";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { packagesInstallResultSchema } from "./packages-runtime";

const LISTING_ID = "system#telegram-test-command";
const ORG_SCOPE = { kind: "org", orgId: "org-1" } as const;
const INSTALLATION_ROOT = "/workspace/packages/telegram";
const WORKFLOW_FILE = "automations/telegram-test-command.workflow.js";

async function publishArtifacts(ctx: BackofficeScenarioContext) {
  await ctx.runtime.objects.automations.singleton().commands.requestStaticMarketplacePublications();
}

async function submitInstallerConfiguration(ctx: BackofficeScenarioContext, instanceId: string) {
  const workflow = createRouteBackedAutomationWorkflowRuntime({
    object: ctx.runtime.objects.automations.for(ORG_SCOPE),
    execution: createBackofficeSystemExecution(ORG_SCOPE),
  });
  await workflow.sendInternalEvent({
    workflowName: CODEMODE_WORKFLOW,
    instanceId: `${instanceId}:installation`,
    type: "telegram-test-command.message-configured",
    payload: { message: "Configured through the existing installer event." },
  });
}

function createScenarioShell(ctx: BackofficeScenarioContext, scope: BackofficeContextScope) {
  return createInteractiveBashHost({
    context: createCodemodeRouteBackedRuntimeContext({
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      execution: createBackofficeSystemExecution(scope),
      billingOrganizationId: null,
    }),
  }).bash;
}

describe("Workspace package runtime scenarios", () => {
  test("codemode installs through the existing restart flow and terminal lists the successful root lock", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<{ instanceId: string; version: string }>({
        name: "Package runtime installation preserves the UI workflow semantics",
        vars: () => ({ instanceId: "", version: "" }),
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publish artifacts", publishArtifacts),
          runner.drain(),
          then.assert(
            "new installation is an asynchronous workflow, not a successful lock entry",
            async (ctx) => {
              const run = await ctx.runCodemode({
                scope: ORG_SCOPE,
                code: `async () => await packages.install(${JSON.stringify({ listingId: LISTING_ID, installationRoot: `${INSTALLATION_ROOT}/` })})`,
                assertToolCalls: ["packages.install"],
              });
              const result = packagesInstallResultSchema.parse(run.result);
              const manifest = await ctx.runtime.objects.marketplace
                .singleton()
                .commands.getArtifactManifest({ listingId: LISTING_ID });
              assert(manifest);
              expect(result).toMatchObject({
                action: "created",
                version: manifest.versions[0],
                installationRoot: INSTALLATION_ROOT,
                workflowScope: ORG_SCOPE,
                workflowStatus: "active",
              });
              ctx.vars.instanceId = result.workflowInstanceId;
              ctx.vars.version = result.version;
              const before = await ctx.runCodemode({
                scope: ORG_SCOPE,
                code: "async () => await packages.ls({})",
                assertToolCalls: ["packages.ls"],
              });
              expect(before.result).toEqual({ entries: [] });
            },
          ),
          runner.drain(),
          then.assert("complete the existing interactive installer", async (ctx) => {
            const list = await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: "async () => await packages.ls({})",
            });
            expect(list.result).toEqual({ entries: [] });
            await submitInstallerConfiguration(ctx, ctx.vars.instanceId);
          }),
          runner.drain(),
          then.assert(
            "success records the selected folder and publishes the real files and route",
            async (ctx) => {
              const bash = createScenarioShell(ctx, ORG_SCOPE);
              const list = await bash.exec("packages.ls --format json");
              assert(list.exitCode === 0, list.stderr);
              expect(JSON.parse(list.stdout)).toEqual({
                entries: [
                  {
                    listingId: LISTING_ID,
                    version: ctx.vars.version,
                    installationRoot: INSTALLATION_ROOT,
                  },
                ],
              });
              const text = await bash.exec("packages.ls");
              assert(
                text.stdout === `${LISTING_ID}@${ctx.vars.version}\t${INSTALLATION_ROOT}\n`,
                text.stdout,
              );
              const read = await ctx.runCodemode({
                scope: ORG_SCOPE,
                code: `async () => await state.readFile({ path: ${JSON.stringify(`${INSTALLATION_ROOT}/${WORKFLOW_FILE}`)} })`,
              });
              const entry = getStaticMarketplaceEntry({
                slug: "telegram-test-command",
                version: ctx.vars.version,
              });
              assert(entry);
              assert(read.result === entry.files[WORKFLOW_FILE]);
              const route = await ctx.runtime.objects.automations
                .for(ORG_SCOPE)
                .http.fetch(
                  new Request(
                    "https://automations.test/api/automations/routes/telegram-test-command",
                  ),
                );
              assert(route.ok);
              expect(await route.json()).toMatchObject({
                action: { workflowScriptPath: `${INSTALLATION_ROOT}/${WORKFLOW_FILE}` },
              });
              const repeated = await bash.exec(
                `packages.install --listing-id '${LISTING_ID}' --version ${ctx.vars.version} --installation-root ${INSTALLATION_ROOT} --format json`,
              );
              assert(repeated.exitCode === 0, repeated.stderr);
              expect(JSON.parse(repeated.stdout)).toMatchObject({
                action: "restarted",
                workflowInstanceId: ctx.vars.instanceId,
              });
            },
          ),
          runner.drain(),
          then.assert("complete the restarted installer", async (ctx) => {
            await submitInstallerConfiguration(ctx, ctx.vars.instanceId);
          }),
          runner.drain(),
          then.assert("repeated installation does not duplicate the lock entry", async (ctx) => {
            const run = await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: "async () => await packages.ls({})",
            });
            expect(run.result).toEqual({
              entries: [
                {
                  listingId: LISTING_ID,
                  version: ctx.vars.version,
                  installationRoot: INSTALLATION_ROOT,
                },
              ],
            });
          }),
        ],
      }),
    );
  });

  test("personal and project installations use organization coordination but isolated destination locks", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<{ projectId: string }>({
        name: "Package installation scopes are destinations, not publishers or workflow coordinators",
        vars: () => ({ projectId: "" }),
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs", ownerUserId: "owner-1" }),
          given.organization.exists({ id: "org-2", name: "Second Org", ownerUserId: "owner-1" }),
        ],
        steps: ({ when, then, runner }) => [
          when.project.create({
            orgId: "org-1",
            name: "Delivery",
            slug: "delivery",
            createdByUserId: "owner-1",
            captureIdAs: "projectId",
          }),
          then.assert("publish artifacts", publishArtifacts),
          runner.drain(),
          then.assert(
            "personal installation selects the active organization and keeps its user destination",
            async (ctx) => {
              const context = createCodemodeRouteBackedRuntimeContext({
                runtime: ctx.runtime.services,
                kernel: new BackofficeKernel(ctx.runtime.services),
                execution: createBackofficeUserExecution({
                  scope: { kind: "user", userId: "owner-1" },
                  userId: "owner-1",
                }),
                billingOrganizationId: "org-2",
              });
              const { bash } = createInteractiveBashHost({ context });
              const personal = await bash.exec(
                `packages.install --listing-id '${LISTING_ID}' --version 1.2.1 --installation-root ${INSTALLATION_ROOT} --format json`,
              );
              assert(personal.exitCode === 0, personal.stderr);
              expect(JSON.parse(personal.stdout)).toMatchObject({
                workflowScope: { kind: "org", orgId: "org-2" },
              });
              const project = await ctx.runCodemode({
                scope: ORG_SCOPE,
                code: `async () => await context.project(${JSON.stringify(ctx.vars.projectId)}).packages.install(${JSON.stringify({ listingId: LISTING_ID, version: "1.2.1", installationRoot: INSTALLATION_ROOT })})`,
              });
              expect(project.result).toMatchObject({ workflowScope: ORG_SCOPE, action: "created" });
            },
          ),
          runner.drain(),
          then.assert(
            "the organization lock is empty while user and project locks record installations",
            async (ctx) => {
              const scope = {
                kind: "project",
                orgId: "org-1",
                projectId: ctx.vars.projectId,
              } as const;
              const expected = {
                entries: [
                  { listingId: LISTING_ID, version: "1.2.1", installationRoot: INSTALLATION_ROOT },
                ],
              };
              for (const target of [{ kind: "user", userId: "owner-1" } as const, scope]) {
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
              expect(organization.result).toEqual({ entries: [] });
            },
          ),
        ],
      }),
    );
  });

  test("authenticated personal installations prefer request authority over the billing organization", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "Request authority selects personal package installation coordination",
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs", ownerUserId: "owner-1" }),
          given.organization.exists({ id: "org-2", name: "Second Org", ownerUserId: "owner-1" }),
        ],
        steps: ({ then, runner }) => [
          then.assert("publish artifacts", publishArtifacts),
          runner.drain(),
          then.assert("the authenticated organization overrides billing", async (ctx) => {
            const principal = {
              user: { id: "owner-1", email: "owner@example.test", role: "user" as const },
              auth: {
                transport: "bearer" as const,
                expiresAt: new Date(Date.now() + 60_000),
                organization: { id: "org-1", slug: "ada-labs", roles: ["owner"] },
                scopeRestriction: null,
              },
            };
            const context = createCodemodeRouteBackedRuntimeContext({
              runtime: ctx.runtime.services,
              kernel: new BackofficeKernel(ctx.runtime.services),
              execution: createBackofficeExecutionForPrincipal(principal, {
                kind: "user",
                userId: "owner-1",
              }),
              billingOrganizationId: "org-2",
            });
            const result = await createInteractiveBashHost({ context }).bash.exec(
              `packages.install --listing-id '${LISTING_ID}' --version 1.2.1 --installation-root ${INSTALLATION_ROOT} --format json`,
            );
            assert(result.exitCode === 0, result.stderr);
            expect(JSON.parse(result.stdout)).toMatchObject({ workflowScope: ORG_SCOPE });
          }),
          runner.drain(),
          then.assert("the deferred workflow installs into the personal workspace", async (ctx) => {
            const result = await ctx.runCodemode({
              scope: { kind: "user", userId: "owner-1" },
              code: "async () => await packages.ls({})",
            });
            expect(result.result).toEqual({
              entries: [
                { listingId: LISTING_ID, version: "1.2.1", installationRoot: INSTALLATION_ROOT },
              ],
            });
          }),
        ],
      }),
    );
  });

  test("missing locks are empty, malformed locks fail without writes, and invalid install inputs are rejected", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "Package tool boundaries preserve workspace data",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert(
            "validation does not schedule workflows or rewrite malformed locks",
            async (ctx) => {
              const bash = createScenarioShell(ctx, ORG_SCOPE);
              for (const args of [
                "",
                "--installation-root /static/telegram",
                "--installation-root /workspace/../telegram",
                "--installation-root /workspace/marketplace-lock.json",
                "--installation-root /workspace/telegram --force",
                "--installation-root /workspace/telegram --version latest",
              ]) {
                const result = await bash.exec(
                  `packages.install --listing-id '${LISTING_ID}' ${args}`,
                );
                expect(result.exitCode).not.toBe(0);
              }
              await expect(
                ctx.runCodemode({
                  scope: ORG_SCOPE,
                  code: `async () => await packages.install(${JSON.stringify({ listingId: LISTING_ID, installationRoot: INSTALLATION_ROOT, targetScope: { kind: "org", orgId: "org-2" } })})`,
                }),
              ).rejects.toThrow("targetScope");
              const missing = await ctx.runCodemode({
                scope: ORG_SCOPE,
                code: "async () => await packages.ls({})",
              });
              expect(missing.result).toEqual({ entries: [] });
              const absent = await ctx.runCodemode({
                scope: ORG_SCOPE,
                code: `async () => await state.exists({ path: ${JSON.stringify(MARKETPLACE_LOCK_PATH)} })`,
              });
              assert(absent.result === false);
              await ctx.runCodemode({
                scope: ORG_SCOPE,
                code: `async () => await state.writeFile({ path: ${JSON.stringify(MARKETPLACE_LOCK_PATH)}, content: "not JSON" })`,
              });
              const malformed = await bash.exec("packages.ls --format json");
              expect(malformed.exitCode).not.toBe(0);
              expect(malformed.stderr).toContain(
                `Marketplace lock file '${MARKETPLACE_LOCK_PATH}' is invalid.`,
              );
              const content = await ctx.runCodemode({
                scope: ORG_SCOPE,
                code: `async () => await state.readFile({ path: ${JSON.stringify(MARKETPLACE_LOCK_PATH)} })`,
              });
              assert(content.result === "not JSON");
            },
          ),
        ],
      }),
    );
  });

  test("file conflicts still fail in the existing workflow without replacing local content or recording success", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<{ instanceId: string }>({
        name: "Package runtime retains non-destructive installation",
        vars: () => ({ instanceId: "" }),
        options: { allowErroredWorkflows: true },
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then, runner }) => [
          then.assert("publish artifacts", publishArtifacts),
          runner.drain(),
          then.assert("a local file conflicts with the selected artifact", async (ctx) => {
            await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: `async () => await state.writeFile({ path: ${JSON.stringify(`${INSTALLATION_ROOT}/${WORKFLOW_FILE}`)}, content: "local changes" })`,
            });
            const run = await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: `async () => await packages.install(${JSON.stringify({ listingId: LISTING_ID, version: "1.2.1", installationRoot: INSTALLATION_ROOT })})`,
            });
            ctx.vars.instanceId = packagesInstallResultSchema.parse(run.result).workflowInstanceId;
          }),
          runner.drain(),
          then.assert("failure preserves the file and keeps the root lock absent", async (ctx) => {
            const workflow = createRouteBackedAutomationWorkflowRuntime({
              object: ctx.runtime.objects.automations.for(ORG_SCOPE),
              execution: createBackofficeSystemExecution(ORG_SCOPE),
            });
            const instance = await workflow.getInternalInstance({
              workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
              instanceId: ctx.vars.instanceId,
            });
            assert(instance.details.status === "errored");
            const state = await ctx.runCodemode({
              scope: ORG_SCOPE,
              code: `async () => ({ content: await state.readFile({ path: ${JSON.stringify(`${INSTALLATION_ROOT}/${WORKFLOW_FILE}`)} }), installed: await packages.ls({}) })`,
            });
            expect(state.result).toEqual({ content: "local changes", installed: { entries: [] } });
          }),
        ],
      }),
    );
  });

  test("tools retain authorization, unavailable scopes, and personal organization membership requirements", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
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
                runtime: ctx.runtime.services,
                kernel: new BackofficeKernel(ctx.runtime.services),
                execution: createBackofficeServiceExecution({
                  scope: ORG_SCOPE,
                  service: { type: "agent", id: "limited-agent" },
                }),
                billingOrganizationId: null,
              });
              const { bash } = createInteractiveBashHost({ context: agentContext });
              for (const [command, permission] of [
                ["marketplace.search --query telegram", "marketplace.read"],
                ["packages.ls", "packages.read"],
                [
                  `packages.install --listing-id '${LISTING_ID}' --installation-root ${INSTALLATION_ROOT}`,
                  "packages.install",
                ],
              ]) {
                const result = await bash.exec(command);
                expect(result.exitCode).not.toBe(0);
                expect(result.stderr).toContain(`Required permission: ${permission}.`);
              }
              const system = createScenarioShell(ctx, { kind: "system" });
              const unavailable = await system.exec("packages.ls");
              expect(unavailable.exitCode).not.toBe(0);
              expect(unavailable.stderr).toContain("Backoffice command unavailable");
              const personalContext = createCodemodeRouteBackedRuntimeContext({
                runtime: ctx.runtime.services,
                kernel: new BackofficeKernel(ctx.runtime.services),
                execution: createBackofficeUserExecution({
                  scope: { kind: "user", userId: "outsider-1" },
                  userId: "outsider-1",
                }),
                billingOrganizationId: null,
              });
              const personalShell = createInteractiveBashHost({ context: personalContext }).bash;
              const membership = await personalShell.exec(
                `packages.install --listing-id '${LISTING_ID}' --installation-root ${INSTALLATION_ROOT}`,
              );
              expect(membership.exitCode).not.toBe(0);
              expect(membership.stderr).toContain("Join an organization");
              const deniedContext = createCodemodeRouteBackedRuntimeContext({
                runtime: ctx.runtime.services,
                kernel: new BackofficeKernel(ctx.runtime.services),
                execution: createBackofficeUserExecution({
                  scope: ORG_SCOPE,
                  userId: "outsider-1",
                }),
                billingOrganizationId: null,
              });
              const denied = await createInteractiveBashHost({
                context: deniedContext,
              }).bash.exec("packages.ls");
              expect(denied.exitCode).not.toBe(0);
              expect(denied.stderr).toContain("Required permission: packages.read.");
            },
          ),
        ],
      }),
    );
  });
});
