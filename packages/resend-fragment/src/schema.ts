import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

export const resendSchema = schema("resend", (s) => {
  return s
    .addTable("emailThread", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("subject", column("string").nullable())
        .addColumn("normalizedSubject", column("string"))
        .addColumn("participants", column("json"))
        .addColumn("heuristicKey", column("string"))
        .addColumn("replyToken", column("string"))
        .addColumn("messageCount", column("integer").defaultTo(0))
        .addColumn("firstMessageAt", column("timestamp"))
        .addColumn("lastMessageAt", column("timestamp"))
        .addColumn("lastDirection", column("string").nullable())
        .addColumn("lastMessagePreview", column("string").nullable())
        .createIndex("idx_emailThread_lastMessageAt", ["lastMessageAt"])
        .createIndex("idx_emailThread_replyToken", ["replyToken"], { unique: true })
        .createIndex("idx_emailThread_heuristicKey", ["heuristicKey"]);
    })
    .addTable("emailMessage", (t) => {
      return (
        t
          .addColumn("id", idColumn())
          .addColumn("threadId", referenceColumn({ table: "emailThread" }).nullable())
          .addColumn("direction", column("string"))
          // status: queued | scheduled | sending | failed | sent | delivered | bounced |
          // complained | opened | clicked | received
          .addColumn("status", column("string"))
          .addColumn("providerEmailId", column("string").nullable())
          .addColumn("from", column("string").nullable())
          .addColumn("to", column("json"))
          .addColumn("cc", column("json").nullable())
          .addColumn("bcc", column("json").nullable())
          .addColumn("replyTo", column("json").nullable())
          .addColumn("subject", column("string").nullable())
          .addColumn("messageId", column("string").nullable())
          .addColumn("headers", column("json").nullable())
          .addColumn("html", column("string").nullable())
          .addColumn("text", column("string").nullable())
          .addColumn("attachments", column("json").nullable())
          .addColumn("tags", column("json").nullable())
          .addColumn("occurredAt", column("timestamp"))
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
          .createIndex("idx_emailMessage_thread_occurredAt", ["threadId", "occurredAt"])
          .createIndex("idx_emailMessage_messageId", ["messageId"])
          .createIndex("idx_emailMessage_providerEmailId", ["providerEmailId"])
          .createIndex("idx_emailMessage_direction_occurredAt", ["direction", "occurredAt"])
          .createIndex("idx_emailMessage_direction_status_occurredAt", [
            "direction",
            "status",
            "occurredAt",
          ])
      );
    })
    .noOp("removed obsolete emailMessageThread addReference history")
    .addTable("mailboxAddress", (t) => {
      return (
        t
          .addColumn("id", idColumn())
          .addColumn("address", column("string"))
          // An address keeps its row once replaced, so it is never issued to another owner.
          .addColumn("owner", column("string"))
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_mailboxAddress_address", ["address"], { unique: true })
      );
    })
    .addTable("mailbox", (t) => {
      return (
        t
          .addColumn("id", idColumn())
          .addColumn("owner", column("string"))
          .addColumn("address", column("string"))
          // A paused mailbox keeps its address but is not in use: it receives nothing.
          .addColumn("pausedAt", column("timestamp").nullable())
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_mailbox_owner", ["owner"], { unique: true })
          .createIndex("idx_mailbox_address", ["address"], { unique: true })
      );
    })
    .alterTable("emailMessage", (t) =>
      t
        // The mailboxes a received message was delivered to, as { address, owner }, one
        // per owner, each of whom may read it. An address never changes owner.
        .addColumn("recipientMailboxes", column("json").nullable()),
    );
});
