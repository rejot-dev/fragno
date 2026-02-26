import { z } from "zod";

import { SESSION_STATUSES, STEERING_MODES } from "./constants";

const sessionBaseSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  status: z.enum(SESSION_STATUSES),
  agent: z.string(),
  workflowInstanceId: z.string().nullable(),
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

const ContentSchema = z.union([
  TextContentSchema,
  ThinkingContentSchema,
  ImageContentSchema,
  ToolCallSchema,
]);

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
    content: z.union([z.string(), z.array(ContentSchema)]),
    timestamp: z.number(),
  }),
  z.object({
    role: z.literal("assistant"),
    content: z.array(ContentSchema),
    api: z.string(),
    provider: z.string(),
    model: z.string(),
    usage: UsageSchema,
    stopReason: z.string(),
    errorMessage: z.string().optional(),
    timestamp: z.number(),
  }),
  z.object({
    role: z.literal("toolResult"),
    toolCallId: z.string(),
    toolName: z.string(),
    content: z.array(ContentSchema),
    details: z.unknown().optional(),
    isError: z.boolean(),
    timestamp: z.number(),
  }),
]);

const TraceSchema = z.object({
  type: z.string(),
  timestamp: z.number().optional(),
});

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
  trace: z.array(TraceSchema),
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

export { messageAckSchema, sessionBaseSchema, sessionDetailSchema, workflowStatusSchema };
