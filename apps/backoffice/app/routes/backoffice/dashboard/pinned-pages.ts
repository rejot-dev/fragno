import { useCallback, useSyncExternalStore } from "react";
import { z } from "zod";

const STORAGE_KEY_PREFIX = "backoffice:dashboard-pinned-pages:";
const NO_PAGES: readonly string[] = [];
const listeners = new Set<() => void>();
// Keeps each scope's parsed pages while its stored value is unchanged, as useSyncExternalStore needs.
const snapshots = new Map<string, { stored: string | null; names: readonly string[] }>();

/** The names of the scope's pages pinned as dashboard tabs in this browser, in pinning order. */
export function usePinnedPages(scopePath: string): {
  names: readonly string[];
  pin: (name: string) => void;
  unpin: (name: string) => void;
  /** Unpins pages whose source is gone, given every page the scope has. */
  unpinMissing: (existing: readonly string[]) => void;
} {
  const key = `${STORAGE_KEY_PREFIX}${scopePath}`;
  const names = useSyncExternalStore(
    subscribe,
    () => readPinnedPages(key),
    () => NO_PAGES,
  );
  const pin = useCallback(
    (name: string) => {
      const current = readPinnedPages(key);
      if (!current.includes(name)) {
        writePinnedPages(key, [...current, name]);
      }
    },
    [key],
  );
  const unpin = useCallback(
    (name: string) => {
      writePinnedPages(
        key,
        readPinnedPages(key).filter((pinned) => pinned !== name),
      );
    },
    [key],
  );
  const unpinMissing = useCallback(
    (existing: readonly string[]) => {
      const current = readPinnedPages(key);
      const existingNames = new Set(existing);
      const kept = current.filter((pinned) => existingNames.has(pinned));
      if (kept.length !== current.length) {
        writePinnedPages(key, kept);
      }
    },
    [key],
  );
  return { names, pin, unpin, unpinMissing };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Other browser tabs write through the storage event.
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function readPinnedPages(key: string): readonly string[] {
  const stored = readStorage(key);
  const snapshot = snapshots.get(key);
  if (snapshot?.stored === stored) {
    return snapshot.names;
  }
  const names = stored === null ? NO_PAGES : parsePinnedPages(stored);
  snapshots.set(key, { stored, names });
  return names;
}

function parsePinnedPages(stored: string): readonly string[] {
  try {
    // Storage outlives this code and anyone can edit it, so its value may not be page names.
    const parsed = z.array(z.string()).safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : NO_PAGES;
  } catch {
    return NO_PAGES;
  }
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePinnedPages(key: string, names: readonly string[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(names));
  } catch {
    // Without storage, pins cannot be kept, and the open page remains its own tab.
    return;
  }
  for (const listener of listeners) {
    listener();
  }
}
