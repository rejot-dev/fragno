import { defineFragment } from "@fragno-dev/core";
import { decodeCursor, withDatabase } from "@fragno-dev/db";

import type {
  BackofficeApp,
  BackofficeAppLookupInput,
  BackofficeAppOAuthClientLookupInput,
  BackofficeAppPage,
  BackofficeAppPageInput,
  BackofficeAppRegistrationInput,
  BackofficeAppRegistrationResult,
} from "./contracts";
import { BackofficeAppDomainError } from "./errors";
import { appPermissionsEqual } from "./permissions";
import { appsFragmentSchema } from "./schema";

function decodeAppRegistryCursor(input: BackofficeAppPageInput) {
  if (input.cursor === null) {
    return undefined;
  }
  try {
    const cursor = decodeCursor(input.cursor);
    if (
      // Fragno normalizes the built-in primary index name in serialized cursors.
      cursor.indexName !== "_primary" ||
      cursor.orderDirection !== "asc" ||
      cursor.pageSize !== input.pageSize ||
      typeof cursor.indexValues.id !== "string"
    ) {
      throw new Error("Cursor does not match the app registry query.");
    }
    return cursor;
  } catch {
    throw new BackofficeAppDomainError(
      "APP_CURSOR_INVALID",
      "Backoffice app registry cursor is invalid.",
    );
  }
}

/** Registration declarations are immutable, allowing installation setup across object boundaries. */
export const appsFragmentDefinition = defineFragment("apps")
  .extend(withDatabase(appsFragmentSchema))
  .providesBaseService(({ defineService }) =>
    defineService({
      registerApp: function (input: BackofficeAppRegistrationInput) {
        return this.serviceTx(appsFragmentSchema)
          .retrieve((uow) =>
            uow.findFirst("app", (b) =>
              b.whereIndex("idx_app_oauthClientId", (eb) =>
                eb("oauthClientId", "=", input.oauthClientId),
              ),
            ),
          )
          .mutate(({ uow, retrieveResult: [existing] }): BackofficeAppRegistrationResult => {
            if (existing) {
              if (!appPermissionsEqual(existing.requestedPermissions, input.requestedPermissions)) {
                throw new BackofficeAppDomainError(
                  "APP_REGISTRATION_CONFLICT",
                  "Backoffice app OAuth client is already registered with different requested permissions.",
                );
              }
              return { appId: existing.id.externalId, created: false };
            }
            uow.checkAbsent("app", "idx_app_oauthClientId", { oauthClientId: input.oauthClientId });
            const id = uow.create("app", input, {
              retryOnUniqueConflict: ({ error }) =>
                error.columns?.length === 1 && error.columns[0] === "oauthClientId",
            });
            return { appId: id.externalId, created: true };
          })
          .build();
      },

      getApp: function (input: BackofficeAppLookupInput) {
        return this.serviceTx(appsFragmentSchema)
          .retrieve((uow) =>
            uow.findFirst("app", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", input.appId)),
            ),
          )
          .transformRetrieve(([app]): BackofficeApp | null =>
            app
              ? {
                  id: app.id.externalId,
                  oauthClientId: app.oauthClientId,
                  requestedPermissions: app.requestedPermissions,
                  createdAt: app.createdAt.toISOString(),
                }
              : null,
          )
          .build();
      },

      getAppByOAuthClientId: function (input: BackofficeAppOAuthClientLookupInput) {
        return this.serviceTx(appsFragmentSchema)
          .retrieve((uow) =>
            uow.findFirst("app", (b) =>
              b.whereIndex("idx_app_oauthClientId", (eb) =>
                eb("oauthClientId", "=", input.oauthClientId),
              ),
            ),
          )
          .transformRetrieve(([app]): BackofficeApp | null =>
            app
              ? {
                  id: app.id.externalId,
                  oauthClientId: app.oauthClientId,
                  requestedPermissions: app.requestedPermissions,
                  createdAt: app.createdAt.toISOString(),
                }
              : null,
          )
          .build();
      },

      listApps: function (input: BackofficeAppPageInput) {
        const cursor = decodeAppRegistryCursor(input);
        return this.serviceTx(appsFragmentSchema)
          .retrieve((uow) =>
            uow.findWithCursor("app", (b) => {
              const query = b
                .whereIndex("primary")
                .orderByIndex("primary", "asc")
                .pageSize(input.pageSize);
              return cursor ? query.after(cursor) : query;
            }),
          )
          .transformRetrieve(
            ([page]): BackofficeAppPage => ({
              apps: page.items.map((app) => ({
                id: app.id.externalId,
                oauthClientId: app.oauthClientId,
                requestedPermissions: app.requestedPermissions,
                createdAt: app.createdAt.toISOString(),
              })),
              nextCursor: page.cursor?.encode() ?? null,
              hasNextPage: page.hasNextPage,
            }),
          )
          .build();
      },
    }),
  )
  .build();
