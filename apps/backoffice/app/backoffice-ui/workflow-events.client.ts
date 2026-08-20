import { createRouteCaller } from "@fragno-dev/core/api";

import type { WorkflowsFragment } from "@fragno-dev/workflows";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { backofficeContextScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import { backofficeFetch } from "@/fragno/auth/browser-auth.client";
import type { WorkflowRunReference } from "@/routes/backoffice/automations/script-view/workflow-run-presentation";

const MAX_WORKFLOW_EVENT_PAYLOAD_BYTES = 64 * 1024;
const workflowEventTypePattern = /^[a-zA-Z0-9_][a-zA-Z0-9-_.:]*$/;

export type ScopedWorkflowRunReference = WorkflowRunReference & {
  scope: BackofficeContextScope;
};

export type SendBackofficeWorkflowEventResult = {
  accepted: true;
};

const createScopedWorkflowsRouteCaller = (scope: BackofficeContextScope) =>
  createRouteCaller<WorkflowsFragment>({
    baseUrl: window.location.origin,
    mountRoute: `/api/workflows/${encodeURIComponent(backofficeContextScopeSinglePathSegment(scope))}`,
    fetch: backofficeFetch,
  });

export async function sendBackofficeWorkflowEvent({
  eventId,
  reference,
  eventType,
  payload,
}: {
  eventId: string;
  reference: ScopedWorkflowRunReference;
  eventType: string;
  payload: unknown;
}): Promise<SendBackofficeWorkflowEventResult> {
  if (!workflowEventTypePattern.test(eventType) || eventType.length > 128) {
    throw new Error("Invalid workflow event type.");
  }

  const body = { id: eventId, type: eventType, payload };
  if (
    new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_WORKFLOW_EVENT_PAYLOAD_BYTES
  ) {
    throw new Error("Workflow input exceeds the 64 KB limit.");
  }

  const callRoute = createScopedWorkflowsRouteCaller(reference.scope);
  const response = await callRoute("POST", "/:workflowName/instances/:instanceId/events", {
    pathParams: {
      workflowName: reference.workflowName,
      instanceId: reference.instanceId,
    },
    body,
  });

  if (response.type === "json") {
    return { accepted: true };
  }

  if (response.type === "error") {
    throw new Error(response.error.message);
  }

  throw new Error(`Could not send workflow input (${response.status}).`);
}
