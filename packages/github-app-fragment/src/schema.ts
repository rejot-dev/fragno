import { column, idColumn, referenceColumn, schema, type Column } from "@fragno-dev/db/schema";

/** GitHub sends every webhook body as a JSON object; the receive route rejects anything else. */
const webhookPayloadColumn = () =>
  column("json") as unknown as Column<"json", Record<string, unknown>, Record<string, unknown>>;

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
        .addColumn("installationId", referenceColumn({ table: "installation" }))
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
          .addColumn("repoId", referenceColumn({ table: "installation_repo" }))
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
    .noOp("removed obsolete installation_repo -> installation addReference history")
    .noOp("removed obsolete installation_repo -> repo_link join-only relation history")
    .noOp("removed obsolete repo_link -> installation_repo addReference history")
    .addTable("oauth_state", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("subjectId", column("string"))
        .addColumn("returnTo", column("string").nullable())
        .addColumn("installations", column("json").nullable())
        .addColumn("githubUserId", column("string").nullable())
        .addColumn("githubLogin", column("string").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn("expiresAt", column("timestamp"))
        .addColumn("completedAt", column("timestamp").nullable())
        .createIndex("idx_oauth_state_subject", ["subjectId"])
        .createIndex("idx_oauth_state_expires", ["expiresAt"])
        .createIndex("uniq_oauth_state", ["id"], { unique: true });
    })
    .addTable("webhook_delivery", (t) => {
      return (
        t
          // GitHub's delivery ID, so a redelivery collides with the stored delivery.
          .addColumn("id", idColumn())
          .addColumn("event", column("string"))
          .addColumn("action", column("string").nullable())
          .addColumn("installationId", column("string"))
          .addColumn("receivedAt", column("timestamp"))
          .addColumn("payload", webhookPayloadColumn())
          // Null until the delivery's hook succeeds; retention counts from here, so a delivery is
          // never deleted before it is processed.
          .addColumn("processedAt", column("timestamp").nullable())
          .createIndex("idx_webhook_delivery_processedAt", ["processedAt"])
      );
    });
});
