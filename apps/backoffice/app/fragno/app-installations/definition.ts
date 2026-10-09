import { defineFragment } from "@fragno-dev/core";
import { decodeCursor, withDatabase } from "@fragno-dev/db";

import {
  knownBackofficePermissions,
  type BackofficePermissionRequirement,
} from "@/backoffice-runtime/permissions";
import type { BackofficeAppLookupInput } from "@/fragno/apps/contracts";
import { BackofficeAppDomainError } from "@/fragno/apps/errors";
import { appPermissionsEqual } from "@/fragno/apps/permissions";

import type {
  BackofficeAppInstallation,
  BackofficeAppInstallationGrantsInput,
  BackofficeAppInstallationInput,
  BackofficeAppInstallationMutationResult,
  BackofficeAppInstallationPage,
  BackofficeAppInstallationPageInput,
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
                  !appPermissionsEqual(installation.grantedPermissions, input.grantedPermissions)
                ) {
                  throw new BackofficeAppDomainError(
                    "APP_INSTALLATION_CONFLICT",
                    "Backoffice app is already installed with different grants; update grants explicitly.",
                  );
                }
                return { installationId: installation.id.externalId, changed: false };
              }
              if (installation) {
                uow.update("app_installation", installation.id, (b) =>
                  b
                    .set({
                      grantedPermissions: input.grantedPermissions,
                      installedByUserId: input.installedByUserId,
                      status: "active",
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
                  ...input,
                  organizationId: config.organizationId,
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
            installation
              ? {
                  id: installation.id.externalId,
                  appId: installation.appId,
                  organizationId: installation.organizationId,
                  grantedPermissions: knownBackofficePermissions(installation.grantedPermissions),
                  installedByUserId: installation.installedByUserId,
                  status: installation.status,
                  createdAt: installation.createdAt.toISOString(),
                  updatedAt: installation.updatedAt.toISOString(),
                }
              : null,
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
              installations: page.items.map((installation) => ({
                id: installation.id.externalId,
                appId: installation.appId,
                organizationId: installation.organizationId,
                grantedPermissions: knownBackofficePermissions(installation.grantedPermissions),
                installedByUserId: installation.installedByUserId,
                status: installation.status,
                createdAt: installation.createdAt.toISOString(),
                updatedAt: installation.updatedAt.toISOString(),
              })),
              nextCursor: page.cursor?.encode() ?? null,
              hasNextPage: page.hasNextPage,
            }),
          )
          .build();
      },

      updateInstallationGrants: function (
        input: BackofficeAppInstallationGrantsInput,
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
              if (appPermissionsEqual(installation.grantedPermissions, input.grantedPermissions)) {
                return { installationId: installation.id.externalId, changed: false };
              }
              uow.update("app_installation", installation.id, (b) =>
                b
                  .set({
                    grantedPermissions: input.grantedPermissions,
                    updatedAt: uow.now(),
                  })
                  .check(),
              );
              return { installationId: installation.id.externalId, changed: true };
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
