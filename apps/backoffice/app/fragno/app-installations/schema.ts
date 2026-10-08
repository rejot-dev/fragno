import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

import type { BackofficePermissionRequirement } from "@/backoffice-runtime/permissions";

import type { AppInstallationExternalAccount, BackofficeAppInstallationStatus } from "./contracts";

/** Each organization owns its installation database; app IDs refer to the external registry. */
export const appInstallationsFragmentSchema = schema("app-installations", (s) =>
  s
    .addTable("app_installation", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("appId", column("string"))
        // Scope-stamped ownership also binds pagination cursors to the organization.
        .addColumn("organizationId", column("string"))
        .addColumn("installedByUserId", column("string"))
        .addColumn(
          "grantedPermissions",
          column("json") as Column<
            "json",
            BackofficePermissionRequirement[],
            BackofficePermissionRequirement[]
          >,
        )
        .addColumn(
          "status",
          column("string") as Column<
            "string",
            BackofficeAppInstallationStatus,
            BackofficeAppInstallationStatus
          >,
        )
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_app_installation_appId", ["appId"], { unique: true })
        .createIndex("idx_app_installation_organizationId_id", ["organizationId", "id"]),
    )
    .alterTable("app_installation", (t) =>
      // Reinstallation reuses the installation identity. Each activation invalidates app credentials
      // and app-delegated work started under an earlier activation.
      t
        .addColumn("activation", column("integer").defaultTo(1))
        // Null approves the whole organization, which is also what earlier installations approved.
        // A non-empty list limits the installation to those projects.
        .addColumn(
          "resourceProjectIds",
          column("json").nullable() as Column<"json", string[] | null, string[] | null>,
        )
        .addColumn(
          "externalAccount",
          column("json").nullable() as Column<
            "json",
            AppInstallationExternalAccount | null,
            AppInstallationExternalAccount | null
          >,
        ),
    ),
);
