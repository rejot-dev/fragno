import type {
  BackofficeAppLookupInput,
  AppInstallationExternalAccount,
  AppInstallationResourceScope,
  BackofficeAppInstallation,
  BackofficeAppInstallationAccessInput,
  BackofficeAppInstallationMutationResult,
  BackofficeAppInstallationPage,
  BackofficeAppInstallationPageInput,
} from "@fragno-dev/backoffice-api/v0/apps";
import type { BackofficePermissionRequirement } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import { defineFragment } from "@fragno-dev/core";
import { decodeCursor, withDatabase } from "@fragno-dev/db";

import { BackofficeAppDomainError } from "@/fragno/apps/errors";
import { appPermissionsEqual } from "@/fragno/apps/permissions";

import type {
  BackofficeAppInstallationClaimInput,
  BackofficeAppInstallationClaimResult,
  BackofficeAppInstallationInput,
  BackofficeAppInstallationStatus,
} from "./contracts";
import { appInstallationsFragmentSchema } from "./schema";

/** The owning organization is established from the Durable Object identity. */
export type AppInstallationsConfig = { organizationId: string };

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
  createdAt: Date;
  updatedAt: Date;
}): BackofficeAppInstallation {
  return {
    id: installation.id.externalId,
    appId: installation.appId,
    organizationId: installation.organizationId,
    grantedPermissions: installation.grantedPermissions,
    resourceScope: toResourceScope(installation.resourceProjectIds),
    externalAccount: installation.externalAccount,
    installedByUserId: installation.installedByUserId,
    status: installation.status,
    activation: installation.activation,
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

/** Local services receive immutable registry declarations from control-plane RPC orchestration. */
export const appInstallationsFragmentDefinition = defineFragment<AppInstallationsConfig>(
  "app-installations",
)
  .extend(withDatabase(appInstallationsFragmentSchema))
  .providesBaseService(({ defineService, config }) =>
    defineService({
      installApp: function (
        input: BackofficeAppInstallationInput,
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
              assertAppGrantsWereRequested(requestedPermissions, input.grantedPermissions);
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
                      updatedAt: uow.now(),
                    })
                    .check(),
                );
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
                  status: "active",
                },
                {
                  retryOnUniqueConflict: ({ error }) =>
                    error.columns?.length === 1 && error.columns[0] === "appId",
                },
              );
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
                    updatedAt: uow.now(),
                  })
                  .check(),
              );
              return { installationId: installation.id.externalId, changed: true };
            },
          )
          .build();
      },
    }),
  )
  .build();
