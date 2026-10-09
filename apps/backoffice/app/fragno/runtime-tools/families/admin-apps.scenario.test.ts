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
  createBackofficeUserExecution,
  type BackofficeContextScope,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import {
  backofficeAppPageSchema,
  backofficeAppRegistrationResultSchema,
} from "@/fragno/apps/contracts";
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

import { InMemoryApiObject } from "../../../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../../workers/forms.do";
import { InMemoryMcpObject } from "../../../../workers/mcp.do";
import { InMemoryTelegramObject } from "../../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../../workers/upload.do";
import { adminAppsRuntimeTools } from "./admin-apps";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  MCP: (input) => new InMemoryMcpObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const permissions = [BACKOFFICE_PERMISSION.events.emit];

function appAdminContext(
  ctx: BackofficeScenarioContext,
  userId: string,
  scope: BackofficeContextScope = { kind: "system" },
) {
  return createRouteBackedRuntimeContext({
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeUserExecution({ scope, userId }),
    billingOrganizationId: null,
  });
}

async function runAppAdminSqliteScenario<TVars extends Record<string, unknown>>(
  scenario: BackofficeScenarioDefinition<TVars>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-admin-apps-"));
  try {
    await runBackofficeScenario({
      ...scenario,
      options: { ...scenario.options, sqliteDataDirectory: directory },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("admin app runtime tool SQLite scenarios", () => {
  test("Bash renders empty catalogs, registration outcomes, and app metadata as text without breaking print selectors", async () => {
    await runAppAdminSqliteScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "readable Bash app management output",
        setup: ({ given }) => [given.auth.user({ id: "admin-1", role: "admin" })],
        steps: ({ then }) => [
          then.assert("text output describes real persisted registrations", async (ctx) => {
            const config = await ctx.runtime.objects.auth
              .singleton()
              .commands.getBackofficeCliOAuthConfig({ requestUrl: "https://backoffice.test" });
            const context = appAdminContext(ctx, "admin-1");
            assert(context.stateBackend);
            const { bash } = createInteractiveBashHost({
              context: { ...context, stateBackend: context.stateBackend },
            });
            const empty = await bash.exec("admin.apps.list");
            assert.equal(empty.exitCode, 0, empty.stderr);
            assert.equal(
              empty.stdout,
              "No Backoffice apps found.\nMore results: no\nNext cursor: none\n",
            );
            const command = `admin.apps.create --oauth-client-id '${config.clientId}' --requested-permissions-json '[]'`;
            const created = await bash.exec(command);
            assert.equal(created.exitCode, 0, created.stderr);
            const page = await executeBackofficeRuntimeTool(
              adminAppsRuntimeTools[1],
              {},
              createBackofficeToolContext(context),
            );
            assert.equal(page.apps.length, 1);
            const app = page.apps[0];
            assert.equal(created.stdout, `Registered Backoffice app.\nApp ID: ${app.id}\n`);
            const repeated = await bash.exec(`${command} --format text`);
            assert.equal(repeated.exitCode, 0, repeated.stderr);
            assert.equal(
              repeated.stdout,
              `Backoffice app already registered.\nApp ID: ${app.id}\n`,
            );
            const listed = await bash.exec("admin.apps.list --format text");
            assert.equal(listed.exitCode, 0, listed.stderr);
            assert.equal(
              listed.stdout,
              `Backoffice apps (1):\nApp ID: ${app.id}\n  OAuth client ID: ${config.clientId}\n  Requested permissions: none\n  Created at: ${app.createdAt}\nMore results: no\nNext cursor: none\n`,
            );
            const printed = await bash.exec(`${command} --print appId`);
            assert.equal(printed.exitCode, 0, printed.stderr);
            assert.equal(printed.stdout, `${app.id}\n`);
            const printedList = await bash.exec("admin.apps.list --print apps.0.id");
            assert.equal(printedList.exitCode, 0, printedList.stderr);
            assert.equal(printedList.stdout, `${app.id}\n`);
          }),
        ],
      }),
    );
  });
  test("an administrator creates and lists registrations through Codemode and Bash without exposing credentials", async () => {
    await runAppAdminSqliteScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "register an Auth-owned client from System admin tools",
        setup: ({ given }) => [given.auth.user({ id: "admin-1", role: "admin" })],
        steps: ({ then }) => [
          then.assert("both adapters share registration and listing semantics", async (ctx) => {
            const cliConfig = await ctx.runtime.objects.auth
              .singleton()
              .commands.getBackofficeCliOAuthConfig({ requestUrl: "https://backoffice.test" });
            const input = { oauthClientId: cliConfig.clientId, requestedPermissions: permissions };
            const context = appAdminContext(ctx, "admin-1");
            assert(context.stateBackend);
            assert(ctx.runtime.env.codemode);
            const toolContext = createBackofficeToolContext(context);
            const result = await runBackofficeCodemode({
              code: `async () => {
            const created = await admin.appsCreate(${JSON.stringify(input)});
            const page = await admin.appsList({});
            return { created, page };
          }`,
              env: ctx.runtime.env.codemode,
              families: runtimeToolFamilies,
              toolContext,
            });
            assert(!result.error, result.error ?? "Codemode failed");
            const data = z
              .strictObject({
                created: backofficeAppRegistrationResultSchema,
                page: backofficeAppPageSchema,
              })
              .parse(result.result);
            assert(data.created.created);
            expect(data.page.apps).toEqual([
              {
                id: data.created.appId,
                oauthClientId: cliConfig.clientId,
                requestedPermissions: permissions,
                createdAt: expect.any(String),
              },
            ]);
            expect(result.toolCalls.map(({ toolId }) => toolId)).toEqual([
              "admin.apps.create",
              "admin.apps.list",
            ]);
            const { bash } = createInteractiveBashHost({
              context: { ...context, stateBackend: context.stateBackend },
            });
            const repeated = await bash.exec(
              `admin.apps.create --oauth-client-id '${cliConfig.clientId}' --requested-permissions-json '${JSON.stringify(permissions)}' --format json`,
            );
            assert.equal(repeated.exitCode, 0, repeated.stderr);
            expect(
              backofficeAppRegistrationResultSchema.parse(JSON.parse(repeated.stdout)),
            ).toEqual({ appId: data.created.appId, created: false });
            const listed = await bash.exec("admin.apps.list --format json");
            assert.equal(listed.exitCode, 0, listed.stderr);
            expect(backofficeAppPageSchema.parse(JSON.parse(listed.stdout))).toEqual(data.page);
            await expect(
              executeBackofficeRuntimeTool(
                adminAppsRuntimeTools[0],
                { ...input, requestedPermissions: [] },
                toolContext,
              ),
            ).rejects.toThrow("already registered with different requested permissions");
            const page = await executeBackofficeRuntimeTool(
              adminAppsRuntimeTools[1],
              {},
              toolContext,
            );
            expect(page.apps).toEqual(data.page.apps);
            const currentConfig = await ctx.runtime.objects.auth
              .singleton()
              .commands.getBackofficeCliOAuthConfig({ requestUrl: "https://backoffice.test" });
            expect(currentConfig).toEqual(cliConfig);
          }),
        ],
      }),
    );
  });

  test("ordinary users cannot create or enumerate apps and role removal revokes a reused admin context", async () => {
    let context: ReturnType<typeof appAdminContext> | null = null;
    await runAppAdminSqliteScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "app tools check current global administrator authority",
        setup: ({ given }) => [
          given.auth.user({ id: "admin-1", role: "admin" }),
          given.auth.user({ id: "user-1" }),
        ],
        steps: ({ then, when }) => [
          then.assert("non-admin adapters cannot mutate or disclose the catalog", async (ctx) => {
            const cli = await ctx.runtime.objects.auth
              .singleton()
              .commands.getBackofficeCliOAuthConfig({ requestUrl: "https://backoffice.test" });
            context = appAdminContext(ctx, "admin-1");
            await executeBackofficeRuntimeTool(
              adminAppsRuntimeTools[0],
              { oauthClientId: cli.clientId, requestedPermissions: permissions },
              createBackofficeToolContext(context),
            );
            const userContext = appAdminContext(ctx, "user-1");
            assert(userContext.stateBackend);
            const userTools = createBackofficeToolContext(userContext);
            await expect(
              executeBackofficeRuntimeTool(
                adminAppsRuntimeTools[0],
                { oauthClientId: "not-an-oauth-client", requestedPermissions: [] },
                userTools,
              ),
            ).rejects.toThrow("Required permission: admin.apps.manage.");
            await expect(
              executeBackofficeRuntimeTool(adminAppsRuntimeTools[1], {}, userTools),
            ).rejects.toThrow("Required permission: admin.apps.read.");
            const { bash } = createInteractiveBashHost({
              context: { ...userContext, stateBackend: userContext.stateBackend },
            });
            for (const [command, permission] of [
              [
                "admin.apps.create --oauth-client-id missing --requested-permissions-json '[]'",
                "admin.apps.manage",
              ],
              ["admin.apps.list", "admin.apps.read"],
            ]) {
              const result = await bash.exec(command);
              assert.notEqual(result.exitCode, 0);
              expect(result.stderr).toContain(`Required permission: ${permission}.`);
            }
            assert(ctx.runtime.env.codemode);
            const denied = await runBackofficeCodemode({
              code: "async () => await admin.appsList({})",
              env: ctx.runtime.env.codemode,
              families: runtimeToolFamilies,
              toolContext: userTools,
            });
            expect(denied.error).toContain("Required permission: admin.apps.read.");
            const stored = await ctx.runtime.objects.apps
              .singleton()
              .commands.listApps({ pageSize: 25, cursor: null });
            assert(stored.ok);
            expect(stored.value.apps).toHaveLength(1);
          }),
          when.auth.setUserRole({ userId: "admin-1", role: "user" }),
          then.assert(
            "a previously privileged tool context does not retain administrator grants",
            async () => {
              assert(context);
              const tools = createBackofficeToolContext(context);
              await expect(
                executeBackofficeRuntimeTool(adminAppsRuntimeTools[1], {}, tools),
              ).rejects.toThrow("Required permission: admin.apps.read.");
              await expect(
                executeBackofficeRuntimeTool(
                  adminAppsRuntimeTools[0],
                  { oauthClientId: "missing", requestedPermissions: [] },
                  tools,
                ),
              ).rejects.toThrow("Required permission: admin.apps.manage.");
            },
          ),
        ],
      }),
    );
  });

  test("app tools are unavailable outside System even for administrators", async () => {
    await runAppAdminSqliteScenario(
      defineBackofficeScenario<{ projectId: string }>({
        objects: scenarioObjects,
        name: "app catalog management belongs to System context",
        vars: () => ({ projectId: "" }),
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", ownerUserId: "admin-1" }),
          given.auth.user({ id: "admin-1", role: "admin" }),
        ],
        steps: ({ when, then }) => [
          when.project.create({
            orgId: "org-1",
            name: "Accounting",
            slug: "accounting",
            createdByUserId: "admin-1",
            captureIdAs: "projectId",
          }),
          then.assert("scope selection cannot expose global app management", async (ctx) => {
            for (const scope of [
              { kind: "org", orgId: "org-1" },
              { kind: "project", orgId: "org-1", projectId: ctx.vars.projectId },
              { kind: "user", userId: "admin-1" },
            ] satisfies BackofficeContextScope[]) {
              const context = appAdminContext(ctx, "admin-1", scope);
              assert(context.stateBackend);
              const tools = createBackofficeToolContext(context);
              await expect(
                executeBackofficeRuntimeTool(
                  adminAppsRuntimeTools[0],
                  { oauthClientId: "missing", requestedPermissions: [] },
                  tools,
                ),
              ).rejects.toThrow("requires System context");
              await expect(
                executeBackofficeRuntimeTool(adminAppsRuntimeTools[1], {}, tools),
              ).rejects.toThrow("requires System context");
              const { bash } = createInteractiveBashHost({
                context: { ...context, stateBackend: context.stateBackend },
              });
              const result = await bash.exec("admin.apps.list");
              assert.notEqual(result.exitCode, 0);
              expect(result.stderr).toContain("Backoffice command unavailable");
              await expect(
                ctx.runCodemode({
                  scope,
                  code: "async () => await context.current.admin.appsList({})",
                }),
              ).rejects.toThrow("Unknown scoped tool");
            }
            const stored = await ctx.runtime.objects.apps
              .singleton()
              .commands.listApps({ pageSize: 25, cursor: null });
            assert(stored.ok);
            expect(stored.value.apps).toEqual([]);
          }),
        ],
      }),
    );
  });

  test("unknown OAuth clients and invalid permission declarations fail before registration", async () => {
    await runAppAdminSqliteScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "app creation establishes identity at the Auth boundary",
        setup: ({ given }) => [given.auth.user({ id: "admin-1", role: "admin" })],
        steps: ({ then }) => [
          then.assert(
            "malformed or unprovisioned app input leaves the registry empty",
            async (ctx) => {
              const context = appAdminContext(ctx, "admin-1");
              assert(context.stateBackend);
              const tools = createBackofficeToolContext(context);
              await expect(
                executeBackofficeRuntimeTool(
                  adminAppsRuntimeTools[0],
                  { oauthClientId: "missing", requestedPermissions: [] },
                  tools,
                ),
              ).rejects.toThrow("could not find OAuth client 'missing'");
              const cli = await ctx.runtime.objects.auth
                .singleton()
                .commands.getBackofficeCliOAuthConfig({ requestUrl: "https://backoffice.test" });
              for (const requestedPermissions of [
                [...permissions, ...permissions],
                [{ namespace: "events", permission: "invalid" }],
              ]) {
                await expect(
                  executeBackofficeRuntimeTool(
                    adminAppsRuntimeTools[0],
                    { oauthClientId: cli.clientId, requestedPermissions },
                    tools,
                  ),
                ).rejects.toThrow();
              }
              const { bash } = createInteractiveBashHost({
                context: { ...context, stateBackend: context.stateBackend },
              });
              for (const command of [
                "admin.apps.create --oauth-client-id missing --requested-permissions-json '[]'",
                "admin.apps.create --oauth-client-id missing --requested-permissions-json invalid-json",
                "admin.apps.create --oauth-client-id missing",
                "admin.apps.list --page-size 101",
              ]) {
                const result = await bash.exec(command);
                assert.notEqual(result.exitCode, 0);
              }
              const page = await executeBackofficeRuntimeTool(adminAppsRuntimeTools[1], {}, tools);
              expect(page.apps).toEqual([]);
            },
          ),
        ],
      }),
    );
  });

  test("administrator listings resume after object restart and reject cursors from other query contracts", async () => {
    let cursor = "";
    let firstId = "";
    const registeredIds: string[] = [];
    await runAppAdminSqliteScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "paginate the authoritative registration catalog",
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", ownerUserId: "admin-1" }),
          given.auth.user({ id: "admin-1", role: "admin" }),
        ],
        steps: ({ then, runner }) => [
          then.assert("list the first page of internal registration fixtures", async (ctx) => {
            const registry = ctx.runtime.objects.apps.singleton().commands;
            for (const oauthClientId of ["accounting", "reporting", "receipts"]) {
              const registered = await registry.registerApp({
                oauthClientId,
                requestedPermissions: permissions,
              });
              assert(registered.ok);
              registeredIds.push(registered.value.appId);
            }
            const page = await executeBackofficeRuntimeTool(
              adminAppsRuntimeTools[1],
              { pageSize: 1 },
              createBackofficeToolContext(appAdminContext(ctx, "admin-1")),
            );
            expect(page.apps).toHaveLength(1);
            assert(page.hasNextPage);
            assert(page.nextCursor);
            cursor = page.nextCursor;
            firstId = page.apps[0].id;
            const context = appAdminContext(ctx, "admin-1");
            assert(context.stateBackend);
            const { bash } = createInteractiveBashHost({
              context: { ...context, stateBackend: context.stateBackend },
            });
            const text = await bash.exec("admin.apps.list --page-size 1");
            assert.equal(text.exitCode, 0, text.stderr);
            expect(text.stdout).toContain(`App ID: ${firstId}\n`);
            expect(text.stdout).toContain("Requested permissions: events.emit\n");
            expect(text.stdout).toContain(`More results: yes\nNext cursor: ${cursor}\n`);
            for (const otherId of registeredIds.filter((id) => id !== firstId)) {
              expect(text.stdout).not.toContain(otherId);
            }
          }),
          runner.restartObject({ binding: "APPS", scope: { kind: "singleton" } }),
          then.assert("pagination covers each registration exactly once", async (ctx) => {
            const tools = createBackofficeToolContext(appAdminContext(ctx, "admin-1"));
            const second = await executeBackofficeRuntimeTool(
              adminAppsRuntimeTools[1],
              { pageSize: 1, cursor },
              tools,
            );
            expect(second.apps).toHaveLength(1);
            assert(second.hasNextPage);
            assert(second.nextCursor);
            const third = await executeBackofficeRuntimeTool(
              adminAppsRuntimeTools[1],
              { pageSize: 1, cursor: second.nextCursor },
              tools,
            );
            expect(third.apps).toHaveLength(1);
            assert(!third.hasNextPage);
            expect(
              [firstId, second.apps[0].id, third.apps[0].id].sort((left, right) =>
                left.localeCompare(right),
              ),
            ).toEqual([...registeredIds].sort((left, right) => left.localeCompare(right)));
            for (const input of [
              { pageSize: 2, cursor },
              { pageSize: 1, cursor: "invalid-cursor" },
            ]) {
              await expect(
                executeBackofficeRuntimeTool(adminAppsRuntimeTools[1], input, tools),
              ).rejects.toThrow("registry cursor is invalid");
            }
            const installations = ctx.runtime.objects.appInstallations.forOrg("org-1").commands;
            for (const appId of registeredIds) {
              const installed = await installations.installApp({
                appId,
                installedByUserId: "admin-1",
                grantedPermissions: [],
              });
              assert(installed.ok);
            }
            const installationPage = await installations.listInstallations({
              pageSize: 1,
              cursor: null,
            });
            assert(installationPage.ok);
            assert(installationPage.value.nextCursor);
            await expect(
              executeBackofficeRuntimeTool(
                adminAppsRuntimeTools[1],
                { pageSize: 1, cursor: installationPage.value.nextCursor },
                tools,
              ),
            ).rejects.toThrow("registry cursor is invalid");
          }),
        ],
      }),
    );
  });
});
