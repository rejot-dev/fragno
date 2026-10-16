import { isDeepStrictEqual } from "node:util";

import type {
  AppActionsDeclaration,
  BackofficeApp,
  BackofficeAppLookupInput,
} from "@fragno-dev/backoffice-api/v0/apps";
import type { BackofficePermissionRequirement } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import { defineFragment } from "@fragno-dev/core";
import { decodeCursor, withDatabase } from "@fragno-dev/db";

import { knownBackofficePermissions } from "@/backoffice-runtime/stored-permissions";

import type {
  BackofficeAppActionsUpdateInput,
  BackofficeAppActionsUpdateResult,
  BackofficeAppOAuthClientLookupInput,
  BackofficeAppPage,
  BackofficeAppPageInput,
  BackofficeAppRegistrationInput,
  BackofficeAppRegistrationResult,
  BackofficeAppSlugLookupInput,
} from "./contracts";
import { BackofficeAppDomainError } from "./errors";
import { appPermissionsEqual } from "./permissions";
import { appsFragmentSchema } from "./schema";

function toBackofficeApp(app: {
  id: { externalId: string };
  slug: string | null;
  oauthClientId: string;
  requestedPermissions: BackofficePermissionRequirement[];
  actions: AppActionsDeclaration | null;
  actionsRevision: number;
  createdAt: Date;
}): BackofficeApp {
  return {
    id: app.id.externalId,
    slug: app.slug ?? app.id.externalId,
    oauthClientId: app.oauthClientId,
    requestedPermissions: knownBackofficePermissions(app.requestedPermissions),
    actions: app.actions ?? { kind: "none" },
    actionsRevision: app.actionsRevision,
    createdAt: app.createdAt.toISOString(),
  };
}

type StoredApp = { id: { externalId: string }; slug: string | null };

/**
 * The app a slug addresses: the one registered with it, or an app registered before slugs whose ID
 * serves as its slug.
 */
function appAddressedBy<T extends StoredApp>(bySlug: T | null, byId: T | null): T | null {
  return bySlug ?? (byId?.slug === null ? byId : null);
}

function assertSlugAvailable(
  slug: string,
  holders: readonly (StoredApp | null)[],
  registering: StoredApp | null,
) {
  const holder = holders.find(
    (app) => app !== null && app.id.externalId !== registering?.id.externalId,
  );
  if (holder) {
    throw new BackofficeAppDomainError(
      "APP_SLUG_TAKEN",
      `Backoffice app slug '${slug}' is already taken; choose another slug.`,
    );
  }
}

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

/**
 * Requested permissions and slugs are immutable. Action declarations change only through
 * updateAppActions, which bumps the revision that installations approve.
 */
export const appsFragmentDefinition = defineFragment("apps")
  .extend(withDatabase(appsFragmentSchema))
  .providesBaseService(({ defineService }) =>
    defineService({
      registerApp: function (input: BackofficeAppRegistrationInput) {
        return this.serviceTx(appsFragmentSchema)
          .retrieve((uow) =>
            uow
              .findFirst("app", (b) =>
                b.whereIndex("idx_app_oauthClientId", (eb) =>
                  eb("oauthClientId", "=", input.oauthClientId),
                ),
              )
              .findFirst("app", (b) =>
                b.whereIndex("idx_app_slug", (eb) => eb("slug", "=", input.slug)),
              )
              // An app registered before slugs answers to its ID, so its ID is taken as a slug.
              .findFirst("app", (b) => b.whereIndex("primary", (eb) => eb("id", "=", input.slug))),
          )
          .mutate(
            ({
              uow,
              retrieveResult: [existing, bySlug, byId],
            }): BackofficeAppRegistrationResult => {
              if (existing) {
                if (existing.slug !== null && existing.slug !== input.slug) {
                  throw new BackofficeAppDomainError(
                    "APP_REGISTRATION_CONFLICT",
                    `Backoffice app OAuth client is already registered as app#${existing.slug}; slugs never change.`,
                  );
                }
                if (
                  !appPermissionsEqual(existing.requestedPermissions, input.requestedPermissions)
                ) {
                  throw new BackofficeAppDomainError(
                    "APP_REGISTRATION_CONFLICT",
                    "Backoffice app OAuth client is already registered with different requested permissions.",
                  );
                }
                if (!isDeepStrictEqual(existing.actions ?? { kind: "none" }, input.actions)) {
                  throw new BackofficeAppDomainError(
                    "APP_REGISTRATION_CONFLICT",
                    "Backoffice app OAuth client is already registered with different actions; change them with admin.apps.update-actions.",
                  );
                }
                if (existing.slug === null) {
                  // Naming an app registered before slugs is its one slug change.
                  assertSlugAvailable(input.slug, [bySlug, byId], existing);
                  uow.checkAbsent("app", "idx_app_slug", { slug: input.slug });
                  uow.update("app", existing.id, (b) => b.set({ slug: input.slug }).check());
                }
                return { appId: existing.id.externalId, created: false };
              }
              assertSlugAvailable(input.slug, [bySlug, byId], null);
              uow.checkAbsent("app", "idx_app_oauthClientId", {
                oauthClientId: input.oauthClientId,
              });
              uow.checkAbsent("app", "idx_app_slug", { slug: input.slug });
              const id = uow.create("app", input, {
                // A retry reads the concurrent registration and reports it.
                retryOnUniqueConflict: ({ error }) =>
                  error.columns?.length === 1 &&
                  (error.columns[0] === "oauthClientId" || error.columns[0] === "slug"),
              });
              return { appId: id.externalId, created: true };
            },
          )
          .build();
      },

      updateAppActions: function (input: BackofficeAppActionsUpdateInput) {
        return this.serviceTx(appsFragmentSchema)
          .retrieve((uow) =>
            uow.findFirst("app", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", input.appId)),
            ),
          )
          .mutate(({ uow, retrieveResult: [app] }): BackofficeAppActionsUpdateResult => {
            if (!app) {
              throw new BackofficeAppDomainError("APP_NOT_FOUND", "Backoffice app was not found.");
            }
            if (isDeepStrictEqual(app.actions ?? { kind: "none" }, input.actions)) {
              return { actionsRevision: app.actionsRevision, changed: false };
            }
            const actionsRevision = app.actionsRevision + 1;
            uow.update("app", app.id, (b) =>
              b.set({ actions: input.actions, actionsRevision }).check(),
            );
            return { actionsRevision, changed: true };
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
          .transformRetrieve(([app]): BackofficeApp | null => (app ? toBackofficeApp(app) : null))
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
          .transformRetrieve(([app]): BackofficeApp | null => (app ? toBackofficeApp(app) : null))
          .build();
      },

      getAppBySlug: function (input: BackofficeAppSlugLookupInput) {
        return this.serviceTx(appsFragmentSchema)
          .retrieve((uow) =>
            uow
              .findFirst("app", (b) =>
                b.whereIndex("idx_app_slug", (eb) => eb("slug", "=", input.slug)),
              )
              .findFirst("app", (b) => b.whereIndex("primary", (eb) => eb("id", "=", input.slug))),
          )
          .transformRetrieve(([bySlug, byId]): BackofficeApp | null => {
            const app = appAddressedBy(bySlug, byId);
            return app ? toBackofficeApp(app) : null;
          })
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
              apps: page.items.map(toBackofficeApp),
              nextCursor: page.cursor?.encode() ?? null,
              hasNextPage: page.hasNextPage,
            }),
          )
          .build();
      },
    }),
  )
  .build();
