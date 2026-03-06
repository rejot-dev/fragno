import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

export const githubAppSchema = schema("github-app-fragment", (s) => {
  return s
    .addTable("installation", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("accountId", column("string"))
        .addColumn("accountLogin", column("string"))
        .addColumn("accountType", column("string"))
        .addColumn("status", column("string"))
        .addColumn("permissions", column("json"))
        .addColumn("events", column("json"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn("lastWebhookAt", column("timestamp").nullable())
        .createIndex("idx_installation_account_login", ["accountLogin"])
        .createIndex("idx_installation_status", ["status"])
        .createIndex("uniq_installation_id", ["id"], { unique: true });
    })
    .addTable("installation_repo", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("installationId", referenceColumn())
        .addColumn("ownerLogin", column("string"))
        .addColumn("name", column("string"))
        .addColumn("fullName", column("string"))
        .addColumn("isPrivate", column("bool"))
        .addColumn("isFork", column("bool").nullable())
        .addColumn("defaultBranch", column("string").nullable())
        .addColumn("removedAt", column("timestamp").nullable())
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_installation_repo_installation", ["installationId"])
        .createIndex("idx_installation_repo_full_name", ["fullName"]);
    })
    .addTable("repo_link", (t) => {
      return (
        t
          .addColumn("id", idColumn())
          .addColumn("repoId", referenceColumn())
          // Namespaces a repo link so the same repository can be linked for multiple contexts.
          .addColumn("linkKey", column("string"))
          .addColumn(
            "linkedAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("uniq_repo_link_repo_id_link_key", ["repoId", "linkKey"], {
            unique: true,
          })
      );
    })
    .addReference("installation", {
      type: "one",
      from: { table: "installation_repo", column: "installationId" },
      to: { table: "installation", column: "id" },
    })
    .addReference("links", {
      // A repo is considered authorized for PR routes when at least one link exists.
      type: "many",
      from: { table: "installation_repo", column: "id" },
      to: { table: "repo_link", column: "repoId" },
      foreignKey: false,
    })
    .addReference("repo", {
      type: "one",
      from: { table: "repo_link", column: "repoId" },
      to: { table: "installation_repo", column: "id" },
    });
});
