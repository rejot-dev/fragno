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
        .addColumn("chatId", referenceColumn({ table: "chat" }))
        .addColumn("userId", referenceColumn({ table: "user" }))
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
        .addColumn("chatId", referenceColumn({ table: "chat" }))
        .addColumn("fromUserId", referenceColumn({ table: "user" }).nullable())
        .addColumn("senderChatId", referenceColumn({ table: "chat" }).nullable())
        .addColumn("replyToMessageId", referenceColumn({ table: "message" }).nullable())
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
    .noOp("removed obsolete chatMemberChat addReference history")
    .noOp("removed obsolete chatMemberUser addReference history")
    .noOp("removed obsolete messageChat addReference history")
    .noOp("removed obsolete messageAuthor addReference history")
    .noOp("removed obsolete messageSenderChat addReference history")
    .noOp("removed obsolete messageReplyTo addReference history");
});
