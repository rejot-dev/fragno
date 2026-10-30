import {
  calculateContextTokens,
  estimateMessageTokens,
} from "@earendil-works/pi-ai/utils/estimate";

import type { ConversationView } from "@earendil-works/pi-durable";

/**
 * Estimates the next request's context size the way Pi's compaction does (`estimateContext`, spec
 * §8.3), which pi-durable does not export: the newest assistant usage measured after the head
 * marker, plus estimates of every later message. Usage recorded before a compaction is stale, so
 * a freshly compacted context is estimated from its messages alone.
 */
export function estimatePiContextTokens(entries: ConversationView["entries"]): number {
  const headMarker = entries[0]?.head === undefined ? undefined : entries[0];
  let trailingTokens = 0;
  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = entries[entryIndex];
    const messages = entry.model ?? [];
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = messages[messageIndex];
      if (
        message.role === "assistant" &&
        (headMarker === undefined || entry.id > headMarker.id) &&
        calculateContextTokens(message.usage) > 0
      ) {
        return calculateContextTokens(message.usage) + trailingTokens;
      }
      trailingTokens += estimateMessageTokens(message);
    }
  }
  return trailingTokens;
}
