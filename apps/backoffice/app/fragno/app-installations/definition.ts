import type {
  BackofficeApp,
  BackofficeAppLookupInput,
  AppInstallationExternalAccount,
  AppInstallationResourceScope,
  BackofficeAppInstallation,
  BackofficeAppInstallationAccessInput,
  BackofficeAppInstallationActionsApprovalInput,
  BackofficeAppInstallationMutationResult,
  BackofficeAppInstallationPage,
  BackofficeAppInstallationPageInput,
} from "@fragno-dev/backoffice-api/v0/apps";
import type { BackofficePermissionRequirement } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import { defineFragment } from "@fragno-dev/core";
import { decodeCursor, withDatabase, type HookContext, type HookFn } from "@fragno-dev/db";

import { knownBackofficePermissions } from "@/backoffice-runtime/stored-permissions";
import { BackofficeAppDomainError } from "@/fragno/apps/errors";
import { appPermissionsEqual } from "@/fragno/apps/permissions";

import type {
  AppApprovedActions,
  BackofficeAppInstallationClaimInput,
  BackofficeAppInstallationClaimResult,
  BackofficeAppInstallationInput,
  BackofficeAppInstallationStatus,
} from "./contracts";
import { appInstallationsFragmentSchema } from "./schema";

/** A scope where an installation's integration connection resolves. */
export type AppConnectionScope = Extract<BackofficeContextScope, { kind: "org" | "project" }>;

/** Every scope whose connection state the change may have affected, before and after it. */
export type AppInstallationChangedPayload = { appId: string; scopes: AppConnectionScope[] };

type AppInstallationsHooksMap = {
  onInstallationChanged: HookFn<AppInstallationChangedPayload>;
};

/** The owning organization is established from the Durable Object identity. */
export type AppInstallationsConfig = {
  organizationId: string;
  /** Runs after commit, so the object can report the connection state the change produced. */
  onInstallationChanged: (
    payload: AppInstallationChangedPayload,
    context: HookContext,
  ) => Promise<void>;
};

/** An organization-wide installation's connection lives in the organization scope. */
function connectionScopesOf(
  organizationId: string,
  resourceProjectIds: readonly (string[] | null)[],
): AppConnectionScope[] {
  const organization = { kind: "org", orgId: organizationId } as const;
  const scopes = new Map<string, AppConnectionScope>();
  for (const projectIds of resourceProjectIds) {
    if (projectIds === null) {
      scopes.set("org", organization);
      continue;
    }
    for (const projectId of projectIds) {
      scopes.set(`project:${projectId}`, { kind: "project", owner: organization, projectId });
    }
  }
  return [...scopes.values()];
}

function assertAppGrantsWereRequested(
  requestedPermissions: readonly BackofficePermissionRequirement[],
  grantedPermissions: readonly BackofficePermissionRequirement[],
): void {
  if (
    !grantedPermissions.every((grant) =>
      requestedPermissions.some(
        (requested) =>
          requested.namespace === grant.namespace && requested.permission === grant.permission,
      ),
    )
  ) {
    throw new BackofficeAppDomainError(
      "APP_GRANTS_NOT_REQUESTED",
      "Backoffice app installation grants exceed the app's requested permissions.",
    );
  }
}

/** Approval names the revision its approver reviewed; anything else was not what they approved. */
function approveCurrentActions(app: BackofficeApp, reviewedRevision: number): AppApprovedActions {
  if (reviewedRevision !== app.actionsRevision) {
    throw new BackofficeAppDomainError(
      "APP_ACTIONS_REVISION_STALE",
      `Backoffice app actions changed since revision ${reviewedRevision}; review revision ${app.actionsRevision} with apps.get.`,
    );
  }
  return { revision: app.actionsRevision, declaration: app.actions };
}

function resourceScopesEqual(
  left: AppInstallationResourceScope,
  right: AppInstallationResourceScope,
): boolean {
  if (left.kind === "organization" || right.kind === "organization") {
    return left.kind === right.kind;
  }
  // Both lists are normalized to sorted sets at the boundary.
  return (
    left.projectIds.length === right.projectIds.length &&
    left.projectIds.every((projectId, index) => projectId === right.projectIds[index])
  );
}

function toResourceProjectIds(resourceScope: AppInstallationResourceScope): string[] | null {
  return resourceScope.kind === "organization" ? null : resourceScope.projectIds;
}

function toResourceScope(resourceProjectIds: string[] | null): AppInstallationResourceScope {
  return resourceProjectIds === null
    ? { kind: "organization" }
    : { kind: "projects", projectIds: resourceProjectIds };
}

function toBackofficeAppInstallation(installation: {
  id: { externalId: string };
  appId: string;
  organizationId: string;
  grantedPermissions: BackofficePermissionRequirement[];
  resourceProjectIds: string[] | null;
  externalAccount: AppInstallationExternalAccount | null;
  installedByUserId: string;
  status: BackofficeAppInstallationStatus;
  activation: number;
  approvedActions: AppApprovedActions | null;
  createdAt: Date;
  updatedAt: Date;
}): BackofficeAppInstallation {
  return {
    id: installation.id.externalId,
    appId: installation.appId,
    organizationId: installation.organizationId,
    grantedPermissions: knownBackofficePermissions(installation.grantedPermissions),
    resourceScope: toResourceScope(installation.resourceProjectIds),
    externalAccount: installation.externalAccount,
    installedByUserId: installation.installedByUserId,
    status: installation.status,
    activation: installation.activation,
    approvedActionsRevision: installation.approvedActions?.revision ?? 0,
    createdAt: installation.createdAt.toISOString(),
    updatedAt: installation.updatedAt.toISOString(),
  };
}

function decodeAppInstallationCursor(
  input: BackofficeAppInstallationPageInput,
  organizationId: string,
) {
  if (input.cursor === null) {
    return undefined;
  }
  try {
    const cursor = decodeCursor(input.cursor);
    if (
      cursor.indexName !== "idx_app_installation_organizationId_id" ||
      cursor.orderDirection !== "asc" ||
      cursor.pageSize !== input.pageSize ||
      cursor.indexValues.organizationId !== organizationId ||
      typeof cursor.indexValues.id !== "string"
    ) {
      throw new Error("Cursor does not match the organization installation query.");
    }
    return cursor;
  } catch {
    throw new BackofficeAppDomainError(
      "APP_INSTALLATION_CURSOR_INVALID",
      "Backoffice app installation cursor is invalid.",
    );
  }
}

/** Local services receive the registry's current declarations from control-plane RPC orchestration. */
export const appInstallationsFragmentDefinition = defineFragment<AppInstallationsConfig>(
  "app-installations",
)
  .extend(withDatabase(appInstallationsFragmentSchema))
  .provideHooks<AppInstallationsHooksMap>(({ defineHook, config }) => ({
    onInstallationChanged: defineHook(async function (payload) {
      await config.onInstallationChanged(payload, this);
    }),
  }))
  .providesBaseService(({ defineService, config }) =>
    defineService({
      installApp: function (input: BackofficeAppInstallationInput, app: BackofficeApp) {
        return this.serviceTx(appInstallationsFragmentSchema)
          .retrieve((uow) =>
            uow.findFirst("app_installation", (b) =>
              b.whereIndex("idx_app_installation_appId", (eb) => eb("appId", "=", input.appId)),
            ),
          )
          .mutate(
            ({ uow, retrieveResult: [installation] }): BackofficeAppInstallationMutationResult => {
              assertAppGrantsWereRequested(app.requestedPermissions, input.grantedPermissions);
              const approvedActions = approveCurrentActions(app, input.actionsRevision);
              if (installation?.status === "active") {
                if (
                  !appPermissionsEqual(installation.grantedPermissions, input.grantedPermissions) ||
                  !resourceScopesEqual(
                    toResourceScope(installation.resourceProjectIds),
                    input.resourceScope,
                  )
                ) {
                  throw new BackofficeAppDomainError(
                    "APP_INSTALLATION_CONFLICT",
                    "Backoffice app is already installed with different access; update it explicitly.",
                  );
                }
                if ((installation.approvedActions?.revision ?? 0) !== approvedActions.revision) {
                  throw new BackofficeAppDomainError(
                    "APP_INSTALLATION_CONFLICT",
                    "Backoffice app is already installed with an earlier action declaration; approve it explicitly.",
                  );
                }
                return { installationId: installation.id.externalId, changed: false };
              }
              if (installation) {
                uow.update("app_installation", installation.id, (b) =>
                  b
                    .set({
                      grantedPermissions: input.grantedPermissions,
                      resourceProjectIds: toResourceProjectIds(input.resourceScope),
                      installedByUserId: input.installedByUserId,
                      status: "active",
                      activation: installation.activation + 1,
                      approvedActions,
                      updatedAt: uow.now(),
                    })
                    .check(),
                );
                uow.triggerHook("onInstallationChanged", {
                  appId: input.appId,
                  scopes: connectionScopesOf(config.organizationId, [
                    installation.resourceProjectIds,
                    toResourceProjectIds(input.resourceScope),
                  ]),
                });
                return { installationId: installation.id.externalId, changed: true };
              }
              uow.checkAbsent("app_installation", "idx_app_installation_appId", {
                appId: input.appId,
              });
              const id = uow.create(
                "app_installation",
                {
                  appId: input.appId,
                  grantedPermissions: input.grantedPermissions,
                  resourceProjectIds: toResourceProjectIds(input.resourceScope),
                  installedByUserId: input.installedByUserId,
                  organizationId: config.organizationId,
                  externalAccount: null,
                  approvedActions,
                  status: "active",
                },
                {
                  retryOnUniqueConflict: ({ error }) =>
                    error.columns?.length === 1 && error.columns[0] === "appId",
                },
              );
              uow.triggerHook("onInstallationChanged", {
                appId: input.appId,
                scopes: connectionScopesOf(config.organizationId, [
                  toResourceProjectIds(input.resourceScope),
                ]),
              });
              return { installationId: id.externalId, changed: true };
            },
          )
          .build();
      },

      getInstallation: function (input: BackofficeAppLookupInput) {
        return this.serviceTx(appInstallationsFragmentSchema)
          .retrieve((uow) =>
            uow.findFirst("app_installation", (b) =>
              b.whereIndex("idx_app_installation_appId", (eb) => eb("appId", "=", input.appId)),
            ),
          )
          .transformRetrieve(([installation]): BackofficeAppInstallation | null =>
            installation ? toBackofficeAppInstallation(installation) : null,
          )
          .build();
      },

      /** The installation together with the action declaration it approved. */
      getApprovedInstallation: function (input: BackofficeAppLookupInput) {
        return this.serviceTx(appInstallationsFragmentSchema)
          .retrieve((uow) =>
            uow.findFirst("app_installation", (b) =>
              b.whereIndex("idx_app_installation_appId", (eb) => eb("appId", "=", input.appId)),
            ),
          )
          .transformRetrieve(([installation]) =>
            installation
              ? {
                  installation: toBackofficeAppInstallation(installation),
                  approvedActions: installation.approvedActions,
                }
              : null,
          )
          .build();
      },

      approveActions: function (
        input: BackofficeAppInstallationActionsApprovalInput,
        app: BackofficeApp,
      ) {
        return this.serviceTx(appInstallationsFragmentSchema)
          .retrieve((uow) =>
            uow.findFirst("app_installation", (b) =>
              b.whereIndex("idx_app_installation_appId", (eb) => eb("appId", "=", input.appId)),
            ),
          )
          .mutate(
            ({ uow, retrieveResult: [installation] }): BackofficeAppInstallationMutationResult => {
              if (!installation) {
                throw new BackofficeAppDomainError(
                  "APP_INSTALLATION_NOT_FOUND",
                  "Backoffice app installation was not found.",
                );
              }
              if (installation.status !== "active") {
                throw new BackofficeAppDomainError(
                  "APP_INSTALLATION_INACTIVE",
                  "Backoffice app installation is uninstalled.",
                );
              }
              const approvedActions = approveCurrentActions(app, input.actionsRevision);
              if ((installation.approvedActions?.revision ?? 0) === approvedActions.revision) {
                return { installationId: installation.id.externalId, changed: false };
              }
              uow.update("app_installation", installation.id, (b) =>
                b.set({ approvedActions, updatedAt: uow.now() }).check(),
              );
              uow.triggerHook("onInstallationChanged", {
                appId: input.appId,
                scopes: connectionScopesOf(config.organizationId, [
                  installation.resourceProjectIds,
                ]),
              });
              return { installationId: installation.id.externalId, changed: true };
            },
          )
          .build();
      },

      listInstallations: function (input: BackofficeAppInstallationPageInput) {
        const cursor = decodeAppInstallationCursor(input, config.organizationId);
        return this.serviceTx(appInstallationsFragmentSchema)
          .retrieve((uow) =>
            uow.findWithCursor("app_installation", (b) => {
              const query = b
                .whereIndex("idx_app_installation_organizationId_id", (eb) =>
                  eb("organizationId", "=", config.organizationId),
                )
                .orderByIndex("idx_app_installation_organizationId_id", "asc")
                .pageSize(input.pageSize);
              return cursor ? query.after(cursor) : query;
            }),
          )
          .transformRetrieve(
            ([page]): BackofficeAppInstallationPage => ({
              installations: page.items.map(toBackofficeAppInstallation),
              nextCursor: page.cursor?.encode() ?? null,
              hasNextPage: page.hasNextPage,
            }),
          )
          .build();
      },

      updateInstallationAccess: function (
        input: BackofficeAppInstallationAccessInput,
        requestedPermissions: readonly BackofficePermissionRequirement[],
      ) {
        return this.serviceTx(appInstallationsFragmentSchema)
          .retrieve((uow) =>
            uow.findFirst("app_installation", (b) =>
              b.whereIndex("idx_app_installation_appId", (eb) => eb("appId", "=", input.appId)),
            ),
          )
          .mutate(
            ({ uow, retrieveResult: [installation] }): BackofficeAppInstallationMutationResult => {
              if (!installation) {
                throw new BackofficeAppDomainError(
                  "APP_INSTALLATION_NOT_FOUND",
                  "Backoffice app installation was not found.",
                );
              }
              if (installation.status !== "active") {
                throw new BackofficeAppDomainError(
                  "APP_INSTALLATION_INACTIVE",
                  "Backoffice app installation is uninstalled.",
                );
              }
              assertAppGrantsWereRequested(requestedPermissions, input.grantedPermissions);
              if (
                appPermissionsEqual(installation.grantedPermissions, input.grantedPermissions) &&
                resourceScopesEqual(
                  toResourceScope(installation.resourceProjectIds),
                  input.resourceScope,
                )
              ) {
                return { installationId: installation.id.externalId, changed: false };
              }
              uow.update("app_installation", installation.id, (b) =>
                b
                  .set({
                    grantedPermissions: input.grantedPermissions,
                    resourceProjectIds: toResourceProjectIds(input.resourceScope),
                    updatedAt: uow.now(),
                  })
                  .check(),
              );
              uow.triggerHook("onInstallationChanged", {
                appId: input.appId,
                scopes: connectionScopesOf(config.organizationId, [
                  installation.resourceProjectIds,
                  toResourceProjectIds(input.resourceScope),
                ]),
              });
              return { installationId: installation.id.externalId, changed: true };
            },
          )
          .build();
      },

      /**
       * Records the app's own tenant on one activation. Re-claiming the same tenant refreshes its
       * label; a different tenant requires uninstalling first, so a link is never silently moved.
       */
      claimInstallation: function (input: BackofficeAppInstallationClaimInput) {
        return this.serviceTx(appInstallationsFragmentSchema)
          .retrieve((uow) =>
            uow.findFirst("app_installation", (b) =>
              b.whereIndex("idx_app_installation_appId", (eb) => eb("appId", "=", input.appId)),
            ),
          )
          .mutate(
            ({ uow, retrieveResult: [installation] }): BackofficeAppInstallationClaimResult => {
              if (installation?.status !== "active") {
                throw new BackofficeAppDomainError(
                  "APP_INSTALLATION_INACTIVE",
                  "Backoffice app is not installed in this organization.",
                );
              }
              if (installation.activation !== input.activation) {
                throw new BackofficeAppDomainError(
                  "APP_INSTALLATION_ACTIVATION_STALE",
                  "Backoffice app was reinstalled since this installation was approved.",
                );
              }
              if (
                installation.externalAccount !== null &&
                installation.externalAccount.id !== input.externalAccount.id
              ) {
                throw new BackofficeAppDomainError(
                  "APP_INSTALLATION_ALREADY_CLAIMED",
                  "Backoffice app installation is already linked to another account; uninstall it first.",
                );
              }
              uow.update("app_installation", installation.id, (b) =>
                b.set({ externalAccount: input.externalAccount, updatedAt: uow.now() }).check(),
              );
              uow.triggerHook("onInstallationChanged", {
                appId: input.appId,
                scopes: connectionScopesOf(config.organizationId, [
                  installation.resourceProjectIds,
                ]),
              });
              return {
                id: installation.id.externalId,
                appId: installation.appId,
                organizationId: installation.organizationId,
                grantedPermissions: installation.grantedPermissions,
                resourceScope: toResourceScope(installation.resourceProjectIds),
                externalAccount: input.externalAccount,
                activation: installation.activation,
              };
            },
          )
          .build();
      },

      uninstallApp: function (input: BackofficeAppLookupInput) {
        return this.serviceTx(appInstallationsFragmentSchema)
          .retrieve((uow) =>
            uow.findFirst("app_installation", (b) =>
              b.whereIndex("idx_app_installation_appId", (eb) => eb("appId", "=", input.appId)),
            ),
          )
          .mutate(
            ({ uow, retrieveResult: [installation] }): BackofficeAppInstallationMutationResult => {
              if (!installation) {
                throw new BackofficeAppDomainError(
                  "APP_INSTALLATION_NOT_FOUND",
                  "Backoffice app installation was not found.",
                );
              }
              if (installation.status === "uninstalled") {
                return { installationId: installation.id.externalId, changed: false };
              }
              uow.update("app_installation", installation.id, (b) =>
                b
                  .set({
                    status: "uninstalled",
                    grantedPermissions: [],
                    externalAccount: null,
                    approvedActions: null,
                    updatedAt: uow.now(),
                  })
                  .check(),
              );
              uow.triggerHook("onInstallationChanged", {
                appId: input.appId,
                scopes: connectionScopesOf(config.organizationId, [
                  installation.resourceProjectIds,
                ]),
              });
              return { installationId: installation.id.externalId, changed: true };
            },
          )
          .build();
      },
    }),
  )
  .build();
