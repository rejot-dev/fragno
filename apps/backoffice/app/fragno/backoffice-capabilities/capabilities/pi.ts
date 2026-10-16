import { z } from "zod";

import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const PI_AUTOMATION_SOURCE = "pi" as const;
export const PI_AUTOMATION_EVENT_TURN_COMPLETED = "turn.completed" as const;

const turnCompletedPayloadSchema = z.object({
  answerEntryId: z
    .number()
    .int()
    .nonnegative()
    .describe("The conversation entry holding the turn's answer."),
});

const turnSubjectSchema = z.object({
  orgId: z.string().trim().min(1).optional(),
  projectId: z.string().trim().min(1).optional(),
  agentName: z.string().trim().min(1),
  requestId: z
    .string()
    .trim()
    .min(1)
    .describe("The prompt's request ID; pi.getSubmission reads the turn's submission."),
});

// Steering joins a running turn, so the steered prompt settles with that turn's answer.
const turnNote =
  "Fires once per prompt request ID. Steering prompts that joined a running turn settle with it.";

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
        description: "Agent turns that answered, attributed to whoever prompted the turn.",
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
    ],
  },
};
