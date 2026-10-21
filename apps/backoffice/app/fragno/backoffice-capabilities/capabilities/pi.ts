import { piAgentDefinitionSchema } from "@fragno-dev/backoffice-api/v0/pi";
import {
  backofficeScopeOrganization,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const PI_AUTOMATION_SOURCE = "pi" as const;
export const PI_AUTOMATION_EVENT_TURN_COMPLETED = "turn.completed" as const;
export const PI_AUTOMATION_EVENT_TURN_ABORTED = "turn.aborted" as const;

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
} as const;

const turnCompletedPayloadSchema = z.object({
  answerEntryId: z
    .number()
    .int()
    .nonnegative()
    .describe("The conversation entry holding the turn's answer."),
});

const agentDefinitionPayloadSchema = z.object({ definition: piAgentDefinitionSchema });

const agentSubjectSchema = z.object({
  orgId: z.string().trim().min(1).optional(),
  projectId: z.string().trim().min(1).optional(),
  agentName: z.string().trim().min(1),
});

const turnSubjectSchema = agentSubjectSchema.extend({
  requestId: z
    .string()
    .trim()
    .min(1)
    .describe("The prompt's request ID; pi.getSubmission reads the turn's submission."),
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

// Steering joins a running turn, so the steered prompt settles with that turn's answer.
const turnNote =
  "Fires once per prompt request ID. Steering prompts that joined a running turn settle with it.";

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
          "Agent turns that answered or were cut off, and agents defined, changed, deleted, or stopped, attributed to whoever did it.",
      },
    ],
    actionProviders: ["pi"],
    hookScopes: [],
    skillPaths: [],
    externalEntities: [],
    automationEvents: [
      {
        source: PI_AUTOMATION_SOURCE,
        eventType: PI_AUTOMATION_EVENT_TURN_COMPLETED,
        label: "Agent turn completed",
        description: `Fires after an agent answers a prompt. ${turnNote}`,
        payloadSchema: turnCompletedPayloadSchema,
        subjectSchema: turnSubjectSchema,
        example: { answerEntryId: 12 },
      },
      {
        source: PI_AUTOMATION_SOURCE,
        eventType: PI_AUTOMATION_EVENT_TURN_ABORTED,
        label: "Agent turn aborted",
        description: `Fires after stopping an agent cuts off a turn before it answered; agent.stopped records who stopped it. ${turnNote}`,
        payloadSchema: z.object({}),
        subjectSchema: turnSubjectSchema,
        example: {},
      },
      ...(["created", "updated", "deleted"] as const).map((kind) => ({
        source: PI_AUTOMATION_SOURCE,
        ...PI_AGENT_AUTOMATION_EVENTS[kind],
        payloadSchema: agentDefinitionPayloadSchema,
        subjectSchema: agentSubjectSchema,
        example: { definition: exampleDefinition },
      })),
      {
        source: PI_AUTOMATION_SOURCE,
        ...PI_AGENT_AUTOMATION_EVENTS.stopped,
        payloadSchema: z.object({}),
        subjectSchema: agentSubjectSchema,
        example: {},
      },
    ],
  },
};
