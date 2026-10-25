import type { BackofficeUiStateChange } from "@fragno-private/backoffice-ui/renderer";

import { setByPath } from "@json-render/core";

const WORKFLOW_UI_DRAFTS_STORAGE_KEY = "fragno-backoffice-workflow-ui-drafts";

export type WorkflowUiDraft = {
  id: string;
  state: Record<string, unknown>;
  eventIds?: Record<string, string>;
  submittedEventType: string | null;
  updatedAt: number;
};

/**
 * Drafts of the forms runs ask, by ID, kept in localStorage so a reload keeps what a person typed,
 * and the event IDs that keep a retried submission from sending twice. Storage keeps the format
 * TanStack DB's localStorage collection wrote, `{ "s:<id>": { versionKey, data } }`, so drafts
 * saved before keep loading.
 */
export const workflowUiDrafts = {
  /** Resolves once the drafts can be read; they are read from localStorage as needed. */
  preload: (): Promise<void> => Promise.resolve(),
  /** Throws when the stored drafts cannot be read. */
  get: (id: string): WorkflowUiDraft | undefined => readDrafts().get(id)?.data,
  has: (id: string): boolean => readDrafts().has(id),
};

/** Deletes every saved draft, for when they cannot be read. */
export function discardWorkflowUiDrafts() {
  localStorage.removeItem(WORKFLOW_UI_DRAFTS_STORAGE_KEY);
}

type StoredDraft = { versionKey: string; data: WorkflowUiDraft };

// TanStack DB's prefix for string keys.
const STRING_KEY_PREFIX = "s:";

/**
 * Every stored draft, by ID. Storage it cannot read throws, as TanStack DB's collection did,
 * rather than read as empty, which the next write would save over every other draft.
 */
function readDrafts(): Map<string, StoredDraft> {
  const serialized = localStorage.getItem(WORKFLOW_UI_DRAFTS_STORAGE_KEY);
  if (serialized === null) {
    return new Map();
  }
  let stored: unknown;
  try {
    stored = JSON.parse(serialized);
  } catch (cause) {
    throw new Error("Saved workflow input is not JSON.", { cause });
  }
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    throw new Error("Saved workflow input is not an object of drafts.");
  }
  const drafts = new Map<string, StoredDraft>();
  for (const [key, entry] of Object.entries(stored)) {
    const id = key.startsWith(STRING_KEY_PREFIX) ? key.slice(STRING_KEY_PREFIX.length) : null;
    if (id === null || !isStoredDraft(entry) || entry.data.id !== id) {
      throw new Error(`Saved workflow input holds an entry that is not a draft: ${key}.`);
    }
    drafts.set(id, entry);
  }
  return drafts;
}

function isStoredDraft(entry: unknown): entry is StoredDraft {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const { versionKey, data } = entry as Partial<Record<keyof StoredDraft, unknown>>;
  return (
    typeof versionKey === "string" &&
    typeof data === "object" &&
    data !== null &&
    typeof (data as { id?: unknown }).id === "string"
  );
}

function writeDraft(id: string, draft: WorkflowUiDraft | null) {
  const drafts = readDrafts();
  if (draft) {
    drafts.set(id, { versionKey: crypto.randomUUID(), data: draft });
  } else {
    drafts.delete(id);
  }
  localStorage.setItem(
    WORKFLOW_UI_DRAFTS_STORAGE_KEY,
    JSON.stringify(
      Object.fromEntries([...drafts].map(([key, entry]) => [STRING_KEY_PREFIX + key, entry])),
    ),
  );
}

const pendingWrites = new Map<string, Promise<unknown>>();

export function workflowUiDraftId({
  runRecordId,
  stepRecordId,
}: {
  runRecordId: string;
  stepRecordId: string;
}) {
  return `${runRecordId}:${stepRecordId}`;
}

export function saveWorkflowUiDraft({
  id,
  initialState,
  changes,
}: {
  id: string;
  initialState: Record<string, unknown>;
  changes: BackofficeUiStateChange[];
}) {
  void queueWorkflowUiDraftMutation(id, async () => {
    const existing = workflowUiDrafts.get(id);
    const state = structuredClone(existing?.state ?? initialState);
    for (const change of changes) {
      setByPath(state, change.path, change.value);
    }
    writeDraft(id, {
      id,
      eventIds: {},
      submittedEventType: null,
      ...existing,
      state,
      updatedAt: Date.now(),
    });
  });
}

export function getOrCreateWorkflowUiDraftEventId({
  id,
  eventType,
  initialState,
  fallbackEventId,
}: {
  id: string;
  eventType: string;
  initialState: Record<string, unknown>;
  fallbackEventId: string;
}): Promise<string> {
  return queueWorkflowUiDraftMutation(id, async () => {
    const existing = workflowUiDrafts.get(id);
    const existingEventId = existing?.eventIds?.[eventType];
    if (existingEventId) {
      return existingEventId;
    }

    writeDraft(id, {
      id,
      state: structuredClone(initialState),
      submittedEventType: null,
      ...existing,
      eventIds: { ...existing?.eventIds, [eventType]: fallbackEventId },
      updatedAt: Date.now(),
    });
    return fallbackEventId;
  });
}

export function markWorkflowUiDraftSubmitted({
  id,
  eventType,
  initialState,
}: {
  id: string;
  eventType: string;
  initialState: Record<string, unknown>;
}) {
  void queueWorkflowUiDraftMutation(id, async () => {
    writeDraft(id, {
      id,
      state: structuredClone(initialState),
      eventIds: {},
      ...workflowUiDrafts.get(id),
      submittedEventType: eventType,
      updatedAt: Date.now(),
    });
  });
}

export function deleteWorkflowUiDraft(id: string) {
  void queueWorkflowUiDraftMutation(id, async () => {
    writeDraft(id, null);
  });
}

function queueWorkflowUiDraftMutation<TResult>(
  id: string,
  mutation: () => Promise<TResult>,
): Promise<TResult> {
  const previousMutation = pendingWrites.get(id) ?? Promise.resolve();
  const mutationResult = previousMutation.catch(() => undefined).then(mutation);
  const trackedMutation = mutationResult.finally(() => {
    if (pendingWrites.get(id) === trackedMutation) {
      pendingWrites.delete(id);
    }
  });
  pendingWrites.set(id, trackedMutation);
  void trackedMutation.catch((error: unknown) => {
    console.error("Could not persist generated workflow input.", error);
  });
  return trackedMutation;
}
