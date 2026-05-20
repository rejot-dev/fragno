import { z } from "zod";

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

import type { PiSessionEventStreamItem } from "./types";

const SESSION_STATUSES = [
  "active",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
] as const;

const sessionBaseSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  status: z.enum(SESSION_STATUSES),
  agent: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const ImageContentSchema = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});

const agentMessageSchema: z.ZodType<AgentMessage> = z.custom<AgentMessage>();
const agentEventSchema: z.ZodType<AgentEvent> = z.custom<AgentEvent>();

const workflowStatusSchema = z.object({
  status: z.enum(SESSION_STATUSES),
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
    events: z.array(agentEventSchema),
  }),
});

const promptInputSchema = z.object({
  text: z.string(),
  images: z.array(ImageContentSchema).optional(),
});

const commandInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prompt"), input: promptInputSchema }),
  z.object({ kind: z.literal("continue") }),
  z.object({ kind: z.literal("abort"), reason: z.string().optional() }),
  z.object({ kind: z.literal("steer"), input: promptInputSchema }),
  z.object({ kind: z.literal("followUp"), input: promptInputSchema }),
  z.object({ kind: z.literal("complete"), reason: z.string().optional() }),
]);

const commandAckSchema = z.object({
  accepted: z.literal(true),
  commandId: z.string(),
  status: z.enum(SESSION_STATUSES),
});

const sessionEventStreamItemSchema: z.ZodType<PiSessionEventStreamItem> =
  z.custom<PiSessionEventStreamItem>();

export {
  agentEventSchema,
  agentMessageSchema,
  commandAckSchema,
  commandInputSchema,
  piAgentStateSnapshotSchema,
  promptInputSchema,
  sessionBaseSchema,
  sessionDetailSchema,
  sessionEventStreamItemSchema,
  workflowStatusSchema,
};
