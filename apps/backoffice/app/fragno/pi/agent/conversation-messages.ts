import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PiAgentMessage, PiAgentMessagePage } from "@fragno-dev/backoffice-api/v0/pi";
import type { z } from "zod";

import {
  AssistantEntry,
  CompactionEntry,
  UserEntry,
  type Conversation,
  type Cursor,
  type EntryId,
  type EntryRecord,
} from "@earendil-works/pi-durable";

import { piCompactionSummary } from "./compaction-summary";
import { piConversationReachQuery, readPiConversationReach } from "./conversation-reach";
import type { piAgentMessagePageRequestSchema } from "./pi-agent-contract";
import { parsePiNotificationRequest } from "./pi-agent-notification-entry";

const ENTRY_SCAN_PAGE_SIZE = 64;

/** What one entry said, or null for thinking, tool calls, results, and bookkeeping. */
function entryMessage(entry: EntryRecord): PiAgentMessage | null {
  // User, assistant, and compaction entries each carry exactly one message.
  const [message] = entry.model ?? [];
  if (message?.role === "user" && (UserEntry.is(entry) || CompactionEntry.is(entry))) {
    const sentAt = new Date(message.timestamp).toISOString();
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n");
    if (CompactionEntry.is(entry)) {
      return { entryId: entry.id, role: "compaction", text: piCompactionSummary(text), sentAt };
    }
    const notifications = parsePiNotificationRequest(text);
    if (notifications) {
      return { entryId: entry.id, role: "notification", notifications, sentAt };
    }
    return text ? { entryId: entry.id, role: "user", text, sentAt } : null;
  }
  if (AssistantEntry.is(entry) && message?.role === "assistant") {
    const text = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n\n");
    return text
      ? {
          entryId: entry.id,
          role: "assistant",
          text,
          sentAt: new Date(message.timestamp).toISOString(),
        }
      : null;
  }
  return null;
}

/**
 * Scans newest-first until it holds one message more than asked for, which tells whether earlier
 * messages exist, and returns the asked-for ones oldest-first, from the newest compaction or reset
 * on, as the chat shows them.
 */
export async function listPiConversationMessages(
  root: Conversation,
  { last, before }: z.infer<typeof piAgentMessagePageRequestSchema>,
): Promise<PiAgentMessagePage> {
  const reach = await readPiConversationReach(root, { history: false });
  if (reach === null) {
    return { messages: [], before: null };
  }
  const newestFirst: PiAgentMessage[] = [];
  // Recovery can keep an aborted response that a newer one in its task repeats. The newer one is
  // scanned first, so only the repeat is skipped. A repeat whose original fell on a previous page
  // is kept.
  const said = new Set<string>();
  let cursor: Cursor | undefined;
  do {
    const page = await root.entries(
      piConversationReachQuery(reach, before as EntryId | null),
      ENTRY_SCAN_PAGE_SIZE,
      cursor,
      BACKGROUND_CONTEXT,
    );
    for (const entry of page.items) {
      const message = reach.includes(entry) ? entryMessage(entry) : null;
      if (message === null) {
        continue;
      }
      if (message.role === "assistant") {
        const key = `${entry.byTaskId ?? `entry:${entry.id}`}:${message.text}`;
        const aborted =
          entry.model?.[0]?.role === "assistant" && entry.model[0].stopReason === "aborted";
        if (aborted && said.has(key)) {
          continue;
        }
        said.add(key);
      }
      newestFirst.push(message);
      if (newestFirst.length > last) {
        break;
      }
    }
    cursor = page.next;
  } while (cursor !== undefined && newestFirst.length <= last);

  const messages = newestFirst.slice(0, last).reverse();
  return {
    messages,
    before: newestFirst.length > last ? (messages[0]?.entryId ?? null) : null,
  };
}
