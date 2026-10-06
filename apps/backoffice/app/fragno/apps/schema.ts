import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

import type { BackofficePermissionRequirement } from "@/backoffice-runtime/permissions";

/** The singleton registry owns registrations only; organization grants live in separate objects. */
export const appsFragmentSchema = schema("apps", (s) =>
  s.addTable("app", (t) =>
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
  ),
);
