import { useCallback, useMemo, useState } from "react";

import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";

/** A page of the conversation before its active context, newest entry first (`pi.agent.history`). */
export type PiHistoryPage = { entries: readonly EntryRecord[]; cursor: string | null };

/** Reads the page before entry `before`, from `cursor` on, wherever the host's chat may read it. */
export type PiHistoryPageReader = (page: {
  before: number;
  cursor: string | null;
}) => Promise<PiHistoryPage>;

type PiEarlierHistory = {
  before: number;
  /** Newest first. */
  entries: EntryRecord[];
  /** Null once the conversation's oldest entry arrived. */
  nextPage: { cursor: string | null } | null;
};

// One shared empty history, so memos that depend on it hold while there is none.
const NO_HISTORY_ENTRIES: readonly EntryRecord[] = [];

/**
 * The conversation as the chat shows it: the view, which holds the active context a compaction or
 * clear began, after the earlier history the reader loaded, a page at a time on request.
 * `readPage` must keep its identity between renders.
 */
export function usePiEarlierHistory(view: ConversationView, readPage: PiHistoryPageReader) {
  // Pi's view leads with its newest head marker, and only head markers carry `head`.
  const activeContextStart = view.entries[0]?.head ?? null;
  const [loaded, setLoaded] = useState<PiEarlierHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A new compaction moves the active context; history loaded before it would leave a gap.
  const history = useMemo<PiEarlierHistory | null>(
    () =>
      activeContextStart === null
        ? null
        : loaded?.before === activeContextStart
          ? loaded
          : { before: activeContextStart, entries: [], nextPage: { cursor: null } },
    [activeContextStart, loaded],
  );

  const loadMore = useCallback(async () => {
    if (!history?.nextPage || loading) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const page = await readPage({ before: history.before, cursor: history.nextPage.cursor });
      setLoaded({
        before: history.before,
        entries: [...history.entries, ...page.entries],
        nextPage: page.cursor === null ? null : { cursor: page.cursor },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [history, loading, readPage]);

  const entries = history?.entries ?? NO_HISTORY_ENTRIES;
  // Keyed on the entries, which a commit that changes only documents, such as each streamed
  // partial, leaves as they were; rebuilding the transcript costs the whole conversation. The view
  // leads with its compaction marker; the transcript shows it where it happened.
  const transcript = useMemo(
    () => [...entries, ...view.entries].sort((a, b) => a.id - b.id),
    [entries, view.entries],
  );
  return {
    activeContextStart,
    transcript,
    hasMore: history?.nextPage != null,
    loading,
    error,
    loadMore,
  };
}
