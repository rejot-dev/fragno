import { piAgentDefinitionSchema } from "@fragno-dev/backoffice-api/v0/pi";
import {
  backofficeScopeOrganization,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const PI_AUTOMATION_SOURCE = "pi" as const;

// Steering joins a running turn, so the steered prompt settles with that turn's answer.
const turnNote =
  "Fires once per prompt request ID. Steering prompts that joined a running turn settle with it.";

/** What happens to a prompt Pi holds, each recorded as a `pi` event in the agent's scope. */
export const PI_TURN_AUTOMATION_EVENTS = {
  started: {
    eventType: "turn.started",
    label: "Agent turn started",
    description: `Fires when an agent starts on a prompt; turn.completed, turn.aborted, or turn.failed follows for the same request ID. ${turnNote}`,
  },
  completed: {
    eventType: "turn.completed",
    label: "Agent turn completed",
    description: `Fires after an agent answers a prompt. ${turnNote}`,
  },
  aborted: {
    eventType: "turn.aborted",
    label: "Agent turn aborted",
    description: `Fires after stopping an agent cuts off a turn before it answered; agent.stopped records who stopped it. ${turnNote}`,
  },
  failed: {
    eventType: "turn.failed",
    label: "Agent turn failed",
    description: `Fires after a prompt ends unanswered for any reason but a stop, such as a model error. ${turnNote}`,
  },
} as const;

/** What the agent's queue does with an item that waits, each recorded as a `pi` event. */
export const PI_QUEUE_AUTOMATION_EVENTS = {
  added: {
    eventType: "queue.added",
    label: "Agent work queued",
    description:
      "Fires when work starts waiting for an agent: a prompt or notification in its queue, behind its running turn or while it is stopped, or a steer for the running turn's next tool boundary. queue.dispatched or queue.dropped ends a queued item's wait, and turn.started a steer's. Work an idle agent starts at once never waits.",
  },
  dispatched: {
    eventType: "queue.dispatched",
    label: "Queued agent work dispatched",
    description:
      "Fires when queued work leaves the queue for a turn; notifications handled together name the turn's request ID.",
  },
  dropped: {
    eventType: "queue.dropped",
    label: "Queued agent work dropped",
    description:
      "Fires when queued work can no longer run, such as after its agent's definition or model is gone.",
  },
} as const;

/** What `pi.agent.*` operations change, each recorded as a `pi` event in the agent's scope. */
export const PI_AGENT_AUTOMATION_EVENTS = {
  created: {
    eventType: "agent.created",
    label: "Agent created",
    description: "Fires after an agent is defined in the scope.",
  },
  updated: {
    eventType: "agent.updated",
    label: "Agent updated",
    description: "Fires after an agent's definition is replaced; it applies from the next turn.",
  },
  deleted: {
    eventType: "agent.deleted",
    label: "Agent deleted",
    description:
      "Fires after an agent's definition is deleted, carrying the definition it had. Deleting an undefined agent records nothing.",
  },
  stopped: {
    eventType: "agent.stopped",
    label: "Agent stopped",
    description:
      "Fires after a started agent is stopped: its work aborted and its queue paused until someone resumes it.",
  },
  resumed: {
    eventType: "agent.resumed",
    label: "Agent resumed",
    description:
      "Fires after someone resumes a stopped agent's queue, directly or by sending it a message; its queued work runs again.",
  },
} as const;

const turnCompletedPayloadSchema = z.object({
  answerEntryId: z
    .number()
    .int()
    .nonnegative()
    .describe("The conversation entry holding the turn's answer."),
});

const turnFailedPayloadSchema = z.object({
  reason: z.string().describe("Why Pi left the prompt unanswered, such as model_error."),
});

const queueAddedPayloadSchema = z.object({
  type: z
    .enum(["prompt", "notification", "steer"])
    .describe("A steer is a prompt that joins the running turn instead of waiting for its own."),
});

const queueDispatchedPayloadSchema = z.object({
  turnRequestId: z.string().describe("The request ID of the turn that took the work."),
});

const queueDroppedPayloadSchema = z.object({
  reason: z.string().describe("Why the queued work can no longer run."),
});

const agentDefinitionPayloadSchema = z.object({ definition: piAgentDefinitionSchema });

const agentSubjectSchema = z.object({
  orgId: z.string().trim().min(1).optional(),
  projectId: z.string().trim().min(1).optional(),
  agentName: z.string().trim().min(1),
});

const requestSubjectSchema = agentSubjectSchema.extend({
  requestId: z
    .string()
    .trim()
    .min(1)
    .describe("The work's request ID; pi.getSubmission reads its submission."),
});

/** Names an agent among same-named agents of other scopes. */
export function piAgentEventSubject(
  scope: BackofficeContextScope,
  agentName: string,
): z.infer<typeof agentSubjectSchema> {
  const organization = backofficeScopeOrganization(scope);
  return {
    ...(organization ? { orgId: organization.orgId } : {}),
    ...(scope.kind === "project" ? { projectId: scope.projectId } : {}),
    agentName,
  };
}

const exampleDefinition = {
  agentName: "reviewer",
  description: "Reviews changes.",
  model: null,
  permissions: ["*"],
  instructions: "Report problems before suggesting fixes.",
  managedBy: null,
};

/** Durable Pi contributes scoped agent actions; usage delivery is owned by each agent object. */
export const piCapability: BackofficeCapability = {
  id: "pi",
  label: "Pi",
  objectBinding: "PI_MANAGER",
  contributions: {
    connection: null,
    eventSources: [
      {
        source: PI_AUTOMATION_SOURCE,
        label: "Pi",
        description:
          "Agent work as it waits in an agent's queue, starts, and ends, and agents defined, changed, deleted, stopped, or resumed, attributed to whoever did it.",
      },
    ],
    actionProviders: ["pi"],
    hookScopes: [],
    skillPaths: [],
    externalEntities: [],
    automationEvents: [
      {
        source: PI_AUTOMATION_SOURCE,
        ...PI_TURN_AUTOMATION_EVENTS.started,
        payloadSchema: z.object({}),
        subjectSchema: requestSubjectSchema,
        example: {},
      },
      {
        source: PI_AUTOMATION_SOURCE,
        ...PI_TURN_AUTOMATION_EVENTS.completed,
        payloadSchema: turnCompletedPayloadSchema,
        subjectSchema: requestSubjectSchema,
        example: { answerEntryId: 12 },
      },
      {
        source: PI_AUTOMATION_SOURCE,
        ...PI_TURN_AUTOMATION_EVENTS.aborted,
        payloadSchema: z.object({}),
        subjectSchema: requestSubjectSchema,
        example: {},
      },
      {
        source: PI_AUTOMATION_SOURCE,
        ...PI_TURN_AUTOMATION_EVENTS.failed,
        payloadSchema: turnFailedPayloadSchema,
        subjectSchema: requestSubjectSchema,
        example: { reason: "model_error" },
      },
      {
        source: PI_AUTOMATION_SOURCE,
        ...PI_QUEUE_AUTOMATION_EVENTS.added,
        payloadSchema: queueAddedPayloadSchema,
        subjectSchema: requestSubjectSchema,
        example: { type: "prompt" },
      },
      {
        source: PI_AUTOMATION_SOURCE,
        ...PI_QUEUE_AUTOMATION_EVENTS.dispatched,
        payloadSchema: queueDispatchedPayloadSchema,
        subjectSchema: requestSubjectSchema,
        example: { turnRequestId: "prompt-1" },
      },
      {
        source: PI_AUTOMATION_SOURCE,
        ...PI_QUEUE_AUTOMATION_EVENTS.dropped,
        payloadSchema: queueDroppedPayloadSchema,
        subjectSchema: requestSubjectSchema,
        example: { reason: "Pi agent 'reviewer' is not defined." },
      },
      ...(["created", "updated", "deleted"] as const).map((kind) => ({
        source: PI_AUTOMATION_SOURCE,
        ...PI_AGENT_AUTOMATION_EVENTS[kind],
        payloadSchema: agentDefinitionPayloadSchema,
        subjectSchema: agentSubjectSchema,
        example: { definition: exampleDefinition },
      })),
      ...(["stopped", "resumed"] as const).map((kind) => ({
        source: PI_AUTOMATION_SOURCE,
        ...PI_AGENT_AUTOMATION_EVENTS[kind],
        payloadSchema: z.object({}),
        subjectSchema: agentSubjectSchema,
        example: {},
      })),
    ],
  },
};
