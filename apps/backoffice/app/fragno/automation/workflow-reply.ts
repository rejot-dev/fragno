import { piAgentNameSchema } from "@fragno-dev/backoffice-api/v0/shared/pi-agent-name";
import {
  backofficeContextScopeSchema,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { WorkflowTerminalHookPayload } from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import type { PiAgentNotification } from "@/fragno/pi/agent/pi-agent-contract";

/**
 * Where a codemode workflow reports when it ends: a completion event for the workflow that waits on
 * it, or a notification for the agent that started it, which may be in another scope.
 */
export const workflowReplyToSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("workflow"),
    workflowName: z.string().min(1),
    instanceId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("agent"),
    scope: backofficeContextScopeSchema,
    agentName: piAgentNameSchema,
  }),
]);

export type WorkflowReplyTo = z.infer<typeof workflowReplyToSchema>;

export const WORKFLOW_COMPLETED_EVENT_TYPE = "workflow.completed";

export const workflowCompletedEventType = (runGeneration: number) =>
  `${WORKFLOW_COMPLETED_EVENT_TYPE}:${runGeneration}`;

export type WorkflowCompletedEventPayload = {
  terminalTransitionId: string;
  workflowName: string;
  instanceId: string;
  runGeneration: number;
  status: "complete" | "errored" | "terminated";
  output?: unknown;
  error?: { name: string; message: string };
};

export const workflowCompletionEventId = (input: {
  instanceRef: string;
  runGeneration: number;
  terminalTransitionId: string;
}) =>
  `workflow-completed:${input.instanceRef}:${input.runGeneration}:${input.terminalTransitionId}`;

/** The source of the events a workflow reports to the agent that started it. */
const WORKFLOW_NOTIFICATION_SOURCE = "workflows";
const WORKFLOW_COMPLETED_NOTIFICATION_TYPE = "instance.completed";

/**
 * The event telling an agent that a workflow it started has ended. It names the run's scope, which
 * can differ from the agent's, so the agent and its chat follow up on the run where it is.
 */
export function workflowCompletedNotificationEvent({
  terminal,
  scope,
  workflowName,
  occurredAt,
}: {
  terminal: WorkflowTerminalHookPayload;
  scope: BackofficeContextScope;
  workflowName: string;
  occurredAt: Date;
}): PiAgentNotification["event"] {
  return {
    id: workflowCompletionEventId(terminal),
    source: WORKFLOW_NOTIFICATION_SOURCE,
    eventType: WORKFLOW_COMPLETED_NOTIFICATION_TYPE,
    occurredAt: occurredAt.toISOString(),
    subject: { scope, workflowName, instanceId: terminal.instanceId },
    payload: {
      status: terminal.status,
      output: terminal.output ?? null,
      error: terminal.error ?? null,
    },
  };
}

/**
 * The run an agent's notification reports the end of, where it ran, and its output; null for other
 * events. Notifications from before they named the run's scope came from the agent's own scope.
 */
export function workflowCompletionFromNotification(
  event: PiAgentNotification["event"],
  agentScope: BackofficeContextScope,
): {
  scope: BackofficeContextScope;
  workflowName: string;
  instanceId: string;
  output: unknown;
} | null {
  if (
    event.source !== WORKFLOW_NOTIFICATION_SOURCE ||
    event.eventType !== WORKFLOW_COMPLETED_NOTIFICATION_TYPE
  ) {
    return null;
  }
  // Written by workflowCompletedNotificationEvent above.
  const subject = event.subject as {
    scope?: BackofficeContextScope;
    workflowName: string;
    instanceId: string;
  };
  return {
    scope: subject.scope ?? agentScope,
    workflowName: subject.workflowName,
    instanceId: subject.instanceId,
    output: event.payload.output,
  };
}
