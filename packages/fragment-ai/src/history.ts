import type { AiLogger } from "./logging";
import { logWithLogger } from "./logging";
import { resolveMessageText } from "./openai";

export type AiHistoryMessage = { role: "user" | "assistant"; content: string };

export type AiHistoryCompactionResult = {
  summary: string;
  role?: "system" | "user" | "assistant";
};

export type AiHistoryCompactor = (context: {
  threadId: string;
  runId: string;
  systemPrompt: string | null;
  maxMessages: number;
  truncatedMessages: AiHistoryMessage[];
}) => AiHistoryCompactionResult | null | Promise<AiHistoryCompactionResult | null>;

type RunLike = {
  id: { toString(): string } | string;
  threadId: string;
  systemPrompt: string | null;
};

type MessageLike = {
  role: string;
  content: unknown;
  text: string | null;
};

export const buildOpenAIInput = async ({
  run,
  messages,
  maxMessages,
  compactor,
  logger,
}: {
  run: RunLike;
  messages: MessageLike[];
  maxMessages?: number | null;
  compactor?: AiHistoryCompactor;
  logger?: AiLogger;
}) => {
  const input: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];
  const conversation: AiHistoryMessage[] = [];

  if (run.systemPrompt) {
    input.push({ role: "system", content: run.systemPrompt });
  }

  for (const message of messages) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }

    const text = resolveMessageText(message);
    if (!text) {
      continue;
    }

    conversation.push({ role: message.role as "user" | "assistant", content: text });
  }

  const trimmedMessages: AiHistoryMessage[] = [];
  if (maxMessages && conversation.length > maxMessages) {
    const trimCount = conversation.length - maxMessages;
    trimmedMessages.push(...conversation.slice(0, trimCount));
    conversation.splice(0, trimCount);
  }

  if (trimmedMessages.length && compactor) {
    try {
      const result = await compactor({
        threadId: run.threadId,
        runId: String(run.id),
        systemPrompt: run.systemPrompt ?? null,
        maxMessages: maxMessages ?? conversation.length,
        truncatedMessages: trimmedMessages,
      });
      const summary = result?.summary?.trim();
      if (summary) {
        const role = result?.role;
        const resolvedRole =
          role === "user" || role === "assistant" || role === "system" ? role : "system";
        input.push({ role: resolvedRole, content: summary });
      }
    } catch (err) {
      logWithLogger(logger, "warn", {
        event: "ai.history.compaction.failed",
        runId: String(run.id),
        threadId: run.threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  input.push(...conversation);
  return input;
};
