import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PiAgentEntryRange } from "@fragno-dev/backoffice-api/v0/pi";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ConversationTranscript,
  type ConversationView,
  type EntryRecord,
  type TranscriptItem,
  type TranscriptView,
} from "@earendil-works/pi-durable";

/** A page of the conversation's entries, in the order asked for (`pi.agent.history`). */
export type PiEntryPage = { entries: readonly EntryRecord[]; more: boolean };

/** Reads a page of entries in an ID range, wherever the host's chat may read them. */
export type PiEntryPageReader = (range: PiAgentEntryRange) => Promise<PiEntryPage>;

const PAGE_SIZE = 100;

type Held = {
  transcript: ConversationTranscript;
  view: ConversationView;
  items: readonly TranscriptItem[];
};

/**
 * The conversation as the chat shows it: every entry the view's window brought and the reader
 * loaded, in Pi's `ConversationTranscript`, which keeps them when the window moves on. Entries a
 * reconnect skipped load at once; earlier history loads a page at a time on request. A load that
 * fails offers `retry`, whether or not earlier history remains. A new `readPage` starts a new
 * transcript, so it must keep its identity between renders.
 */
export function usePiTranscript(view: ConversationView, readPage: PiEntryPageReader) {
  const transcript = useMemo(
    () =>
      new ConversationTranscript(
        async (query, limit) => {
          const page = await readPage({
            minEntryId: query.minEntryId ?? null,
            maxEntryId: query.maxEntryId ?? null,
            order: query.order ?? "descending",
            pageSize: limit,
          });
          // The transcript only asks whether the range goes on; it never passes a cursor back.
          return { items: page.entries, next: page.more ? {} : undefined };
        },
        { pageSize: PAGE_SIZE },
      ),
    [readPage],
  );
  // Merging is idempotent and cheap, so each new view merges as it renders, not an effect later.
  const [held, setHeld] = useState<Held | null>(null);
  let items: readonly TranscriptItem[];
  if (held?.transcript === transcript && held.view === view) {
    ({ items } = held);
  } else {
    ({ items } = transcript.merge(view));
    setHeld({ transcript, view, items });
  }
  // Missed entries and earlier history load independently, so each keeps its own failure.
  const [gapError, setGapError] = useState<string | null>(null);
  const [earlierError, setEarlierError] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const take = useCallback(
    async (load: () => Promise<TranscriptView>) => {
      const loaded = await load();
      // A load's items hold every view merged before it resolved.
      setHeld((current) =>
        current?.transcript === transcript ? { ...current, items: loaded.items } : current,
      );
    },
    [transcript],
  );

  const gap = items.find((item) => item.kind === "gap");
  // Entries a reconnect skipped are ones the window would have brought; a failure waits for a
  // retry, which loads the gap again, or the one it shrank to.
  useEffect(() => {
    if (gap !== undefined && gapError === null) {
      take(() => transcript.fillGap(gap, BACKGROUND_CONTEXT)).catch((cause: unknown) => {
        setGapError(errorMessage(cause));
      });
    }
  }, [gap, gapError, take, transcript]);

  const loadEarlier = useCallback(async () => {
    setEarlierError(null);
    setLoadingEarlier(true);
    try {
      await take(() => transcript.loadEarlier(BACKGROUND_CONTEXT));
    } catch (cause) {
      setEarlierError(errorMessage(cause));
    } finally {
      setLoadingEarlier(false);
    }
  }, [take, transcript]);

  const hasMore = items[0]?.kind === "earlier";
  const loadMore = useCallback(async () => {
    if (hasMore && !loadingEarlier) {
      await loadEarlier();
    }
  }, [hasMore, loadEarlier, loadingEarlier]);
  const retry = useMemo(
    () =>
      gapError === null && earlierError === null
        ? null
        : async () => {
            setGapError(null);
            if (earlierError !== null) {
              await loadEarlier();
            }
          },
    [earlierError, gapError, loadEarlier],
  );

  // Keyed on the items, which the transcript keeps while a commit only changes documents, such as
  // each streamed partial; rebuilding the conversation's messages costs the whole transcript.
  const entries = useMemo(
    () => items.flatMap((item) => (item.kind === "entry" ? [item.entry] : [])),
    [items],
  );
  // The newest head marker (a compaction or clear) names the active context's first entry; until
  // one has loaded, everything shown may be in context.
  const activeContextStart = useMemo(() => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const head = entries[index].head;
      if (head !== undefined) {
        return head;
      }
    }
    return null;
  }, [entries]);
  return {
    activeContextStart,
    // The active context starts at or above the oldest entry shown, so older history is outside it.
    earlierHistoryOutOfContext:
      activeContextStart !== null && entries.length > 0 && activeContextStart <= entries[0].id,
    transcript: entries,
    hasMore,
    loading: loadingEarlier,
    error: gapError ?? earlierError,
    loadMore,
    /** Runs the loads that failed again; null while none has. */
    retry,
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
