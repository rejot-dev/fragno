import { z } from "zod";

import type { AgentEvent } from "@mariozechner/pi-agent-core";

import { SESSION_STATUSES, STEERING_MODES } from "./constants";
import type { PiActiveSessionProtocolMessage } from "./types";

const AGENT_LOOP_PHASES = ["waiting-for-command", "running-agent", "complete"] as const;
const COMMAND_TYPES = ["prompt", "continue", "abort", "steer", "followUp", "complete"] as const;

const sessionBaseSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  status: z.enum(SESSION_STATUSES),
  agent: z.string(),
  steeringMode: z.enum(STEERING_MODES),
  metadata: z.any().nullable(),
  tags: z.array(z.string()),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const TextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  textSignature: z.string().optional(),
});

const ThinkingContentSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  thinkingSignature: z.string().optional(),
});

const ImageContentSchema = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});

const ToolCallSchema = z.object({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  thoughtSignature: z.string().optional(),
});

const UserContentSchema = z.union([TextContentSchema, ImageContentSchema]);
const AssistantContentSchema = z.union([TextContentSchema, ThinkingContentSchema, ToolCallSchema]);
const ToolResultContentSchema = z.union([TextContentSchema, ImageContentSchema]);

const UsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  totalTokens: z.number(),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    total: z.number(),
  }),
});

const MessageSchema = z.union([
  z.object({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(UserContentSchema)]),
    timestamp: z.number(),
  }),
  z.object({
    role: z.literal("assistant"),
    content: z.array(AssistantContentSchema),
    api: z.string(),
    provider: z.string(),
    model: z.string(),
    usage: UsageSchema,
    stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]),
    errorMessage: z.string().optional(),
    timestamp: z.number(),
  }),
  z.object({
    role: z.literal("toolResult"),
    toolCallId: z.string(),
    toolName: z.string(),
    content: z.array(ToolResultContentSchema),
    details: z.unknown().optional(),
    isError: z.boolean(),
    timestamp: z.number(),
  }),
]);

const TraceSchema: z.ZodType<AgentEvent> = z.custom<AgentEvent>();

const EventSchema = z.object({
  id: z.string(),
  runNumber: z.number().nullable().optional(),
  type: z.string(),
  payload: z.unknown().nullable(),
  createdAt: z.date(),
  deliveredAt: z.date().nullable(),
  consumedByStepKey: z.string().nullable(),
});

const WaitingForSchema = z
  .union([
    z.object({
      type: z.literal("command"),
      turn: z.number(),
      stepKey: z.string(),
      allowedCommands: z.array(z.enum(COMMAND_TYPES)),
      timeoutMs: z.number().nullable(),
    }),
    z.object({
      type: z.union([z.literal("agent"), z.literal("assistant")]),
      turn: z.number(),
      operation: z.enum(["prompt", "continue"]).optional(),
      stepKey: z.string(),
    }),
  ])
  .nullable();

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

const turnOperationSchema = z.object({
  commandId: z.string(),
  turn: z.number(),
  operationIndex: z.number(),
  kind: z.enum(["prompt", "continue", "abort", "steer", "followUp"]),
  stepKey: z.string(),
  outcome: z.enum(["completed", "errored", "aborted"]),
  errorMessage: z.string().nullable(),
  createdAt: z.date(),
  completedAt: z.date().nullable(),
});

const turnSummarySchema = z.object({
  turn: z.number(),
  status: z.enum(["idle", "running", "waiting-to-continue", "aborted", "completed"]),
  assistant: z.any().nullable(),
  summary: z.string().nullable(),
  operations: z.array(turnOperationSchema),
});

const commandRecordSchema = z.object({
  commandId: z.string(),
  kind: z.enum(COMMAND_TYPES),
  turn: z.number().nullable(),
  stepKey: z.string().nullable(),
  commandStatus: z.enum(["accepted", "applied", "rejected"]),
  rejectionReason: z.string().nullable(),
  createdAt: z.date(),
  consumedAt: z.date().nullable(),
});

const sessionDetailSchema = sessionBaseSchema.extend({
  workflow: workflowStatusSchema,
  messages: z.array(MessageSchema),
  events: z.array(EventSchema),
  trace: z.array(TraceSchema),
  turn: z.number(),
  phase: z.enum(AGENT_LOOP_PHASES),
  waitingFor: WaitingForSchema,
  turns: z.array(turnSummarySchema),
  commandHistory: z.array(commandRecordSchema),
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

const activeSessionStreamItemSchema: z.ZodType<PiActiveSessionProtocolMessage> =
  z.custom<PiActiveSessionProtocolMessage>();

export {
  activeSessionStreamItemSchema,
  commandAckSchema,
  commandInputSchema,
  promptInputSchema,
  sessionBaseSchema,
  sessionDetailSchema,
  workflowStatusSchema,
};
