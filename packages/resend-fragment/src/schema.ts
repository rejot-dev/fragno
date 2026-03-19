import { column, idColumn, schema } from "@fragno-dev/db/schema";

export const resendSchema = schema("resend", (s) => {
  return s
    .addTable("email", (t) => {
      return (
        t
          .addColumn("id", idColumn())
          // status: queued | scheduled | sending | failed | sent | delivered | bounced | complained | opened | clicked
          // (Resend webhook types map to "email.<status>" values.)
          .addColumn("status", column("string"))
          .addColumn("from", column("string").nullable())
          .addColumn("to", column("json"))
          .addColumn("cc", column("json").nullable())
          .addColumn("bcc", column("json").nullable())
          .addColumn("replyTo", column("json").nullable())
          .addColumn("subject", column("string").nullable())
          .addColumn("html", column("string").nullable())
          .addColumn("text", column("string").nullable())
          .addColumn("tags", column("json").nullable())
          .addColumn("headers", column("json").nullable())
          .addColumn("scheduledAt", column("timestamp").nullable())
          .addColumn("sentAt", column("timestamp").nullable())
          .addColumn("lastEventType", column("string").nullable())
          .addColumn("lastEventAt", column("timestamp").nullable())
          .addColumn("errorCode", column("string").nullable())
          .addColumn("errorMessage", column("string").nullable())
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .addColumn(
            "updatedAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_email_createdAt", ["createdAt"])
          .createIndex("idx_email_status_createdAt", ["status", "createdAt"])
          .createIndex("idx_email_status", ["status"])
      );
    })
    .addTable("receivedEmail", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("from", column("string"))
        .addColumn("to", column("json"))
        .addColumn("cc", column("json"))
        .addColumn("bcc", column("json"))
        .addColumn("subject", column("string"))
        .addColumn("messageId", column("string"))
        .addColumn("attachments", column("json"))
        .addColumn("receivedAt", column("timestamp"))
        .addColumn("webhookReceivedAt", column("timestamp"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_receivedEmail_receivedAt", ["receivedAt"])
        .createIndex("idx_receivedEmail_messageId", ["messageId"]);
    });
});
