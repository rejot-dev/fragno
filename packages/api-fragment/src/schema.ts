import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

export const apiSchema = schema("api-fragment", (s) => {
  return s
    .addTable("api_connection", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string").nullable())
        .addColumn("baseUrl", column("string"))
        .addColumn("authMode", column("string"))
        .addColumn("status", column("string"))
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
        .addColumn("connectionId", referenceColumn({ table: "api_connection" }))
        .addColumn("kind", column("string"))
        .addColumn("payload", column("text"))
        .addColumn("expiresAt", column("timestamp").nullable())
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_secret_connection_kind", ["connectionId", "kind"], { unique: true }),
    )
    .addTable("oauthState", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("connectionId", referenceColumn({ table: "api_connection" }))
        .addColumn("codeVerifier", column("text"))
        .addColumn("redirectUri", column("string"))
        .addColumn("scope", column("string").nullable())
        .addColumn("expiresAt", column("timestamp"))
        .addColumn("consumedAt", column("timestamp").nullable())
        .createIndex("idx_oauth_state_connection", ["connectionId"]),
    );
});
