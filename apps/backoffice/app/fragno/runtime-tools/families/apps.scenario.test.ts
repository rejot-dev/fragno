import { assert, describe, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import {
  createBackofficeRequestExecution,
  createBackofficeUserExecution,
  createBackofficeSystemExecution,
  createBackofficeServiceExecution,
  type BackofficeContextScope,
} from "@/backoffice-runtime/context";
import type { BackofficeDatabaseAdapterFactory } from "@/backoffice-runtime/database-adapters";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import {
  backofficeAppInstallationMutationResultSchema,
  backofficeAppInstallationPageSchema,
  backofficeAppInstallationSchema,
} from "@/fragno/app-installations/contracts";
import { backofficeAppSchema } from "@/fragno/apps/contracts";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
  type BackofficeScenarioDefinition,
} from "@/fragno/automation/scenario";
import { runBackofficeCodemode } from "@/fragno/codemode/execute";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { executeBackofficeRuntimeTool } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { InMemoryAppsObject } from "../../../../workers/apps.do";
import { appsToolFamily } from "./apps";

const requestedPermissions = [BACKOFFICE_PERMISSION.events.emit, BACKOFFICE_PERMISSION.events.read];

function appContext(
  ctx: BackofficeScenarioContext,
  userId: string,
  scope: BackofficeContextScope = { kind: "org", orgId: "org-1" },
  requestAuthority = false,
) {
  const execution = requestAuthority
    ? createBackofficeRequestExecution({
        scope,
        userId,
        verifiedRequestAuthority: {
          role: "admin",
          organizationId: "org-1",
          expiresAt: new Date(ctx.runtime.now() + 60_000),
          scopeRestriction: { kind: "org", orgId: "org-1" },
        },
      })
    : createBackofficeUserExecution({ scope, userId });
  return createRouteBackedRuntimeContext({
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution,
    billingOrganizationId: null,
  });
}

function appTool(name: string) {
  const tool = appsToolFamily.tools.find((candidate) => candidate.name === name);
  assert(tool, `Unknown app tool ${name}`);
  return tool;
}

async function registerApp(ctx: BackofficeScenarioContext, name = "Accounting") {
  const client = await ctx.runtime.objects.auth.singleton().commands.createAdminOAuthClient({
    administratorUserId: "global-admin",
    name,
    redirectUris: ["https://accounting.example/callback"],
    scopes: ["openid", "profile", "email"],
    clientType: "public",
    applicationType: "web",
  });
  const registered = await ctx.runtime.objects.apps.singleton().commands.registerApp({
    oauthClientId: client.clientId,
    requestedPermissions,
  });
  assert(registered.ok);
  return registered.value.appId;
}

async function runAppsSqliteScenario<TVars extends Record<string, unknown>>(
  scenario: BackofficeScenarioDefinition<TVars>,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-app-installation-tools-"));
  try {
    await runBackofficeScenario({
      ...scenario,
      options: { ...scenario.options, sqliteDataDirectory: directory },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("organization app installation runtime tool SQLite scenarios", () => {
  test("owners review declarations and approve, update, uninstall, and reinstall through Codemode and Bash", async () => {
    await runAppsSqliteScenario(
      defineBackofficeScenario({
        name: "organization-owned approval lifecycle through both adapters",
        setup: ({ given }) => [
          given.auth.user({ id: "global-admin", role: "admin" }),
          given.auth.user({ id: "owner" }),
          given.auth.user({ id: "org-admin" }),
          given.auth.organization({ id: "org-1", ownerUserId: "owner" }),
          given.auth.member({ orgId: "org-1", userId: "org-admin", roles: ["admin"] }),
        ],
        steps: ({ then }) => [
          then.assert(
            "approval is explicit and preserves organization and installer identity",
            async (ctx) => {
              const appId = await registerApp(ctx);
              const ownerContext = appContext(ctx, "owner");
              assert(ownerContext.stateBackend);
              const { bash } = createInteractiveBashHost({
                context: { ...ownerContext, stateBackend: ownerContext.stateBackend },
              });
              const empty = await bash.exec("apps.installations.list");
              assert.equal(empty.exitCode, 0, empty.stderr);
              assert.equal(
                empty.stdout,
                "No Backoffice app installations found.\nMore results: no\nNext cursor: none\n",
              );
              const declaration = await bash.exec(`apps.get --app-id ${appId}`);
              assert.equal(declaration.exitCode, 0, declaration.stderr);
              expect(declaration.stdout).toContain(
                "Requested permissions: events.emit, events.read\n",
              );
              assert(ctx.runtime.env.codemode);
              const result = await runBackofficeCodemode({
                code: `async () => {
                const app = await apps.get({ appId: ${JSON.stringify(appId)} });
                const installed = await apps.install({ appId: app.id, grantedPermissions: [{ namespace: "events", permission: "emit" }] });
                const installation = await apps.getInstallation({ appId: app.id });
                return { app, installed, installation, page: await apps.listInstallations({}) };
              }`,
                env: ctx.runtime.env.codemode,
                families: runtimeToolFamilies,
                toolContext: createBackofficeToolContext(ownerContext),
              });
              assert(!result.error, result.error ?? "Codemode failed");
              const data = z
                .strictObject({
                  app: backofficeAppSchema,
                  installed: backofficeAppInstallationMutationResultSchema,
                  installation: backofficeAppInstallationSchema,
                  page: backofficeAppInstallationPageSchema,
                })
                .parse(result.result);
              expect(data.app.requestedPermissions).toEqual(requestedPermissions);
              assert(data.installed.changed);
              expect(data.installation).toMatchObject({
                id: data.installed.installationId,
                appId,
                organizationId: "org-1",
                status: "active",
                installedByUserId: "owner",
                grantedPermissions: [BACKOFFICE_PERMISSION.events.emit],
              });
              expect(data.page.installations).toEqual([data.installation]);
              const inspected = await bash.exec(
                `apps.installations.get --app-id ${appId} --format json`,
              );
              assert.equal(inspected.exitCode, 0, inspected.stderr);
              expect(backofficeAppInstallationSchema.parse(JSON.parse(inspected.stdout))).toEqual(
                data.installation,
              );
              const listed = await bash.exec("apps.installations.list --format text");
              assert.equal(listed.exitCode, 0, listed.stderr);
              expect(listed.stdout).toContain(`Installation ID: ${data.installation.id}\n`);
              expect(listed.stdout).toContain("Granted permissions: events.emit\n");
              const printed = await bash.exec("apps.installations.list --print installations.0.id");
              assert.equal(printed.exitCode, 0, printed.stderr);
              expect(printed.stdout).toBe(`${data.installation.id}\n`);
              const adminContext = appContext(ctx, "org-admin");
              const adminTools = createBackofficeToolContext(adminContext);
              expect(
                await executeBackofficeRuntimeTool(
                  appTool("install"),
                  {
                    appId,
                    grantedPermissions: [BACKOFFICE_PERMISSION.events.emit],
                  },
                  adminTools,
                ),
              ).toEqual({ installationId: data.installation.id, changed: false });
              await expect(
                executeBackofficeRuntimeTool(
                  appTool("install"),
                  {
                    appId,
                    grantedPermissions: requestedPermissions,
                  },
                  adminTools,
                ),
              ).rejects.toThrow("update grants explicitly");
              const updated = await bash.exec(
                `apps.installations.grants.update --app-id ${appId} --granted-permissions-json '[]'`,
              );
              assert.equal(updated.exitCode, 0, updated.stderr);
              expect(updated.stdout).toContain("Updated installation grants.");
              expect(
                await executeBackofficeRuntimeTool(
                  appTool("getInstallation"),
                  { appId },
                  adminTools,
                ),
              ).toMatchObject({
                installedByUserId: "owner",
                grantedPermissions: [],
                status: "active",
              });
              const uninstalled = await runBackofficeCodemode({
                code: `async () => await apps.uninstall({ appId: ${JSON.stringify(appId)} })`,
                env: ctx.runtime.env.codemode,
                families: runtimeToolFamilies,
                toolContext: adminTools,
              });
              assert(!uninstalled.error, uninstalled.error ?? "Codemode failed");
              expect(uninstalled.result).toEqual({
                installationId: data.installation.id,
                changed: true,
              });
              const repeat = await bash.exec(`apps.uninstall --app-id ${appId}`);
              assert.equal(repeat.exitCode, 0, repeat.stderr);
              expect(repeat.stdout).toContain("already uninstalled");
              await expect(
                executeBackofficeRuntimeTool(
                  appTool("updateInstallationGrants"),
                  {
                    appId,
                    grantedPermissions: requestedPermissions,
                  },
                  adminTools,
                ),
              ).rejects.toThrow("installation is uninstalled");
              expect(
                await executeBackofficeRuntimeTool(
                  appTool("install"),
                  {
                    appId,
                    grantedPermissions: [BACKOFFICE_PERMISSION.events.read],
                  },
                  adminTools,
                ),
              ).toEqual({ installationId: data.installation.id, changed: true });
              expect(
                await ctx.runtime.objects.appInstallations
                  .forOrg("org-1")
                  .commands.getInstallation({ appId }),
              ).toMatchObject({
                id: data.installation.id,
                organizationId: "org-1",
                installedByUserId: "org-admin",
                grantedPermissions: [BACKOFFICE_PERMISSION.events.read],
                status: "active",
              });
              expect(await ctx.runtime.objects.apps.singleton().commands.getApp({ appId })).toEqual(
                data.app,
              );
            },
          ),
        ],
      }),
    );
  });

  test("members can inspect but cannot approve; forged attribution, ownership, and undeclared grants leave storage unchanged", async () => {
    await runAppsSqliteScenario(
      defineBackofficeScenario({
        name: "installation management establishes authority and validates caller input",
        setup: ({ given }) => [
          given.auth.user({ id: "global-admin", role: "admin" }),
          given.auth.user({ id: "owner" }),
          given.auth.user({ id: "member" }),
          given.auth.user({ id: "outsider" }),
          given.auth.organization({ id: "org-1", ownerUserId: "owner" }),
          given.auth.member({ orgId: "org-1", userId: "member", roles: ["member"] }),
        ],
        steps: ({ then }) => [
          then.assert("only authorized declarations become organization grants", async (ctx) => {
            const appId = await registerApp(ctx);
            const ownerContext = appContext(ctx, "owner");
            const ownerTools = createBackofficeToolContext(ownerContext);
            for (const execution of [
              createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
              createBackofficeServiceExecution({
                scope: { kind: "org", orgId: "org-1" },
                service: { type: "automation", id: "automation-1" },
              }),
            ]) {
              await expect(
                executeBackofficeRuntimeTool(
                  appTool("install"),
                  { appId, grantedPermissions: [] },
                  createBackofficeToolContext({ ...ownerContext, execution }),
                ),
              ).rejects.toThrow();
            }
            const memberContext = appContext(ctx, "member");
            const memberTools = createBackofficeToolContext(memberContext);
            expect(
              await executeBackofficeRuntimeTool(appTool("get"), { appId }, memberTools),
            ).toMatchObject({ id: appId, requestedPermissions });
            expect(
              await executeBackofficeRuntimeTool(
                appTool("getInstallation"),
                { appId },
                memberTools,
              ),
            ).toBeNull();
            expect(
              await executeBackofficeRuntimeTool(appTool("listInstallations"), {}, memberTools),
            ).toMatchObject({ installations: [] });
            for (const name of ["install", "updateInstallationGrants", "uninstall"]) {
              const input = name === "uninstall" ? { appId } : { appId, grantedPermissions: [] };
              await expect(
                executeBackofficeRuntimeTool(appTool(name), input, memberTools),
              ).rejects.toThrow("Required permission: apps.manage.");
            }
            for (const userId of ["outsider", "global-admin"]) {
              const tools = createBackofficeToolContext(appContext(ctx, userId));
              await expect(
                executeBackofficeRuntimeTool(appTool("get"), { appId }, tools),
              ).rejects.toThrow("Required permission: apps.read.");
              await expect(
                executeBackofficeRuntimeTool(
                  appTool("install"),
                  { appId, grantedPermissions: [] },
                  tools,
                ),
              ).rejects.toThrow("Required permission: apps.manage.");
            }
            assert(memberContext.stateBackend);
            const memberShell = createInteractiveBashHost({
              context: { ...memberContext, stateBackend: memberContext.stateBackend },
            });
            const denied = await memberShell.bash.exec(
              `apps.install --app-id ${appId} --granted-permissions-json '[]'`,
            );
            assert.notEqual(denied.exitCode, 0);
            expect(denied.stderr).toContain("Required permission: apps.manage.");
            assert(ctx.runtime.env.codemode);
            const deniedCode = await runBackofficeCodemode({
              code: `async () => await apps.install({ appId: ${JSON.stringify(appId)}, grantedPermissions: [] })`,
              env: ctx.runtime.env.codemode,
              families: runtimeToolFamilies,
              toolContext: memberTools,
            });
            expect(deniedCode.error).toContain("Required permission: apps.manage.");
            for (const forged of [
              { appId, grantedPermissions: [], installedByUserId: "outsider" },
              { appId, grantedPermissions: [], organizationId: "other-org" },
            ]) {
              await expect(
                executeBackofficeRuntimeTool(appTool("install"), forged, ownerTools),
              ).rejects.toThrow("Unrecognized key");
            }
            await expect(
              executeBackofficeRuntimeTool(
                appTool("install"),
                {
                  appId,
                  grantedPermissions: [BACKOFFICE_PERMISSION.store.modify],
                },
                ownerTools,
              ),
            ).rejects.toThrow("grants exceed the app's requested permissions");
            await expect(
              executeBackofficeRuntimeTool(
                appTool("install"),
                {
                  appId,
                  grantedPermissions: [{ namespace: "events", permission: "unknown" }],
                },
                ownerTools,
              ),
            ).rejects.toThrow("Unknown Backoffice permission");
            await expect(
              executeBackofficeRuntimeTool(
                appTool("install"),
                {
                  appId: "unknown",
                  grantedPermissions: [],
                },
                ownerTools,
              ),
            ).rejects.toThrow("app was not found");
            assert(ownerContext.stateBackend);
            const ownerShell = createInteractiveBashHost({
              context: { ...ownerContext, stateBackend: ownerContext.stateBackend },
            });
            for (const suffix of [
              "--installed-by-user-id outsider",
              "--organization-id other-org",
            ]) {
              const rejected = await ownerShell.bash.exec(
                `apps.install --app-id ${appId} --granted-permissions-json '[]' ${suffix}`,
              );
              assert.notEqual(rejected.exitCode, 0);
              expect(rejected.stderr).toContain("does not accept option");
            }
            expect(
              await ctx.runtime.objects.appInstallations
                .forOrg("org-1")
                .commands.getInstallation({ appId }),
            ).toBeNull();
            await executeBackofficeRuntimeTool(
              appTool("install"),
              { appId, grantedPermissions: [] },
              ownerTools,
            );
            await expect(
              executeBackofficeRuntimeTool(
                appTool("updateInstallationGrants"),
                {
                  appId,
                  grantedPermissions: [BACKOFFICE_PERMISSION.store.modify],
                },
                ownerTools,
              ),
            ).rejects.toThrow("grants exceed the app's requested permissions");
            expect(
              await ctx.runtime.objects.appInstallations
                .forOrg("org-1")
                .commands.getInstallation({ appId }),
            ).toMatchObject({
              organizationId: "org-1",
              installedByUserId: "owner",
              grantedPermissions: [],
              status: "active",
            });
          }),
        ],
      }),
    );
  });

  test("role changes, bans, and membership removal revoke installation authority even with a valid request snapshot", async () => {
    let context: ReturnType<typeof appContext> | null = null;
    let administratorContext: ReturnType<typeof appContext> | null = null;
    let appId = "";
    await runAppsSqliteScenario(
      defineBackofficeScenario({
        name: "installation approval uses live Auth rather than cached role snapshots",
        setup: ({ given }) => [
          given.auth.user({ id: "global-admin", role: "admin" }),
          given.auth.user({ id: "owner" }),
          given.auth.organization({ id: "org-1", ownerUserId: "owner" }),
          given.auth.member({ orgId: "org-1", userId: "global-admin", roles: ["member"] }),
        ],
        steps: ({ when, then }) => [
          then.assert(
            "an organization owner approves through verified request authority",
            async (ctx) => {
              appId = await registerApp(ctx);
              const ownerContext = appContext(ctx, "owner", { kind: "org", orgId: "org-1" }, true);
              context = ownerContext;
              await executeBackofficeRuntimeTool(
                appTool("install"),
                { appId, grantedPermissions: requestedPermissions },
                createBackofficeToolContext(ownerContext),
              );
              expect(() =>
                ownerContext.createBackofficeScopedContext({ kind: "org", orgId: "org-2" }),
              ).toThrow("Credential scope does not permit");
              administratorContext = appContext(
                ctx,
                "global-admin",
                { kind: "org", orgId: "org-1" },
                true,
              );
              expect(
                await executeBackofficeRuntimeTool(
                  appTool("updateInstallationGrants"),
                  { appId, grantedPermissions: requestedPermissions },
                  createBackofficeToolContext(administratorContext),
                ),
              ).toMatchObject({ changed: false });
            },
          ),
          when.auth.setUserRole({ userId: "global-admin", role: "user" }),
          then.assert(
            "a removed global role cannot approve through its old request snapshot",
            async () => {
              assert(administratorContext);
              await expect(
                executeBackofficeRuntimeTool(
                  appTool("uninstall"),
                  { appId },
                  createBackofficeToolContext(administratorContext),
                ),
              ).rejects.toThrow("Required permission: apps.manage.");
            },
          ),
          when.auth.setMemberRoles({ orgId: "org-1", userId: "owner", roles: ["member"] }),
          then.assert(
            "the role snapshot cannot preserve approval rights after demotion",
            async () => {
              assert(context);
              const tools = createBackofficeToolContext(context);
              await expect(
                executeBackofficeRuntimeTool(
                  appTool("updateInstallationGrants"),
                  { appId, grantedPermissions: [] },
                  tools,
                ),
              ).rejects.toThrow("Required permission: apps.manage.");
              expect(
                await executeBackofficeRuntimeTool(appTool("getInstallation"), { appId }, tools),
              ).toMatchObject({ grantedPermissions: requestedPermissions });
            },
          ),
          when.auth.setMemberRoles({ orgId: "org-1", userId: "owner", roles: ["admin"] }),
          when.auth.setUserStatus({ userId: "owner", status: "banned" }),
          then.assert("a banned administrator cannot read or revoke installations", async () => {
            assert(context);
            const tools = createBackofficeToolContext(context);
            await expect(
              executeBackofficeRuntimeTool(appTool("getInstallation"), { appId }, tools),
            ).rejects.toThrow("Required permission: apps.read.");
            await expect(
              executeBackofficeRuntimeTool(appTool("uninstall"), { appId }, tools),
            ).rejects.toThrow("Required permission: apps.manage.");
          }),
          when.auth.setUserStatus({ userId: "owner", status: "active" }),
          when.auth.removeMember({ orgId: "org-1", userId: "owner" }),
          then.assert(
            "membership removal denies access but does not delete organization-owned state",
            async (ctx) => {
              assert(context);
              await expect(
                executeBackofficeRuntimeTool(
                  appTool("listInstallations"),
                  {},
                  createBackofficeToolContext(context),
                ),
              ).rejects.toThrow("Required permission: apps.read.");
              expect(
                await ctx.runtime.objects.appInstallations
                  .forOrg("org-1")
                  .commands.getInstallation({ appId }),
              ).toMatchObject({
                status: "active",
                grantedPermissions: requestedPermissions,
                installedByUserId: "owner",
              });
            },
          ),
        ],
      }),
    );
  });

  test("installation inspection and uninstall work through the tools while the real registry database is unavailable", async () => {
    let registryAdapter: ReturnType<BackofficeDatabaseAdapterFactory["createAdapter"]> | null =
      null;
    await runAppsSqliteScenario(
      defineBackofficeScenario({
        name: "installation management keeps local revocation independent of registry availability",
        setup: ({ given }) => [
          given.auth.user({ id: "global-admin", role: "admin" }),
          given.auth.organization({ id: "org-1", ownerUserId: "global-admin" }),
        ],
        objectFactories: {
          APPS: function captureRegistryDatabase(input) {
            registryAdapter = input.runtime.adapters.createAdapter({ kind: "apps" });
            return new InMemoryAppsObject(input);
          },
        },
        steps: ({ then }) => [
          then.assert(
            "the organization can still inspect and revoke without the declaration database",
            async (ctx) => {
              const appId = await registerApp(ctx);
              const context = appContext(ctx, "global-admin");
              const tools = createBackofficeToolContext(context);
              await executeBackofficeRuntimeTool(
                appTool("install"),
                { appId, grantedPermissions: requestedPermissions },
                tools,
              );
              assert(registryAdapter);
              await registryAdapter.close();
              await expect(
                executeBackofficeRuntimeTool(appTool("get"), { appId }, tools),
              ).rejects.toThrow();
              expect(
                await executeBackofficeRuntimeTool(appTool("getInstallation"), { appId }, tools),
              ).toMatchObject({ status: "active", grantedPermissions: requestedPermissions });
              expect(
                await executeBackofficeRuntimeTool(appTool("listInstallations"), {}, tools),
              ).toMatchObject({ installations: [{ appId, status: "active" }] });
              await expect(
                executeBackofficeRuntimeTool(
                  appTool("updateInstallationGrants"),
                  { appId, grantedPermissions: [] },
                  tools,
                ),
              ).rejects.toThrow();
              await expect(
                executeBackofficeRuntimeTool(
                  appTool("install"),
                  { appId, grantedPermissions: [] },
                  tools,
                ),
              ).rejects.toThrow();
              assert(context.stateBackend);
              const { bash } = createInteractiveBashHost({
                context: { ...context, stateBackend: context.stateBackend },
              });
              const uninstalled = await bash.exec(`apps.uninstall --app-id ${appId}`);
              assert.equal(uninstalled.exitCode, 0, uninstalled.stderr);
              expect(
                await ctx.runtime.objects.appInstallations
                  .forOrg("org-1")
                  .commands.getInstallation({ appId }),
              ).toMatchObject({ status: "uninstalled", grantedPermissions: [] });
            },
          ),
        ],
      }),
    );
  });

  test("organization scope, restart-safe pagination, and cursor binding prevent cross-organization management", async () => {
    const ids: string[] = [];
    let cursor = "";
    let firstId = "";
    await runAppsSqliteScenario(
      defineBackofficeScenario<{ projectId: string }>({
        name: "installation tools remain bound to the selected organization",
        vars: () => ({ projectId: "" }),
        setup: ({ given }) => [
          given.auth.user({ id: "global-admin", role: "admin" }),
          given.auth.organization({ id: "org-1", ownerUserId: "global-admin" }),
          given.auth.organization({ id: "org-2", ownerUserId: "global-admin" }),
        ],
        steps: ({ when, then, runner }) => [
          when.project.create({
            orgId: "org-1",
            name: "Accounting",
            slug: "accounting",
            createdByUserId: "global-admin",
            captureIdAs: "projectId",
          }),
          then.assert("one app has independent approvals in two organizations", async (ctx) => {
            const tools = createBackofficeToolContext(appContext(ctx, "global-admin"));
            for (const name of ["Accounting", "Reporting", "Receipts"]) {
              const appId = await registerApp(ctx, name);
              ids.push(appId);
              await executeBackofficeRuntimeTool(
                appTool("install"),
                { appId, grantedPermissions: requestedPermissions },
                tools,
              );
            }
            const other = createBackofficeToolContext(
              appContext(ctx, "global-admin", { kind: "org", orgId: "org-2" }),
            );
            expect(
              await executeBackofficeRuntimeTool(
                appTool("getInstallation"),
                { appId: ids[0] },
                other,
              ),
            ).toBeNull();
            await executeBackofficeRuntimeTool(
              appTool("install"),
              { appId: ids[0], grantedPermissions: [] },
              other,
            );
            const page = backofficeAppInstallationPageSchema.parse(
              await executeBackofficeRuntimeTool(
                appTool("listInstallations"),
                { pageSize: 1 },
                tools,
              ),
            );
            assert(page.nextCursor);
            cursor = page.nextCursor;
            firstId = page.installations[0].id;
            expect(page.installations).toHaveLength(1);
            assert(page.hasNextPage);
            await expect(
              executeBackofficeRuntimeTool(
                appTool("listInstallations"),
                { pageSize: 1, cursor },
                other,
              ),
            ).rejects.toThrow("installation cursor is invalid");
            for (const scope of [
              { kind: "system" },
              { kind: "user", userId: "global-admin" },
              { kind: "project", orgId: "org-1", projectId: ctx.vars.projectId },
            ] satisfies BackofficeContextScope[]) {
              const context = appContext(ctx, "global-admin", scope);
              expect(context.apps).toBeNull();
              assert(context.stateBackend);
              const { bash } = createInteractiveBashHost({
                context: { ...context, stateBackend: context.stateBackend },
              });
              const unavailable = await bash.exec("apps.installations.list");
              assert.notEqual(unavailable.exitCode, 0);
              expect(unavailable.stderr).toContain("Backoffice command unavailable");
              await expect(
                ctx.runCodemode({
                  scope,
                  code: "async () => await context.current.apps.listInstallations({})",
                }),
              ).rejects.toThrow("Unknown scoped tool");
            }
          }),
          runner.restartObject({
            binding: "APP_INSTALLATIONS",
            scope: { kind: "org", orgId: "org-1" },
          }),
          then.assert(
            "cursor resumes after restart and revocation is local to one organization",
            async (ctx) => {
              const tools = createBackofficeToolContext(appContext(ctx, "global-admin"));
              const second = backofficeAppInstallationPageSchema.parse(
                await executeBackofficeRuntimeTool(
                  appTool("listInstallations"),
                  { pageSize: 1, cursor },
                  tools,
                ),
              );
              assert(second.nextCursor);
              const third = backofficeAppInstallationPageSchema.parse(
                await executeBackofficeRuntimeTool(
                  appTool("listInstallations"),
                  { pageSize: 1, cursor: second.nextCursor },
                  tools,
                ),
              );
              assert(!third.hasNextPage);
              assert.equal(
                new Set([firstId, second.installations[0].id, third.installations[0].id]).size,
                3,
              );
              expect([
                second.installations[0].organizationId,
                third.installations[0].organizationId,
              ]).toEqual(["org-1", "org-1"]);
              for (const input of [
                { pageSize: 2, cursor },
                { pageSize: 1, cursor: "invalid" },
                { pageSize: 101 },
              ]) {
                await expect(
                  executeBackofficeRuntimeTool(appTool("listInstallations"), input, tools),
                ).rejects.toThrow();
              }
              await executeBackofficeRuntimeTool(appTool("uninstall"), { appId: ids[0] }, tools);
              expect(
                await ctx.runtime.objects.appInstallations
                  .forOrg("org-1")
                  .commands.getInstallation({ appId: ids[0] }),
              ).toMatchObject({ status: "uninstalled", grantedPermissions: [] });
              expect(
                await ctx.runtime.objects.appInstallations
                  .forOrg("org-2")
                  .commands.getInstallation({ appId: ids[0] }),
              ).toMatchObject({ status: "active", grantedPermissions: [] });
            },
          ),
        ],
      }),
    );
  });
});
