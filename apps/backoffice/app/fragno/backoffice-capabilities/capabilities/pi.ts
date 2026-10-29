import { piAgentDefinitionSchema, type PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";
import {
  type BackofficeContextScope,
  backofficeContextScopeSchema,
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
      "Fires when work starts waiting for an agent: a prompt or notification in its queue, behind its running turn or while it is stopped, a steer for the running turn's next tool boundary, or a subagent while the agent runs as many as it may at once or is stopped. queue.dispatched or queue.dropped ends a queued item's wait, and turn.started a steer's. Work that starts at once never waits.",
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
    .describe(
      "The conversation entry holding the turn's answer; pi.getPrompt with the subject's request ID reads the answer, under pi.read.",
    ),
});

const turnFailedPayloadSchema = z.object({
  reason: z.string().describe("Why Pi left the prompt unanswered, such as model_error."),
});

const queueAddedPayloadSchema = z.object({
  type: z
    .enum(["prompt", "notification", "steer", "subagent"])
    .describe(
      "A steer is a prompt that joins the running turn instead of waiting for its own; a subagent is a prompt that runs in a new conversation of the agent, waiting only for a free slot.",
    ),
});

const queueDispatchedPayloadSchema = z.object({
  turnRequestId: z.string().describe("The request ID of the turn that took the work."),
});

const queueDroppedPayloadSchema = z.object({
  reason: z.string().describe("Why the queued work can no longer run."),
});

const agentDefinitionPayloadSchema = z.object({
  definition: piAgentDefinitionSchema._zod.innerType.extend({
    // Events recorded before agents had stewards lack one; their agents were members'.
    steward: piAgentDefinitionSchema._zod.innerType.shape.steward.optional(),
  }),
});

const agentSubjectSchema = z.object({
  scope: backofficeContextScopeSchema,
  agentName: z.string().trim().min(1),
});

const requestSubjectSchema = agentSubjectSchema.extend({
  requestId: z
    .string()
    .trim()
    .min(1)
    .describe("The work's request ID; for a prompt, the one pi.submitPrompt's receipt names."),
});

/** Names an agent among same-named agents of other scopes. */
export function piAgentEventSubject(
  scope: BackofficeContextScope,
  agentName: string,
): z.infer<typeof agentSubjectSchema> {
  return { scope, agentName };
}

/** What happened to an agent, by the `pi` event that records it. */
const agentActivityByEventType = {
  [PI_TURN_AUTOMATION_EVENTS.started.eventType]: "started",
  [PI_TURN_AUTOMATION_EVENTS.completed.eventType]: "answered",
  [PI_TURN_AUTOMATION_EVENTS.aborted.eventType]: "cut-off",
  [PI_TURN_AUTOMATION_EVENTS.failed.eventType]: "failed",
  [PI_QUEUE_AUTOMATION_EVENTS.added.eventType]: "queued",
  [PI_QUEUE_AUTOMATION_EVENTS.dispatched.eventType]: "dispatched",
  [PI_QUEUE_AUTOMATION_EVENTS.dropped.eventType]: "dropped",
  [PI_AGENT_AUTOMATION_EVENTS.created.eventType]: "created",
  [PI_AGENT_AUTOMATION_EVENTS.updated.eventType]: "updated",
  [PI_AGENT_AUTOMATION_EVENTS.deleted.eventType]: "deleted",
  [PI_AGENT_AUTOMATION_EVENTS.stopped.eventType]: "stopped",
  [PI_AGENT_AUTOMATION_EVENTS.resumed.eventType]: "resumed",
} as const;

export type PiAgentActivityKind =
  (typeof agentActivityByEventType)[keyof typeof agentActivityByEventType];

type PiAgentRequestKind = "started" | "answered" | "cut-off" | "failed" | "dispatched" | "dropped";

export type PiAgentEvent =
  | { agentName: string; kind: "created" | "updated" | "deleted"; definition: PiAgentDefinition }
  | { agentName: string; kind: "stopped" | "resumed" }
  | { agentName: string; kind: PiAgentRequestKind; requestId: string }
  | { agentName: string; kind: "queued"; requestId: string; steer: boolean };

/**
 * The agent a stored `pi` event is about and what happened to it, with the definition a definition
 * event carries and the request ID of turn and queue events; null for any other event.
 */
export function readPiAgentEvent(event: {
  source: string;
  eventType: string;
  payload: unknown;
  subject: unknown;
}): PiAgentEvent | null {
  if (
    event.source !== PI_AUTOMATION_SOURCE ||
    !Object.hasOwn(agentActivityByEventType, event.eventType)
  ) {
    return null;
  }
  const kind = agentActivityByEventType[event.eventType as keyof typeof agentActivityByEventType];
  if (kind === "created" || kind === "updated" || kind === "deleted") {
    const subject = agentSubjectSchema.safeParse(event.subject);
    const payload = agentDefinitionPayloadSchema.safeParse(event.payload);
    if (!subject.success || !payload.success) {
      return null;
    }
    const { steward = { kind: "members" }, ...definition } = payload.data.definition;
    return { agentName: subject.data.agentName, kind, definition: { ...definition, steward } };
  }
  if (kind === "stopped" || kind === "resumed") {
    const subject = agentSubjectSchema.safeParse(event.subject);
    return subject.success ? { agentName: subject.data.agentName, kind } : null;
  }
  const subject = requestSubjectSchema.safeParse(event.subject);
  if (!subject.success) {
    return null;
  }
  const { agentName, requestId } = subject.data;
  if (kind === "queued") {
    const payload = queueAddedPayloadSchema.safeParse(event.payload);
    return payload.success
      ? { agentName, kind, requestId, steer: payload.data.type === "steer" }
      : null;
  }
  return { agentName, kind, requestId };
}

const exampleDefinition = {
  agentName: "reviewer",
  description: "Reviews changes.",
  model: null,
  permissions: ["*"],
  instructions: "Report problems before suggesting fixes.",
  steward: { kind: "members" },
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
