import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

import type { ProjectConnectorConnectionState } from "./project-connector-contracts";

/** Product-user bindings and OAuth requests; upstream credentials stay in ProjectConnector. */
export const projectConnectorSchema = schema("project-connector-fragment", (s) =>
  s
    .addTable("connectionRequest", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("projectId", column("string"))
        .addColumn("providerConfigId", column("string"))
        .addColumn("externalUserId", column("string"))
        .addColumn("service", column("string"))
        .addColumn("connectionName", column("string").nullable())
        .addColumn("authorizationUrl", column("text"))
        .addColumn("expiresAt", column("string"))
        .addColumn(
          "state",
          column("json") as Column<
            "json",
            ProjectConnectorConnectionState,
            ProjectConnectorConnectionState
          >,
        ),
    )
    .addTable("connectedAccount", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("projectId", column("string"))
        .addColumn("providerConfigId", column("string"))
        .addColumn("externalUserId", column("string"))
        .addColumn("service", column("string"))
        .addColumn("connectionName", column("string").nullable())
        .createIndex("idx_account_external_user_id", ["externalUserId", "id"]),
    )
    .alterTable("connectionRequest", (t) =>
      t.createIndex("idx_request_named_connection", [
        "externalUserId",
        "projectId",
        "providerConfigId",
        "connectionName",
      ]),
    )
    .alterTable("connectedAccount", (t) =>
      t.createIndex("idx_account_named_connection", [
        "externalUserId",
        "projectId",
        "providerConfigId",
        "connectionName",
      ]),
    ),
);
