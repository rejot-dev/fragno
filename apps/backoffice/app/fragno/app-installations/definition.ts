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

import { defineFragment } from "@fragno-dev/core";
import { decodeCursor, withDatabase, type HookContext, type HookFn } from "@fragno-dev/db";

import { knownBackofficePermissions } from "@/backoffice-runtime/stored-permissions";
import { BackofficeAppDomainError } from "@/fragno/apps/errors";
import { appPermissionsEqual } from "@/fragno/apps/permissions";

import type {
  AppApprovedActions,
  AppInstallationOwner,
  BackofficeAppInstallationClaimInput,
  BackofficeAppInstallationClaimResult,
  BackofficeAppInstallationInput,
  BackofficeAppInstallationStatus,
  AppInstallationTargetScope,
  StoredAppInstallation,
} from "./contracts";
import { appInstallationsFragmentSchema } from "./schema";

/** Every scope whose connection state the change may have affected, before and after it. */
export type AppInstallationChangedPayload = { appId: string; scopes: AppInstallationTargetScope[] };

type AppInstallationsHooksMap = {
  onInstallationChanged: HookFn<AppInstallationChangedPayload>;
};

/** The owner is established from the Durable Object identity. */
export type AppInstallationsConfig = {
  owner: AppInstallationOwner;
  /** Runs after commit, so the object can report the connection state the change produced. */
  onInstallationChanged: (
    payload: AppInstallationChangedPayload,
    context: HookContext,
  ) => Promise<void>;
};

/** An owner-wide installation's connection lives in the owner's scope. */
function connectionScopesOf(
  owner: AppInstallationOwner,
  resourceProjectIds: readonly (string[] | null)[],
): AppInstallationTargetScope[] {
  const scopes = new Map<string, AppInstallationTargetScope>();
  for (const projectIds of resourceProjectIds) {
    if (projectIds === null) {
      scopes.set("owner", owner);
      continue;
    }
    for (const projectId of projectIds) {
      scopes.set(`project:${projectId}`, { kind: "project", owner, projectId });
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
  if (left.kind === "owner" || right.kind === "owner") {
    return left.kind === right.kind;
  }
  // Both lists are normalized to sorted sets at the boundary.
  return (
    left.projectIds.length === right.projectIds.length &&
    left.projectIds.every((projectId, index) => projectId === right.projectIds[index])
  );
}

function toResourceProjectIds(resourceScope: AppInstallationResourceScope): string[] | null {
  return resourceScope.kind === "owner" ? null : resourceScope.projectIds;
}

function toResourceScope(resourceProjectIds: string[] | null): AppInstallationResourceScope {
  return resourceProjectIds === null
    ? { kind: "owner" }
    : { kind: "projects", projectIds: resourceProjectIds };
}

type AppInstallationRow = {
  id: { externalId: string };
  appId: string;
  grantedPermissions: BackofficePermissionRequirement[];
  resourceProjectIds: string[] | null;
  externalAccount: AppInstallationExternalAccount | null;
  installedByUserId: string;
  status: BackofficeAppInstallationStatus;
  activation: number;
  approvedActions: AppApprovedActions | null;
  grantsFollowApp: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function toBackofficeAppInstallation(
  owner: AppInstallationOwner,
  installation: AppInstallationRow,
): BackofficeAppInstallation {
  return {
    id: installation.id.externalId,
    appId: installation.appId,
    owner,
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

function toStoredAppInstallation(
  owner: AppInstallationOwner,
  installation: AppInstallationRow,
): StoredAppInstallation {
  return {
    installation: toBackofficeAppInstallation(owner, installation),
    grantsFollowApp: installation.grantsFollowApp,
  };
}

function decodeAppInstallationCursor(input: BackofficeAppInstallationPageInput, ownerId: string) {
  if (input.cursor === null) {
    return undefined;
  }
  try {
    const cursor = decodeCursor(input.cursor);
    if (
      cursor.indexName !== "idx_app_installation_ownerId_id" ||
      cursor.orderDirection !== "asc" ||
      cursor.pageSize !== input.pageSize ||
      cursor.indexValues.ownerId !== ownerId ||
      typeof cursor.indexValues.id !== "string"
    ) {
      throw new Error("Cursor does not match the owner's installation query.");
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
  .providesBaseService(({ defineService, config }) => {
    const ownerId = config.owner.kind === "org" ? config.owner.orgId : config.owner.userId;
    return defineService({
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
                      grantsFollowApp: app.trust.kind === "first-party",
                      updatedAt: uow.now(),
                    })
                    .check(),
                );
                uow.triggerHook("onInstallationChanged", {
                  appId: input.appId,
                  scopes: connectionScopesOf(config.owner, [
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
                  ownerId,
                  externalAccount: null,
                  approvedActions,
                  grantsFollowApp: app.trust.kind === "first-party",
                  status: "active",
                },
                {
                  retryOnUniqueConflict: ({ error }) =>
                    error.columns?.length === 1 && error.columns[0] === "appId",
                },
              );
              uow.triggerHook("onInstallationChanged", {
                appId: input.appId,
                scopes: connectionScopesOf(config.owner, [
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
          .transformRetrieve(([installation]): StoredAppInstallation | null =>
            installation ? toStoredAppInstallation(config.owner, installation) : null,
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
                  ...toStoredAppInstallation(config.owner, installation),
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
                scopes: connectionScopesOf(config.owner, [installation.resourceProjectIds]),
              });
              return { installationId: installation.id.externalId, changed: true };
            },
          )
          .build();
      },

      listInstallations: function (input: BackofficeAppInstallationPageInput) {
        const cursor = decodeAppInstallationCursor(input, ownerId);
        return this.serviceTx(appInstallationsFragmentSchema)
          .retrieve((uow) =>
            uow.findWithCursor("app_installation", (b) => {
              const query = b
                .whereIndex("idx_app_installation_ownerId_id", (eb) => eb("ownerId", "=", ownerId))
                .orderByIndex("idx_app_installation_ownerId_id", "asc")
                .pageSize(input.pageSize);
              return cursor ? query.after(cursor) : query;
            }),
          )
          .transformRetrieve(
            ([page]): Omit<BackofficeAppInstallationPage, "installations"> & {
              installations: StoredAppInstallation[];
            } => ({
              installations: page.items.map((installation) =>
                toStoredAppInstallation(config.owner, installation),
              ),
              nextCursor: page.cursor?.encode() ?? null,
              hasNextPage: page.hasNextPage,
            }),
          )
          .build();
      },

      updateInstallationAccess: function (
        input: BackofficeAppInstallationAccessInput,
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
              assertAppGrantsWereRequested(app.requestedPermissions, input.grantedPermissions);
              const grantsFollowApp = app.trust.kind === "first-party";
              if (
                appPermissionsEqual(installation.grantedPermissions, input.grantedPermissions) &&
                resourceScopesEqual(
                  toResourceScope(installation.resourceProjectIds),
                  input.resourceScope,
                ) &&
                installation.grantsFollowApp === grantsFollowApp
              ) {
                return { installationId: installation.id.externalId, changed: false };
              }
              uow.update("app_installation", installation.id, (b) =>
                b
                  .set({
                    grantedPermissions: input.grantedPermissions,
                    resourceProjectIds: toResourceProjectIds(input.resourceScope),
                    grantsFollowApp,
                    updatedAt: uow.now(),
                  })
                  .check(),
              );
              uow.triggerHook("onInstallationChanged", {
                appId: input.appId,
                scopes: connectionScopesOf(config.owner, [
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
            ({
              uow,
              retrieveResult: [installation],
            }): { claimed: BackofficeAppInstallationClaimResult; grantsFollowApp: boolean } => {
              if (installation?.status !== "active") {
                throw new BackofficeAppDomainError(
                  "APP_INSTALLATION_INACTIVE",
                  "Backoffice app is not installed here.",
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
                scopes: connectionScopesOf(config.owner, [installation.resourceProjectIds]),
              });
              return {
                claimed: {
                  id: installation.id.externalId,
                  appId: installation.appId,
                  owner: config.owner,
                  grantedPermissions: installation.grantedPermissions,
                  resourceScope: toResourceScope(installation.resourceProjectIds),
                  externalAccount: input.externalAccount,
                  activation: installation.activation,
                },
                grantsFollowApp: installation.grantsFollowApp,
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
                scopes: connectionScopesOf(config.owner, [installation.resourceProjectIds]),
              });
              return { installationId: installation.id.externalId, changed: true };
            },
          )
          .build();
      },
    });
  })
  .build();
