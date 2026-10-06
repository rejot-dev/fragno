import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

import type { BackofficePermissionRequirement } from "@/backoffice-runtime/permissions";

import type { BackofficeAppInstallationStatus } from "./contracts";

/** Each organization owns its installation database; app IDs refer to the external registry. */
export const appInstallationsFragmentSchema = schema("app-installations", (s) =>
  s.addTable("app_installation", (t) =>
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
  ),
);
