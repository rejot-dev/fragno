import { z } from "zod";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { PiWorkflowStatus } from "./types";

const workflowStatusValueSchema = z.enum([
  "active",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
]) satisfies z.ZodType<PiWorkflowStatus>;

const sessionBaseSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  agent: z.string(),
  workflowName: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const ImageContentSchema = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});

const agentMessageSchema = z.unknown() as z.ZodType<AgentMessage>;
const workflowStatusSchema = z.object({
  status: workflowStatusValueSchema,
  error: z
    .object({
      name: z.string(),
      message: z.string(),
    })
    .optional(),
  output: z.any().optional(),
});

const piAgentStateSnapshotSchema = z.object({
  messages: z.array(agentMessageSchema),
  errorMessage: z.string().optional(),
});

const sessionDetailSchema = sessionBaseSchema.omit({ agent: true }).extend({
  agentName: z.string(),
  workflow: workflowStatusSchema,
  agent: z.object({
    state: piAgentStateSnapshotSchema,
    completedStepKeys: z.array(z.string()),
  }),
});

const promptInputSchema = z.object({
  text: z.string(),
  images: z.array(ImageContentSchema).optional(),
});

const commandInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prompt"), input: promptInputSchema }),
  z.object({ kind: z.literal("abort"), reason: z.string().optional() }),
  z.object({ kind: z.literal("steer"), input: promptInputSchema }),
  z.object({ kind: z.literal("followUp"), input: promptInputSchema }),
  z.object({ kind: z.literal("nextTurn"), input: promptInputSchema }),
]);

const commandAckSchema = z.object({
  accepted: z.literal(true),
  commandId: z.string(),
  status: workflowStatusValueSchema,
});

export {
  agentMessageSchema,
  commandAckSchema,
  commandInputSchema,
  piAgentStateSnapshotSchema,
  promptInputSchema,
  sessionBaseSchema,
  sessionDetailSchema,
  workflowStatusSchema,
};
