import { useEffect, useState } from "react";

import { setByPath } from "@json-render/core";

import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import { resolveGeneratedUiUploadScope } from "@/backoffice-ui/generated-ui-upload-scope";
import { uploadPreparedGeneratedUiFile } from "@/backoffice-ui/prepared-upload.client";
import { parseBackofficeUiResult, type BackofficeUiResultV1 } from "@/backoffice-ui/result";

import { WorkflowGeneratedUi, type WorkflowEventSender } from "./workflow-generated-ui";
import type { WorkflowRunEvent, WorkflowStepRunState } from "./workflow-run-presentation";
import {
  deleteWorkflowUiDraft,
  getOrCreateWorkflowUiDraftEventId,
  markWorkflowUiDraftSubmitted,
  saveWorkflowUiDraft,
  workflowUiDraftId,
  workflowUiDrafts,
  type WorkflowUiDraft,
} from "./workflow-ui-drafts.client";
import { activeWorkflowUiEventTypes, submittedWorkflowUiEvent } from "./workflow-ui-event-state";

export function WorkflowStepGeneratedUi({
  state,
  workflowEvents,
  workflowRunRecordId,
  currentScope,
  workflowEventSender,
  workflowInstanceId,
  workflowName,
  waitingEventTypes,
}: {
  state?: WorkflowStepRunState;
  workflowEvents: readonly WorkflowRunEvent[];
  workflowRunRecordId?: string;
  currentScope?: BackofficeRoutableScope;
  workflowEventSender?: WorkflowEventSender;
  workflowInstanceId?: string;
  workflowName?: string;
  waitingEventTypes: readonly string[];
}) {
  if (state?.status !== "completed") {
    return null;
  }
  const parsedResult = parseBackofficeUiResult(state.result);
  if (parsedResult.kind === "ordinary") {
    return null;
  }

  return (
    <div
      data-workflow-step-generated-ui
      className="mt-3 border-t border-[color:var(--bo-border)] pt-3"
    >
      {parsedResult.kind === "valid" ? (
        <InteractiveWorkflowStepGeneratedUi
          result={parsedResult.value}
          state={state}
          workflowEvents={workflowEvents}
          workflowRunRecordId={workflowRunRecordId}
          currentScope={currentScope}
          workflowEventSender={workflowEventSender}
          workflowInstanceId={workflowInstanceId}
          workflowName={workflowName}
          waitingEventTypes={waitingEventTypes}
        />
      ) : (
        <WorkflowGeneratedUi value={state.result} />
      )}
    </div>
  );
}

function InteractiveWorkflowStepGeneratedUi({
  result,
  state,
  workflowEvents,
  workflowRunRecordId,
  currentScope,
  workflowEventSender,
  workflowInstanceId,
  workflowName,
  waitingEventTypes,
}: {
  result: BackofficeUiResultV1;
  state: WorkflowStepRunState;
  workflowEvents: readonly WorkflowRunEvent[];
  workflowRunRecordId?: string;
  currentScope?: BackofficeRoutableScope;
  workflowEventSender?: WorkflowEventSender;
  workflowInstanceId?: string;
  workflowName?: string;
  waitingEventTypes: readonly string[];
}) {
  const submitted = submittedWorkflowUiEvent({
    ui: result.$ui,
    events: workflowEvents,
    completedAt: state.completedAt,
  });
  const draftId =
    workflowRunRecordId && state.stepRecordId
      ? workflowUiDraftId({ runRecordId: workflowRunRecordId, stepRecordId: state.stepRecordId })
      : undefined;
  const activeEventTypes = activeWorkflowUiEventTypes(result.$ui, waitingEventTypes);
  const stepRecordId = state.stepRecordId;
  const usesBrowserDraft = Boolean(draftId && !submitted && activeEventTypes.size > 0);
  const [draft, setDraft] = useState<WorkflowUiDraft | null>();

  useEffect(() => {
    if (!usesBrowserDraft || !draftId) {
      setDraft(undefined);
      return undefined;
    }
    let active = true;
    void workflowUiDrafts.preload().then(() => {
      if (active) {
        setDraft(workflowUiDrafts.get(draftId) ?? null);
      }
    });
    return () => {
      active = false;
    };
  }, [draftId, usesBrowserDraft]);

  const submittedEventId = submitted?.event.id;
  useEffect(() => {
    if (submittedEventId && draftId) {
      deleteWorkflowUiDraft(draftId);
    }
  }, [draftId, submittedEventId]);

  if (usesBrowserDraft && draft === undefined) {
    return (
      <p aria-live="polite" className="text-xs text-[var(--bo-muted-2)]">
        Restoring saved input…
      </p>
    );
  }

  const ui = {
    ...result.$ui,
    state: submitted?.state ?? draft?.state ?? result.$ui.state,
  };
  return (
    <WorkflowGeneratedUi
      value={{ ...result, $ui: ui }}
      onStateChange={
        usesBrowserDraft && draftId
          ? (changes) => {
              const nextState = structuredClone(draft?.state ?? ui.state);
              for (const change of changes) {
                setByPath(nextState, change.path, change.value);
              }
              setDraft({
                id: draftId,
                state: nextState,
                eventIds: draft?.eventIds,
                submittedEventType: draft?.submittedEventType ?? null,
                updatedAt: Date.now(),
              });
              saveWorkflowUiDraft({ id: draftId, initialState: ui.state, changes });
            }
          : undefined
      }
      workflowInteractionHost={
        workflowEventSender && workflowName && workflowInstanceId && stepRecordId
          ? {
              canEditInput: () => activeEventTypes.size > 0 && !draft?.submittedEventType,
              canSendEvent: (eventType) =>
                activeEventTypes.has(eventType) && draft?.submittedEventType !== eventType,
              uploadFile: ({ scope, file, onProgress }) =>
                uploadPreparedGeneratedUiFile({
                  scope: resolveGeneratedUiUploadScope(scope, currentScope),
                  file,
                  workflowName,
                  instanceId: workflowInstanceId,
                  stepRecordId,
                  onProgress,
                }),
              sendEvent: async ({ eventId: fallbackEventId, eventType, payload }) => {
                const eventId = draftId
                  ? await getOrCreateWorkflowUiDraftEventId({
                      id: draftId,
                      eventType,
                      initialState: ui.state,
                      fallbackEventId,
                    })
                  : fallbackEventId;
                if (draftId) {
                  setDraft({
                    id: draftId,
                    state: draft?.state ?? ui.state,
                    eventIds: { ...draft?.eventIds, [eventType]: eventId },
                    submittedEventType: draft?.submittedEventType ?? null,
                    updatedAt: Date.now(),
                  });
                }
                await workflowEventSender({
                  eventId,
                  workflowName,
                  instanceId: workflowInstanceId,
                  eventType,
                  payload,
                });
                if (draftId) {
                  setDraft({
                    id: draftId,
                    state: draft?.state ?? ui.state,
                    eventIds: { ...draft?.eventIds, [eventType]: eventId },
                    submittedEventType: eventType,
                    updatedAt: Date.now(),
                  });
                  markWorkflowUiDraftSubmitted({
                    id: draftId,
                    eventType,
                    initialState: ui.state,
                  });
                }
              },
            }
          : undefined
      }
    />
  );
}
