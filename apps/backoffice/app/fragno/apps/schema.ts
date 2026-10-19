import type {
  AppActionsDeclaration,
  AppBranding,
  AppTrust,
} from "@fragno-dev/backoffice-api/v0/apps";
import type { BackofficeProvisioningPermission } from "@fragno-dev/backoffice-api/v0/provisioning";
import type { BackofficePermissionRequirement } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

/** The singleton registry owns registrations only; organization grants live in separate objects. */
export const appsFragmentSchema = schema("apps", (s) =>
  s
    .addTable("app", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("oauthClientId", column("string"))
        .addColumn(
          "requestedPermissions",
          column("json") as Column<
            "json",
            BackofficePermissionRequirement[],
            BackofficePermissionRequirement[]
          >,
        )
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_app_oauthClientId", ["oauthClientId"], { unique: true }),
    )
    .alterTable("app", (t) =>
      t
        // Null for apps registered before apps declared actions, which declared none.
        .addColumn(
          "actions",
          column("json").nullable() as Column<
            "json",
            AppActionsDeclaration | null,
            AppActionsDeclaration | null
          >,
        )
        // Installations approve a revision, so a changed declaration needs their approval again.
        .addColumn("actionsRevision", column("integer").defaultTo(1)),
    )
    .alterTable("app", (t) =>
      t
        // Null for apps registered before slugs; their ID serves as the slug until registration
        // names one.
        .addColumn("slug", column("string").nullable())
        .createIndex("idx_app_slug", ["slug"], { unique: true }),
    )
    .alterTable("app", (t) =>
      t
        // Apps registered before trust are third-party. Auth lists first-party apps by it.
        .addColumn(
          "trust",
          column("string").defaultTo("third-party") as Column<
            "string",
            AppTrust["kind"],
            AppTrust["kind"]
          >,
        )
        // Null unless the app is first-party.
        .addColumn(
          "provisioningPermissions",
          column("json").nullable() as Column<
            "json",
            BackofficeProvisioningPermission[] | null,
            BackofficeProvisioningPermission[] | null
          >,
        )
        .createIndex("idx_app_trust", ["trust"]),
    )
    .alterTable("app", (t) =>
      // Null unless the app is first-party.
      t.addColumn(
        "branding",
        column("json").nullable() as Column<"json", AppBranding | null, AppBranding | null>,
      ),
    ),
);
