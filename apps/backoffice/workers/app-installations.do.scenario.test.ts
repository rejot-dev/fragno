import { assert, describe, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import type { BackofficeDatabaseAdapterFactory } from "@/backoffice-runtime/database-adapters";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import type { BackofficeAppOperationResult } from "@/fragno/apps/errors";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
  type BackofficeScenarioDefinition,
  type BackofficeScenarioStep,
} from "@/fragno/automation/scenario";

import { InMemoryApiObject } from "./api.do";
import { InMemoryAppInstallationsObject } from "./app-installations.do";
import { InMemoryAppsObject } from "./apps.do";
import { InMemoryAuthObject } from "./auth.do";
import { InMemoryAutomationsObject } from "./automations.do";
import { InMemoryFormsObject } from "./forms.do";
import { InMemoryTelegramObject } from "./telegram.do";
import { InMemoryUploadObject } from "./upload.do";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const wholeOrganization = { kind: "owner" } as const;

const requestedPermissions = [
  BACKOFFICE_PERMISSION.events.emit,
  BACKOFFICE_PERMISSION.integrations.execute,
];

function appOperationValue<T>(result: BackofficeAppOperationResult<T>): T {
  assert(result.ok, JSON.stringify(result));
  return result.value;
}

function appsCommandStep(
  label: string,
  run: (context: BackofficeScenarioContext) => Promise<void>,
): BackofficeScenarioStep {
  return { type: "apps.command", kind: "when", label, run };
}

async function runAppsSqliteScenario(scenario: BackofficeScenarioDefinition): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-apps-"));
  try {
    await runBackofficeScenario({
      ...scenario,
      options: { ...scenario.options, sqliteDataDirectory: directory },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("App registry and organization installation SQLite scenarios", () => {
  test("one registration has independent organization-owned installations after installer removal and object restart", async () => {
    let appId = "";
    let installationId = "";
    await runAppsSqliteScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "install one external app into two organization objects",
        setup: ({ given }) => [
          given.organization.exists({ id: "customer-one" }),
          given.organization.exists({ id: "customer-two" }),
          given.auth.user({ id: "installer" }),
          given.auth.member({ orgId: "customer-one", userId: "installer" }),
        ],
        steps: ({ when, then, runner }) => [
          appsCommandStep(
            "register a provisioned OAuth client idempotently",
            async ({ runtime }) => {
              const registry = runtime.objects.apps.singleton().commands;
              const input = {
                slug: "accounting",
                oauthClientId: "accounting-client",
                requestedPermissions,
                actions: { kind: "none" } as const,
              };
              const registered = appOperationValue(await registry.registerApp(input));
              assert(registered.created);
              appId = registered.appId;
              expect(
                appOperationValue(
                  await registry.registerApp({
                    ...input,
                    requestedPermissions: [...requestedPermissions].reverse(),
                  }),
                ),
              ).toEqual({ appId, created: false });
              expect(await registry.getApp({ appId })).toMatchObject({
                id: appId,
                slug: "accounting",
                oauthClientId: "accounting-client",
                requestedPermissions,
              });
              expect(
                await registry.registerApp({
                  ...input,
                  requestedPermissions: [
                    ...requestedPermissions,
                    BACKOFFICE_PERMISSION.upload.read,
                  ],
                }),
              ).toMatchObject({ ok: false, error: { code: "APP_REGISTRATION_CONFLICT" } });
              expect(await registry.getAppBySlug({ slug: "accounting" })).toMatchObject({
                id: appId,
              });
              expect(await registry.registerApp({ ...input, slug: "ledger" })).toEqual({
                ok: false,
                error: {
                  code: "APP_REGISTRATION_CONFLICT",
                  message:
                    "Backoffice app OAuth client is already registered as app#accounting; slugs never change.",
                },
              });
              // Another app's ID is taken too: apps registered before slugs answer to their IDs.
              for (const slug of ["accounting", appId]) {
                expect(
                  await registry.registerApp({ ...input, slug, oauthClientId: "reporting-client" }),
                ).toEqual({
                  ok: false,
                  error: {
                    code: "APP_SLUG_TAKEN",
                    message: `Backoffice app slug '${slug}' is already taken; choose another slug.`,
                  },
                });
              }
              expect(await registry.getAppBySlug({ slug: appId })).toBeNull();
            },
          ),
          appsCommandStep(
            "install independently into each customer object",
            async ({ runtime }) => {
              const first = runtime.objects.appInstallations.forOrg("customer-one").commands;
              const second = runtime.objects.appInstallations.forOrg("customer-two").commands;
              const input = {
                appId,
                actionsRevision: 1,
                installedByUserId: "installer",
                resourceScope: wholeOrganization,
                grantedPermissions: [BACKOFFICE_PERMISSION.events.emit],
              };
              const installed = appOperationValue(await first.installApp(input));
              installationId = installed.installationId;
              assert(installed.changed);
              const duplicates = await Promise.all([
                first.installApp(input),
                first.installApp(input),
              ]);
              for (const duplicate of duplicates) {
                expect(appOperationValue(duplicate)).toEqual({ installationId, changed: false });
              }
              expect(await second.getInstallation({ appId })).toBeNull();
              appOperationValue(
                await second.installApp({
                  actionsRevision: 1,
                  appId,
                  installedByUserId: "customer-two-owner",
                  resourceScope: wholeOrganization,
                  grantedPermissions: [BACKOFFICE_PERMISSION.integrations.execute],
                }),
              );
              expect(
                await first.installApp({ ...input, grantedPermissions: requestedPermissions }),
              ).toMatchObject({ ok: false, error: { code: "APP_INSTALLATION_CONFLICT" } });
              expect(await first.getInstallation({ appId })).toMatchObject({
                id: installationId,
                grantedPermissions: [BACKOFFICE_PERMISSION.events.emit],
              });
              appOperationValue(
                await first.updateInstallationAccess({
                  appId,
                  grantedPermissions: requestedPermissions,
                  resourceScope: wholeOrganization,
                }),
              );
            },
          ),
          when.auth.removeMember({ orgId: "customer-one", userId: "installer" }),
          then.auth.authority({
            userId: "installer",
            orgId: "customer-one",
            expected: { active: true, role: "user", organizationMember: false },
          }),
          runner.restartObject({ binding: "APPS", scope: { kind: "singleton" } }),
          runner.restartObject({
            binding: "APP_INSTALLATIONS",
            scope: { kind: "org", orgId: "customer-one" },
          }),
          runner.restartObject({
            binding: "APP_INSTALLATIONS",
            scope: { kind: "org", orgId: "customer-two" },
          }),
          then.assert(
            "each organization retains its own grants and revocation",
            async ({ runtime }) => {
              const first = runtime.objects.appInstallations.forOrg("customer-one").commands;
              const second = runtime.objects.appInstallations.forOrg("customer-two").commands;
              expect(await first.getInstallation({ appId })).toMatchObject({
                id: installationId,
                appId,
                owner: { kind: "org", orgId: "customer-one" },
                status: "active",
                installedByUserId: "installer",
                resourceScope: wholeOrganization,
                grantedPermissions: requestedPermissions,
              });
              expect(await second.getInstallation({ appId })).toMatchObject({
                owner: { kind: "org", orgId: "customer-two" },
                grantedPermissions: [BACKOFFICE_PERMISSION.integrations.execute],
                status: "active",
              });
              const page = appOperationValue(
                await first.listInstallations({ pageSize: 20, cursor: null }),
              );
              expect(page.installations).toHaveLength(1);
              expect(page.installations[0].appId).toBe(appId);
              expect(
                await runtime.objects.appInstallations
                  .forOrg("not-installed")
                  .commands.getInstallation({ appId }),
              ).toBeNull();
              appOperationValue(await first.uninstallApp({ appId }));
              expect(await first.getInstallation({ appId })).toMatchObject({
                status: "uninstalled",
                grantedPermissions: [],
              });
              expect(await second.getInstallation({ appId })).toMatchObject({
                status: "active",
                grantedPermissions: [BACKOFFICE_PERMISSION.integrations.execute],
              });
            },
          ),
        ],
      }),
    );
  });

  test("RPC ownership cannot be overridden and invalid grants do not mutate the installation lifecycle", async () => {
    let appId = "";
    let installationId = "";
    await runAppsSqliteScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "validate organization-scoped installation grants",
        steps: ({ then }) => [
          appsCommandStep("reject malformed registration input", async ({ runtime }) => {
            const registry = runtime.objects.apps.singleton().commands;
            await expect(
              registry.registerApp({
                actions: { kind: "none" },
                slug: "accounting",
                oauthClientId: "accounting-client",
                requestedPermissions: [
                  BACKOFFICE_PERMISSION.events.emit,
                  BACKOFFICE_PERMISSION.events.emit,
                ],
              }),
            ).rejects.toThrow("must not contain duplicates");
            const registered = appOperationValue(
              await registry.registerApp({
                actions: { kind: "none" },
                slug: "accounting",
                oauthClientId: "accounting-client",
                requestedPermissions,
              }),
            );
            assert(registered.created);
            appId = registered.appId;
            expect(await registry.getApp({ appId: "missing-app" })).toBeNull();
          }),
          appsCommandStep(
            "reject forged organization and undeclared grants",
            async ({ runtime }) => {
              const installations = runtime.objects.appInstallations.forOrg("customer").commands;
              const input = {
                appId,
                actionsRevision: 1,
                installedByUserId: "installer",
                grantedPermissions: [],
                resourceScope: wholeOrganization,
              };
              const forgedOwner = { kind: "org", orgId: "other-customer" };
              const forgedOwnership = { ...input, owner: forgedOwner };
              await expect(installations.installApp(forgedOwnership)).rejects.toThrow("owner");
              const forgedLookup = { appId, owner: forgedOwner };
              await expect(installations.getInstallation(forgedLookup)).rejects.toThrow("owner");
              expect(
                await installations.installApp({ ...input, appId: "missing-app" }),
              ).toMatchObject({
                ok: false,
                error: { code: "APP_NOT_FOUND" },
              });
              expect(
                await installations.installApp({
                  ...input,
                  grantedPermissions: [BACKOFFICE_PERMISSION.events.read],
                }),
              ).toMatchObject({ ok: false, error: { code: "APP_GRANTS_NOT_REQUESTED" } });
              expect(await installations.getInstallation({ appId })).toBeNull();
              expect(await installations.uninstallApp({ appId })).toMatchObject({
                ok: false,
                error: { code: "APP_INSTALLATION_NOT_FOUND" },
              });
              expect(
                await installations.updateInstallationAccess({
                  appId,
                  grantedPermissions: [],
                  resourceScope: wholeOrganization,
                }),
              ).toMatchObject({
                ok: false,
                error: { code: "APP_INSTALLATION_NOT_FOUND" },
              });
              installationId = appOperationValue(
                await installations.installApp({
                  ...input,
                  grantedPermissions: [BACKOFFICE_PERMISSION.events.emit],
                }),
              ).installationId;
              expect(
                await installations.updateInstallationAccess({
                  appId,
                  grantedPermissions: [BACKOFFICE_PERMISSION.events.read],
                  resourceScope: wholeOrganization,
                }),
              ).toMatchObject({ ok: false, error: { code: "APP_GRANTS_NOT_REQUESTED" } });
              expect(await installations.getInstallation({ appId })).toMatchObject({
                owner: { kind: "org", orgId: "customer" },
                grantedPermissions: [BACKOFFICE_PERMISSION.events.emit],
                status: "active",
              });
              expect(
                await runtime.objects.appInstallations
                  .forOrg("other-customer")
                  .commands.getInstallation({ appId }),
              ).toBeNull();
            },
          ),
          appsCommandStep(
            "uninstall and reinstall without restoring revoked grants",
            async ({ runtime }) => {
              const installations = runtime.objects.appInstallations.forOrg("customer").commands;
              expect(appOperationValue(await installations.uninstallApp({ appId }))).toEqual({
                installationId,
                changed: true,
              });
              expect(appOperationValue(await installations.uninstallApp({ appId }))).toEqual({
                installationId,
                changed: false,
              });
              expect(await installations.getInstallation({ appId })).toMatchObject({
                id: installationId,
                status: "uninstalled",
                grantedPermissions: [],
              });
              expect(
                await installations.updateInstallationAccess({
                  appId,
                  grantedPermissions: requestedPermissions,
                  resourceScope: wholeOrganization,
                }),
              ).toMatchObject({ ok: false, error: { code: "APP_INSTALLATION_INACTIVE" } });
              expect(
                appOperationValue(
                  await installations.listInstallations({ pageSize: 20, cursor: null }),
                ).installations,
              ).toMatchObject([{ id: installationId, status: "uninstalled" }]);
              expect(
                appOperationValue(
                  await installations.installApp({
                    actionsRevision: 1,
                    appId,
                    installedByUserId: "new-installer",
                    resourceScope: wholeOrganization,
                    grantedPermissions: [BACKOFFICE_PERMISSION.integrations.execute],
                  }),
                ),
              ).toEqual({ installationId, changed: true });
            },
          ),
          then.assert(
            "reinstall records newly approved organization authority",
            async ({ runtime }) => {
              expect(
                await runtime.objects.appInstallations
                  .forOrg("customer")
                  .commands.getInstallation({ appId }),
              ).toMatchObject({
                id: installationId,
                owner: { kind: "org", orgId: "customer" },
                status: "active",
                installedByUserId: "new-installer",
                resourceScope: wholeOrganization,
                grantedPermissions: [BACKOFFICE_PERMISSION.integrations.execute],
              });
            },
          ),
        ],
      }),
    );
  });

  test("cursors cannot cross organization objects and neither object exposes unprotected HTTP management", async () => {
    const registeredAppIds: string[] = [];
    let cursor = "";
    let firstPageIds: string[] = [];
    await runAppsSqliteScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "paginate within organization object identity",
        steps: ({ then, runner }) => [
          appsCommandStep("install three apps into the first organization", async ({ runtime }) => {
            const registry = runtime.objects.apps.singleton().commands;
            const installations = runtime.objects.appInstallations.forOrg("customer-one").commands;
            for (const oauthClientId of [
              "accounting-client",
              "reporting-client",
              "receipts-client",
            ]) {
              const { appId } = appOperationValue(
                await registry.registerApp({
                  actions: { kind: "none" },
                  slug: oauthClientId.replace(/-client$/, ""),
                  oauthClientId,
                  requestedPermissions,
                }),
              );
              registeredAppIds.push(appId);
              appOperationValue(
                await installations.installApp({
                  actionsRevision: 1,
                  appId,
                  installedByUserId: "installer",
                  resourceScope: wholeOrganization,
                  grantedPermissions: [BACKOFFICE_PERMISSION.events.emit],
                }),
              );
            }
            appOperationValue(
              await runtime.objects.appInstallations.forOrg("customer-two").commands.installApp({
                actionsRevision: 1,
                appId: registeredAppIds[0],
                installedByUserId: "other-installer",
                resourceScope: wholeOrganization,
                grantedPermissions: [BACKOFFICE_PERMISSION.integrations.execute],
              }),
            );
            const page = appOperationValue(
              await installations.listInstallations({ pageSize: 2, cursor: null }),
            );
            expect(page.installations).toHaveLength(2);
            assert(page.hasNextPage);
            assert(page.nextCursor);
            cursor = page.nextCursor;
            firstPageIds = page.installations.map((installation) => installation.appId);
          }),
          runner.restartObject({
            binding: "APP_INSTALLATIONS",
            scope: { kind: "org", orgId: "customer-one" },
          }),
          then.assert(
            "cursor identity includes organization and page size",
            async ({ runtime }) => {
              const first = runtime.objects.appInstallations.forOrg("customer-one").commands;
              const second = runtime.objects.appInstallations.forOrg("customer-two").commands;
              expect(await second.listInstallations({ pageSize: 2, cursor })).toMatchObject({
                ok: false,
                error: { code: "APP_INSTALLATION_CURSOR_INVALID" },
              });
              for (const input of [
                { pageSize: 3, cursor },
                { pageSize: 2, cursor: "invalid-cursor" },
              ]) {
                expect(await first.listInstallations(input)).toMatchObject({
                  ok: false,
                  error: { code: "APP_INSTALLATION_CURSOR_INVALID" },
                });
              }
              const nextPage = appOperationValue(
                await first.listInstallations({ pageSize: 2, cursor }),
              );
              expect(nextPage.installations).toHaveLength(1);
              assert(!nextPage.hasNextPage);
              const paginatedIds = [
                ...firstPageIds,
                ...nextPage.installations.map((installation) => installation.appId),
              ];
              expect(paginatedIds.sort()).toEqual([...registeredAppIds].sort());
              assert.equal(new Set(paginatedIds).size, 3);
              const otherPage = appOperationValue(
                await second.listInstallations({ pageSize: 2, cursor: null }),
              );
              expect(otherPage.installations).toMatchObject([
                { owner: { kind: "org", orgId: "customer-two" } },
              ]);
            },
          ),
          then.assert(
            "object scopes are enforced and management routes remain closed",
            async ({ runtime }) => {
              expect(() => runtime.objects.apps.forOrg("customer-one")).toThrow("singleton");
              expect(() => runtime.objects.appInstallations.singleton()).toThrow("org");
              for (const { object, route } of [
                { object: runtime.objects.apps.singleton(), route: "/api/apps" },
                {
                  object: runtime.objects.appInstallations.forOrg("customer-one"),
                  route: "/api/app-installations",
                },
              ]) {
                for (const method of ["GET", "POST"]) {
                  const response = await object.http.fetch(
                    new Request(`https://backoffice.test${route}`, { method }),
                  );
                  assert.equal(response.status, 404);
                }
              }
            },
          ),
        ],
      }),
    );
  });

  test("registry and independently stored organization installations survive a full runtime restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-apps-persistence-"));
    let appId = "";
    const installationIds: Record<string, string> = {};
    try {
      const options = { sqliteDataDirectory: directory };
      await runBackofficeScenario(
        defineBackofficeScenario({
          objects: scenarioObjects,
          name: "persist registration and two installations",
          options,
          steps: () => [
            appsCommandStep("register and install", async ({ runtime }) => {
              appId = appOperationValue(
                await runtime.objects.apps.singleton().commands.registerApp({
                  actions: { kind: "none" },
                  slug: "accounting",
                  oauthClientId: "accounting-client",
                  requestedPermissions,
                }),
              ).appId;
              for (const organizationId of ["customer-one", "customer-two"]) {
                installationIds[organizationId] = appOperationValue(
                  await runtime.objects.appInstallations
                    .forOrg(organizationId)
                    .commands.installApp({
                      actionsRevision: 1,
                      appId,
                      installedByUserId: "installer",
                      resourceScope: wholeOrganization,
                      grantedPermissions: requestedPermissions,
                    }),
                ).installationId;
              }
            }),
          ],
        }),
      );
      await runBackofficeScenario(
        defineBackofficeScenario({
          objects: scenarioObjects,
          name: "read all app state in a fresh runtime",
          options,
          steps: ({ then }) => [
            then.assert(
              "registry identities and organization grants remain intact",
              async ({ runtime }) => {
                const registry = runtime.objects.apps.singleton().commands;
                expect(await registry.getApp({ appId })).toMatchObject({
                  slug: "accounting",
                  oauthClientId: "accounting-client",
                  requestedPermissions,
                });
                for (const organizationId of ["customer-one", "customer-two"]) {
                  expect(
                    await runtime.objects.appInstallations
                      .forOrg(organizationId)
                      .commands.getInstallation({ appId }),
                  ).toMatchObject({
                    id: installationIds[organizationId],
                    appId,
                    owner: { kind: "org", orgId: organizationId },
                    status: "active",
                    grantedPermissions: requestedPermissions,
                  });
                }
                expect(
                  appOperationValue(
                    await registry.registerApp({
                      actions: { kind: "none" },
                      slug: "accounting",
                      oauthClientId: "accounting-client",
                      requestedPermissions,
                    }),
                  ),
                ).toEqual({ appId, created: false });
              },
            ),
          ],
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("local reads and revocation survive registry failure while approval changes fail closed", async () => {
    let appId = "";
    let installationId = "";
    let registryAdapter: ReturnType<BackofficeDatabaseAdapterFactory["createAdapter"]> | null =
      null;
    await runAppsSqliteScenario(
      defineBackofficeScenario({
        name: "resolve and revoke customer authority independently of the registry",
        objects: {
          ...scenarioObjects,
          APPS: function captureRegistryDatabase(input) {
            registryAdapter = input.runtime.adapters.createAdapter({ kind: "apps" });
            return new InMemoryAppsObject(input);
          },
        },
        steps: ({ then }) => [
          appsCommandStep("register and install before registry failure", async ({ runtime }) => {
            appId = appOperationValue(
              await runtime.objects.apps.singleton().commands.registerApp({
                actions: { kind: "none" },
                slug: "accounting",
                oauthClientId: "accounting-client",
                requestedPermissions,
              }),
            ).appId;
            installationId = appOperationValue(
              await runtime.objects.appInstallations.forOrg("customer").commands.installApp({
                actionsRevision: 1,
                appId,
                installedByUserId: "installer",
                resourceScope: wholeOrganization,
                grantedPermissions: requestedPermissions,
              }),
            ).installationId;
          }),
          then.assert(
            "failed registry cannot block local reads or revocation",
            async ({ runtime }) => {
              assert(registryAdapter);
              // Close the real registry connection; both objects still use their production behavior.
              await registryAdapter.close();
              await expect(
                runtime.objects.apps.singleton().commands.getApp({ appId }),
              ).rejects.toThrow();
              const installations = runtime.objects.appInstallations.forOrg("customer").commands;
              expect(await installations.getInstallation({ appId })).toMatchObject({
                id: installationId,
                status: "active",
                grantedPermissions: requestedPermissions,
              });
              expect(
                appOperationValue(
                  await installations.listInstallations({ pageSize: 20, cursor: null }),
                ).installations,
              ).toMatchObject([
                { id: installationId, appId, owner: { kind: "org", orgId: "customer" } },
              ]);
              await expect(
                installations.updateInstallationAccess({
                  appId,
                  grantedPermissions: [BACKOFFICE_PERMISSION.events.emit],
                  resourceScope: wholeOrganization,
                }),
              ).rejects.toThrow();
              await expect(
                installations.installApp({
                  actionsRevision: 1,
                  appId,
                  installedByUserId: "new-installer",
                  resourceScope: wholeOrganization,
                  grantedPermissions: [],
                }),
              ).rejects.toThrow();
              expect(await installations.getInstallation({ appId })).toMatchObject({
                installedByUserId: "installer",
                resourceScope: wholeOrganization,
                status: "active",
                grantedPermissions: requestedPermissions,
              });
              appOperationValue(await installations.uninstallApp({ appId }));
              expect(await installations.getInstallation({ appId })).toMatchObject({
                id: installationId,
                status: "uninstalled",
                grantedPermissions: [],
              });
            },
          ),
        ],
      }),
    );
  });
});
