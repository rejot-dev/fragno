import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

export type PiContextUsageEstimate = {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
};

const ESTIMATED_IMAGE_CHARS = 4_800;

const contextTokensFromUsage = (usage: Usage): number =>
  usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

const validAssistantUsage = (message: AgentMessage): Usage | undefined => {
  if (message.role !== "assistant") {
    return undefined;
  }

  const assistant = message;
  if (
    assistant.stopReason === "aborted" ||
    assistant.stopReason === "error" ||
    !assistant.usage ||
    contextTokensFromUsage(assistant.usage) === 0
  ) {
    return undefined;
  }

  return assistant.usage;
};

const textAndImageContentChars = (
  content: string | Array<{ type: string; text?: string }>,
): number => {
  if (typeof content === "string") {
    return content.length;
  }

  return content.reduce((chars, block) => {
    if (block.type === "text" && block.text) {
      return chars + block.text.length;
    }
    if (block.type === "image") {
      return chars + ESTIMATED_IMAGE_CHARS;
    }
    return chars;
  }, 0);
};

const readableJsonLength = (value: unknown): number => {
  try {
    return (JSON.stringify(value) ?? "undefined").length;
  } catch {
    return "[unserializable]".length;
  }
};

/** Estimate one message using the same conservative four-characters-per-token heuristic as Pi. */
export const estimatePiMessageTokens = (message: AgentMessage): number => {
  let chars = 0;

  switch (message.role) {
    case "user":
      chars = textAndImageContentChars(message.content);
      break;
    case "assistant":
      for (const block of message.content) {
        if (block.type === "text") {
          chars += block.text.length;
        } else if (block.type === "thinking") {
          chars += block.thinking.length;
        } else if (block.type === "toolCall") {
          chars += block.name.length + readableJsonLength(block.arguments);
        }
      }
      break;
    case "custom":
    case "toolResult":
      chars = textAndImageContentChars(message.content);
      break;
    case "bashExecution":
      chars = message.command.length + message.output.length;
      break;
    case "branchSummary":
    case "compactionSummary":
      chars = message.summary.length;
      break;
  }

  return Math.ceil(chars / 4);
};

/**
 * Estimate the context represented by an ordered message list.
 *
 * Provider usage is authoritative through the latest completed assistant message. Messages after
 * that point use the same character heuristic Pi applies while preparing compaction.
 */
export const estimatePiContextUsage = (
  messages: readonly AgentMessage[],
): PiContextUsageEstimate => {
  let lastUsageIndex: number | null = null;
  let usageTokens = 0;
  let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const usage = validAssistantUsage(message);
    const timestampIsFinite = Number.isFinite(message.timestamp);
    if (usage && (!timestampIsFinite || message.timestamp >= latestPrefixTimestamp)) {
      lastUsageIndex = index;
      usageTokens = contextTokensFromUsage(usage);
    }
    if (timestampIsFinite) {
      latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
    }
  }

  const trailingStart = lastUsageIndex === null ? 0 : lastUsageIndex + 1;
  let trailingTokens = 0;
  for (let index = trailingStart; index < messages.length; index += 1) {
    trailingTokens += estimatePiMessageTokens(messages[index]);
  }

  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex,
  };
};
