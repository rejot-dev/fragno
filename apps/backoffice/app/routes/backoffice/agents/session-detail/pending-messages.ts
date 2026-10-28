import type { PiAgentQueueEntry } from "@fragno-dev/backoffice-api/v0/pi";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ConversationView, InboxState } from "@earendil-works/pi-durable";

import { parsePiAgentPrompt } from "@/fragno/pi/agent/pi-agent-attachments";

import { normalizePiContent } from "./assistant-runtime";

/**
 * Where the agent's view shows a sent message. An inbox item or entry, once a message has it,
 * stays its own, so a later message with the same text cannot take it. `gone` left the view
 * without the reader seeing it placed: withdrawn, or placed and compacted away at once.
 */
type PiSentMessageSighting =
  | { where: "nowhere" }
  | { where: "queue" }
  | { where: "inbox"; id: number }
  | { where: "entry"; id: number }
  | { where: "gone" };

/** A message the reader sent from this page, and where the agent's view shows it. */
type PiSentMessage = {
  requestId: string;
  text: string;
  /**
   * The newest entry and the inputs Pi held when it was sent. Pi keeps the request ID only on its
   * submission records, so the view shows the message as a later entry or input with its text.
   */
  sentAfter: { entryId: number; inboxIds: ReadonlySet<number> };
  seen: PiSentMessageSighting;
};

/** The reader's inputs the view holds, as Pi placed or still holds them, with their text. */
function arrivedInputs(view: ConversationView) {
  const entries: { id: number; text: string }[] = [];
  for (const entry of view.entries) {
    const [message] = entry.model ?? [];
    // Match pi-durable's `UserEntry.kind`, which the assistant runtime also mirrors.
    if (entry.kind === "pi.user" && message?.role === "user") {
      entries.push({ id: entry.id, text: promptText(message.content) });
    }
  }
  const inbox: { id: number; text: string }[] = [];
  for (const item of (view.docs["pi.inbox"] as Readonly<InboxState> | undefined)?.items ?? []) {
    if (item.mode !== "write") {
      inbox.push({ id: item.id, text: promptText(item.content) });
    }
  }
  return { entries, inbox };
}

function promptText(content: unknown) {
  const text = normalizePiContent(content)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  return parsePiAgentPrompt(text).text;
}

/**
 * Follows each sent message through the queue, Pi's inbox, and the transcript, in the order they
 * were sent. Returns `sent` itself when no message moved.
 */
function followSentMessages(
  sent: readonly PiSentMessage[],
  view: ConversationView,
  queue: readonly PiAgentQueueEntry[],
): readonly PiSentMessage[] {
  if (sent.length === 0) {
    return sent;
  }
  const queued = new Set(queue.map((entry) => entry.requestId));
  const { entries, inbox } = arrivedInputs(view);
  const takenEntries = new Set<number>();
  const takenInbox = new Set<number>();
  for (const { seen } of sent) {
    if (seen.where === "entry") {
      takenEntries.add(seen.id);
    } else if (seen.where === "inbox") {
      takenInbox.add(seen.id);
    }
  }

  function takeEntry(message: PiSentMessage): PiSentMessageSighting | null {
    const entry = entries.find(
      ({ id, text }) =>
        !takenEntries.has(id) && text === message.text && id > message.sentAfter.entryId,
    );
    if (entry === undefined) {
      return null;
    }
    takenEntries.add(entry.id);
    return { where: "entry", id: entry.id };
  }

  function takeInboxItem(message: PiSentMessage): PiSentMessageSighting | null {
    const item = inbox.find(
      ({ id, text }) =>
        !takenInbox.has(id) && text === message.text && !message.sentAfter.inboxIds.has(id),
    );
    if (item === undefined) {
      return null;
    }
    takenInbox.add(item.id);
    return { where: "inbox", id: item.id };
  }

  function nextSighting(message: PiSentMessage): PiSentMessageSighting {
    const { seen } = message;
    if (seen.where === "entry" || seen.where === "gone") {
      return seen;
    }
    if (seen.where === "inbox") {
      if (inbox.some(({ id }) => id === seen.id)) {
        return seen;
      }
      // Pi places an input as its entry in the commit that removes it from the inbox.
      return takeEntry(message) ?? { where: "gone" };
    }
    if (queued.has(message.requestId)) {
      return seen.where === "queue" ? seen : { where: "queue" };
    }
    return takeEntry(message) ?? takeInboxItem(message) ?? seen;
  }

  let moved = false;
  const followed = sent.map((message) => {
    const seen = nextSighting(message);
    if (seen === message.seen) {
      return message;
    }
    moved = true;
    return { ...message, seen };
  });
  return moved ? followed : sent;
}

/**
 * Messages shown as sent before the agent's view has them. Each remembers where the view showed
 * it, so a compaction or reset that drops it from the view cannot bring it back.
 */
export function usePiPendingMessages(view: ConversationView, queue: readonly PiAgentQueueEntry[]) {
  const [sent, setSent] = useState<readonly PiSentMessage[]>([]);
  const followed = useMemo(() => followSentMessages(sent, view, queue), [sent, view, queue]);
  useEffect(() => {
    if (followed === sent) {
      return;
    }
    const sightings = new Map(followed.map((message) => [message.requestId, message.seen]));
    setSent((current) =>
      current.map((message) => {
        const seen = sightings.get(message.requestId);
        return seen === undefined || seen === message.seen ? message : { ...message, seen };
      }),
    );
  }, [sent, followed]);
  const unseen = useMemo(
    () => followed.filter((message) => message.seen.where === "nowhere"),
    [followed],
  );

  // Sending runs from event handlers, after the view it compares against has rendered.
  const latestView = useRef(view);
  useEffect(() => {
    latestView.current = view;
  }, [view]);

  const add = useCallback((requestId: string, text: string) => {
    const { entries, docs } = latestView.current;
    const inbox = docs["pi.inbox"] as Readonly<InboxState> | undefined;
    const message: PiSentMessage = {
      requestId,
      text,
      sentAfter: {
        entryId: entries.reduce((newest, entry) => Math.max(newest, entry.id), 0),
        inboxIds: new Set((inbox?.items ?? []).map((item) => item.id)),
      },
      seen: { where: "nowhere" },
    };
    setSent((current) => [...current, message]);
  }, []);
  const withdraw = useCallback((requestId: string) => {
    setSent((current) => current.filter((message) => message.requestId !== requestId));
  }, []);

  return { messages: unseen, add, withdraw };
}
