import type {
  AppInstallationExternalAccount,
  AppMemberReach,
} from "@fragno-dev/backoffice-api/v0/apps";
import type { BackofficePermissionRequirement } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

import type { AppApprovedActions, BackofficeAppInstallationStatus } from "./contracts";

/** Each owner has its own installation database; app IDs refer to the external registry. */
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
        // Null approves everything the owner has, which is also what earlier installations
        // approved. A non-empty list limits the installation to those projects.
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
    )
    .alterTable("app_installation", (t) =>
      // The declaration this installation approved, so a changed one cannot widen what it calls.
      // Null approved nothing: the installation predates actions, or it was uninstalled.
      t.addColumn(
        "approvedActions",
        column("json").nullable() as Column<
          "json",
          AppApprovedActions | null,
          AppApprovedActions | null
        >,
      ),
    )
    .alterTable("app_installation", (t) =>
      // An owner is an organization or a user. The stamp is its ID; the object's identity says
      // which kind it is, so existing organization rows are already correct.
      t
        .renameColumn("organizationId", "ownerId")
        .dropIndex("idx_app_installation_organizationId_id")
        .createIndex("idx_app_installation_ownerId_id", ["ownerId", "id"]),
    )
    .alterTable("app_installation", (t) =>
      // Set when a first-party app is installed: no owner reviewed its grants, so it has what the
      // app requests now. Earlier and third-party installations have their stored grants.
      t.addColumn("grantsFollowApp", column("bool").defaultTo(false)),
    )
    // Only a person's own object holds these: that they let an app into their personal workspace
    // when it acts for them in an organization. Stopping deletes the row.
    .addTable("member_reach_consent", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("appId", column("string"))
        .addColumn("orgId", column("string"))
        // The organization's installation the person let in; a reinstall asks again.
        .addColumn("activation", column("integer"))
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_member_reach_consent_appId_orgId", ["appId", "orgId"], {
          unique: true,
        }),
    )
    .alterTable("app_installation", (t) =>
      // Whether an organization's installation reaches its members' personal workspaces, those of
      // members who let it in. A person's own installation reaches none.
      t.addColumn(
        "memberReach",
        column("string").defaultTo("none") as Column<
          "string",
          AppMemberReach["kind"],
          AppMemberReach["kind"]
        >,
      ),
    ),
);
