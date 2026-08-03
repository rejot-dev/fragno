import { setByPath } from "@json-render/core";
import { createCollection, localStorageCollectionOptions } from "@tanstack/react-db";

import type { BackofficeUiStateChange } from "@/backoffice-ui/renderer";

const WORKFLOW_UI_DRAFTS_STORAGE_KEY = "fragno-backoffice-workflow-ui-drafts";

export type WorkflowUiDraft = {
  id: string;
  state: Record<string, unknown>;
  eventIds?: Record<string, string>;
  submittedEventType: string | null;
  updatedAt: number;
};

export const workflowUiDrafts = createCollection(
  localStorageCollectionOptions<WorkflowUiDraft, string>({
    storageKey: WORKFLOW_UI_DRAFTS_STORAGE_KEY,
    getKey: (draft) => draft.id,
  }),
);

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
    const state = structuredClone(workflowUiDrafts.get(id)?.state ?? initialState);
    for (const change of changes) {
      setByPath(state, change.path, change.value);
    }
    const updatedAt = Date.now();
    const transaction = workflowUiDrafts.has(id)
      ? workflowUiDrafts.update(id, (draft) => {
          draft.state = state;
          draft.updatedAt = updatedAt;
        })
      : workflowUiDrafts.insert({
          id,
          state,
          eventIds: {},
          submittedEventType: null,
          updatedAt,
        });
    await transaction.isPersisted.promise;
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

    const updatedAt = Date.now();
    const transaction = existing
      ? workflowUiDrafts.update(id, (draft) => {
          draft.eventIds = { ...draft.eventIds, [eventType]: fallbackEventId };
          draft.updatedAt = updatedAt;
        })
      : workflowUiDrafts.insert({
          id,
          state: structuredClone(initialState),
          eventIds: { [eventType]: fallbackEventId },
          submittedEventType: null,
          updatedAt,
        });
    await transaction.isPersisted.promise;
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
    const updatedAt = Date.now();
    const transaction = workflowUiDrafts.has(id)
      ? workflowUiDrafts.update(id, (draft) => {
          draft.submittedEventType = eventType;
          draft.updatedAt = updatedAt;
        })
      : workflowUiDrafts.insert({
          id,
          state: structuredClone(initialState),
          eventIds: {},
          submittedEventType: eventType,
          updatedAt,
        });
    await transaction.isPersisted.promise;
  });
}

export function deleteWorkflowUiDraft(id: string) {
  void queueWorkflowUiDraftMutation(id, async () => {
    if (workflowUiDrafts.has(id)) {
      await workflowUiDrafts.delete(id).isPersisted.promise;
    }
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
