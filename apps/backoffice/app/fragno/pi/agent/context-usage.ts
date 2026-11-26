import {
  calculateContextTokens,
  estimateMessageTokens,
} from "@earendil-works/pi-ai/utils/estimate";

import type { ConversationView } from "@earendil-works/pi-durable";

/**
 * Estimates the next request's context size the way Pi's compaction does (`estimateContext`, spec
 * §8.3), which pi-durable does not export: the newest assistant usage measured after the head
 * marker, plus estimates of every later message. Usage recorded before a compaction is stale, so
 * a freshly compacted context is estimated from its messages alone. `entries` is an active context,
 * which leads with its head marker, or a view's window, which holds markers where they were written.
 */
export function estimatePiContextTokens(entries: ConversationView["entries"]): number {
  let headMarker: ConversationView["entries"][number] | undefined;
  for (let index = entries.length - 1; index >= 0 && headMarker === undefined; index -= 1) {
    if (entries[index].head !== undefined) {
      headMarker = entries[index];
    }
  }
  let trailingTokens = 0;
  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = entries[entryIndex];
    // The marker's summary stands in for the entries before its head.
    if (headMarker?.head !== undefined && entry !== headMarker && entry.id < headMarker.head) {
      continue;
    }
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
