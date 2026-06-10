import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

export const mcpSchema = schema("mcp-fragment", (s) => {
  return s
    .addTable("server_configuration", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string").nullable())
        .addColumn("endpointUrl", column("string"))
        .addColumn("authMode", column("string"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        ),
    )
    .addTable("secret", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("serverId", referenceColumn({ table: "server_configuration" }))
        .addColumn("kind", column("string"))
        .addColumn("payload", column("text"))
        .addColumn("expiresAt", column("timestamp").nullable())
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_secret_server_kind", ["serverId", "kind"], { unique: true }),
    )
    .addTable("oauthState", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("serverId", referenceColumn({ table: "server_configuration" }))
        .addColumn("codeVerifier", column("text"))
        .addColumn("redirectUri", column("string"))
        .addColumn("scope", column("string").nullable())
        .addColumn("expiresAt", column("timestamp"))
        .addColumn("consumedAt", column("timestamp").nullable())
        .createIndex("idx_oauth_state_server", ["serverId"]),
    );
});
