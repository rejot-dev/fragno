import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

export const cloudflareSchema = schema("cloudflare-fragment", (s) => {
  return s
    .addTable("app", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("scriptName", column("string"))
        .addColumn("liveDeploymentId", column("string").nullable())
        .addColumn("liveCloudflareEtag", column("string").nullable())
        .addColumn("firstDeploymentLeaseId", column("string").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_app_scriptName", ["scriptName"], { unique: true });
    })
    .addTable("deployment", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("appId", referenceColumn())
        .addColumn("status", column("string"))
        .addColumn("format", column("string"))
        .addColumn("entrypoint", column("string"))
        .addColumn("scriptName", column("string"))
        .addColumn("sourceCode", column("string"))
        .addColumn("sourceByteLength", column("integer"))
        .addColumn("compatibilityDate", column("string"))
        .addColumn("compatibilityFlags", column("json"))
        .addColumn("attemptCount", column("integer").defaultTo(0))
        .addColumn("startedAt", column("timestamp").nullable())
        .addColumn("completedAt", column("timestamp").nullable())
        .addColumn("errorCode", column("string").nullable())
        .addColumn("errorMessage", column("string").nullable())
        .addColumn("cloudflareEtag", column("string").nullable())
        .addColumn("cloudflareModifiedOn", column("string").nullable())
        .addColumn("cloudflareResponse", column("json").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_deployment_app_createdAt", ["appId", "createdAt"])
        .createIndex("idx_deployment_status_createdAt", ["status", "createdAt"]);
    })
    .addReference("app", {
      type: "one",
      from: { table: "deployment", column: "appId" },
      to: { table: "app", column: "id" },
    });
});
