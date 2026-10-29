import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import type { Conversation, EntryId, EntryQuery, EntryRecord } from "@earendil-works/pi-durable";

/**
 * The entries of a conversation a reader sees, as of one commit: a compaction or reset committed
 * later starts a context the reader does not mix into this one.
 */
type PiConversationReach = {
  /** The oldest entry to read; null reads from the conversation's start. */
  fromEntryId: EntryId | null;
  /** The newest entry when the reach was read. */
  toEntryId: EntryId;
  includes: (entry: EntryRecord) => boolean;
};

/**
 * By default the active context, as the chat shows it: from the newest compaction's first kept
 * entry, or the newest reset, on, with that compaction or reset but none it superseded. With
 * `history`, every entry. Null for a conversation without entries.
 */
export async function readPiConversationReach(
  conversation: Conversation,
  { history }: { history: boolean },
): Promise<PiConversationReach | null> {
  const { marker, newest } = await conversation.commit(
    async (tx) => ({
      marker: history ? undefined : await tx.latestHeadMarker(conversation.id),
      newest: (await tx.scanEntries({ conversationId: conversation.id }, 1)).items[0],
    }),
    BACKGROUND_CONTEXT,
  );
  if (newest === undefined) {
    return null;
  }
  if (marker === undefined) {
    return { fromEntryId: null, toEntryId: newest.id, includes: () => true };
  }
  return {
    fromEntryId: marker.head,
    toEntryId: newest.id,
    // A compaction that kept entries from before an older one replaces it.
    includes: (entry) => entry.head === undefined || entry.id === marker.id,
  };
}

/** The bounds of a scan within `reach`, up to `before` when it is set. */
export function piConversationReachQuery(
  reach: PiConversationReach,
  before: EntryId | null,
): Omit<EntryQuery, "conversationId"> {
  return {
    ...(reach.fromEntryId === null ? {} : { minEntryId: reach.fromEntryId }),
    maxEntryId:
      before === null ? reach.toEntryId : (Math.min(before - 1, reach.toEntryId) as EntryId),
  };
}
