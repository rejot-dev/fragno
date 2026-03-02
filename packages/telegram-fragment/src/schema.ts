import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

export const telegramSchema = schema("telegram-fragment", (s) => {
  return s
    .addTable("user", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("username", column("string").nullable())
        .addColumn("firstName", column("string"))
        .addColumn("lastName", column("string").nullable())
        .addColumn("isBot", column("bool").defaultTo(false))
        .addColumn("languageCode", column("string").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_user_username", ["username"]);
    })
    .addTable("chat", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("type", column("string"))
        .addColumn("title", column("string").nullable())
        .addColumn("username", column("string").nullable())
        .addColumn("isForum", column("bool").defaultTo(false))
        .addColumn("commandBindings", column("json").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_chat_type", ["type"]);
    })
    .addTable("chatMember", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("chatId", referenceColumn())
        .addColumn("userId", referenceColumn())
        .addColumn("status", column("string"))
        .addColumn("joinedAt", column("timestamp").nullable())
        .addColumn("leftAt", column("timestamp").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_chat_member_chat", ["chatId"])
        .createIndex("idx_chat_member_user", ["userId"])
        .createIndex("idx_chat_member_unique", ["chatId", "userId"], {
          unique: true,
        });
    })
    .addTable("message", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("chatId", referenceColumn())
        .addColumn("fromUserId", referenceColumn().nullable())
        .addColumn("senderChatId", referenceColumn().nullable())
        .addColumn("replyToMessageId", referenceColumn().nullable())
        .addColumn("messageType", column("string"))
        .addColumn("text", column("string").nullable())
        .addColumn("payload", column("json").nullable())
        .addColumn("sentAt", column("timestamp"))
        .addColumn("editedAt", column("timestamp").nullable())
        .addColumn("commandName", column("string").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_message_chat", ["chatId"])
        .createIndex("idx_message_chat_sent", ["chatId", "sentAt"])
        .createIndex("idx_message_from", ["fromUserId"])
        .createIndex("idx_message_sent", ["sentAt"]);
    })
    .addReference("chatMemberChat", {
      type: "one",
      from: { table: "chatMember", column: "chatId" },
      to: { table: "chat", column: "id" },
    })
    .addReference("chatMemberUser", {
      type: "one",
      from: { table: "chatMember", column: "userId" },
      to: { table: "user", column: "id" },
    })
    .addReference("messageChat", {
      type: "one",
      from: { table: "message", column: "chatId" },
      to: { table: "chat", column: "id" },
    })
    .addReference("messageAuthor", {
      type: "one",
      from: { table: "message", column: "fromUserId" },
      to: { table: "user", column: "id" },
    })
    .addReference("messageSenderChat", {
      type: "one",
      from: { table: "message", column: "senderChatId" },
      to: { table: "chat", column: "id" },
    })
    .addReference("messageReplyTo", {
      type: "one",
      from: { table: "message", column: "replyToMessageId" },
      to: { table: "message", column: "id" },
    });
});
