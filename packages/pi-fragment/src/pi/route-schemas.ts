import { z } from "zod";

import type { AgentEvent } from "@mariozechner/pi-agent-core";

import { SESSION_STATUSES, STEERING_MODES } from "./constants";
import type { PiActiveSessionProtocolMessage } from "./types";

const AGENT_LOOP_PHASES = ["waiting-for-user", "running-agent", "complete"] as const;

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

// Per-role content unions matching the actual AgentMessage types from @mariozechner/pi-ai:
// - UserMessage.content:      string | (TextContent | ImageContent)[]
// - AssistantMessage.content: (TextContent | ThinkingContent | ToolCall)[]
// - ToolResultMessage.content:(TextContent | ImageContent)[]
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

// AgentEvent is a discriminated union that recursively contains AgentMessage[],
// making a full structural Zod schema impractical.
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
      type: z.literal("user_message"),
      turn: z.number(),
      stepKey: z.string(),
      timeoutMs: z.number().nullable(),
    }),
    z.object({
      type: z.literal("assistant"),
      turn: z.number(),
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

const sessionDetailSchema = sessionBaseSchema.extend({
  workflow: workflowStatusSchema,
  messages: z.array(MessageSchema),
  events: z.array(EventSchema),
  trace: z.array(TraceSchema),
  turn: z.number(),
  phase: z.enum(AGENT_LOOP_PHASES),
  waitingFor: WaitingForSchema,
  summaries: z.array(
    z.object({
      turn: z.number(),
      assistant: z.any().nullable(),
      summary: z.string().nullable(),
    }),
  ),
});

const messageAckSchema = z.object({
  status: z.enum(SESSION_STATUSES),
});

const activeSessionStreamItemSchema: z.ZodType<PiActiveSessionProtocolMessage> =
  z.custom<PiActiveSessionProtocolMessage>();

export {
  activeSessionStreamItemSchema,
  messageAckSchema,
  sessionBaseSchema,
  sessionDetailSchema,
  workflowStatusSchema,
};
