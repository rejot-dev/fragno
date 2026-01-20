import { column, idColumn, schema } from "@fragno-dev/db/schema";

export const aiSchema = schema((s) => {
  return s
    .addTable("ai_thread", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("title", column("string").nullable())
        .addColumn("defaultModelId", column("string"))
        .addColumn("defaultThinkingLevel", column("string"))
        .addColumn("systemPrompt", column("string").nullable())
        .addColumn("openaiToolConfig", column("json").nullable())
        .addColumn("metadata", column("json").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_ai_thread_updatedAt", ["updatedAt"]);
    })
    .addTable("ai_message", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("threadId", column("string"))
        .addColumn("role", column("string"))
        .addColumn("content", column("json"))
        .addColumn("text", column("string").nullable())
        .addColumn("runId", column("string").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_ai_message_thread_createdAt", ["threadId", "createdAt"]);
    })
    .addTable("ai_run", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("threadId", column("string"))
        .addColumn("type", column("string"))
        .addColumn("executionMode", column("string"))
        .addColumn("status", column("string"))
        .addColumn("modelId", column("string"))
        .addColumn("thinkingLevel", column("string"))
        .addColumn("systemPrompt", column("string").nullable())
        .addColumn("inputMessageId", column("string").nullable())
        .addColumn("openaiToolConfig", column("json").nullable())
        .addColumn("error", column("string").nullable())
        .addColumn(
          "attempt",
          column("integer").defaultTo(() => 1),
        )
        .addColumn(
          "maxAttempts",
          column("integer").defaultTo(() => 4),
        )
        .addColumn("nextAttemptAt", column("timestamp").nullable())
        .addColumn("openaiResponseId", column("string").nullable())
        .addColumn("openaiLastWebhookEventId", column("string").nullable())
        .addColumn("startedAt", column("timestamp").nullable())
        .addColumn("completedAt", column("timestamp").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_ai_run_thread_createdAt", ["threadId", "createdAt"])
        .createIndex("idx_ai_run_status_nextAttemptAt_updatedAt", [
          "status",
          "nextAttemptAt",
          "updatedAt",
        ])
        .createIndex("idx_ai_run_openaiResponseId", ["openaiResponseId"], {
          unique: true,
        });
    })
    .addTable("ai_run_event", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("runId", column("string"))
        .addColumn("seq", column("integer"))
        .addColumn("type", column("string"))
        .addColumn("payload", column("json").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_ai_run_event_run_seq", ["runId", "seq"], { unique: true });
    })
    .addTable("ai_artifact", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("runId", column("string"))
        .addColumn("threadId", column("string"))
        .addColumn("type", column("string"))
        .addColumn("title", column("string").nullable())
        .addColumn("mimeType", column("string"))
        .addColumn("data", column("json"))
        .addColumn("text", column("string").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_ai_artifact_run_createdAt", ["runId", "createdAt"])
        .createIndex("idx_ai_artifact_thread_createdAt", ["threadId", "createdAt"]);
    })
    .addTable("ai_openai_webhook_event", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("openaiEventId", column("string"))
        .addColumn("type", column("string"))
        .addColumn("responseId", column("string"))
        .addColumn("payload", column("json"))
        .addColumn(
          "receivedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn("processingAt", column("timestamp").nullable())
        .addColumn("nextAttemptAt", column("timestamp").nullable())
        .addColumn("processedAt", column("timestamp").nullable())
        .addColumn("processingError", column("string").nullable())
        .createIndex("idx_ai_openai_webhook_event_openaiEventId", ["openaiEventId"], {
          unique: true,
        })
        .createIndex("idx_ai_openai_webhook_event_processedAt", ["processedAt"]);
    });
});
