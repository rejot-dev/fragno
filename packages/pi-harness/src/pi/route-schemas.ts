import { z } from "zod";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { PiHarnessFrontendAgentMessage } from "./harness/agent-harness-event-protocol";
import {
  MAX_PI_COMMAND_IMAGE_DATA_LENGTH,
  type PiSessionCommandPayload,
  type PiWorkflowStatus,
} from "./types";

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
  metadata: z.record(z.string(), z.unknown()).nullable(),
  workflowName: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const ImageContentSchema = z.object({
  type: z.literal("image"),
  data: z.base64().min(1),
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
  messages: z.array(z.unknown() as z.ZodType<PiHarnessFrontendAgentMessage>),
});

const sessionDetailSchema = sessionBaseSchema.extend({
  workflow: workflowStatusSchema,
  agent: z.object({
    state: piAgentStateSnapshotSchema,
  }),
});

const promptInputSchema = z.object({
  text: z.string(),
  images: z
    .array(ImageContentSchema)
    .refine(
      (images) =>
        images.reduce((totalLength, image) => totalLength + image.data.length, 0) <=
        MAX_PI_COMMAND_IMAGE_DATA_LENGTH,
      { message: "Image data exceeds the command persistence limit." },
    )
    .optional(),
});

const commandInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prompt"), input: promptInputSchema }),
  z.object({
    kind: z.literal("skill"),
    input: z.object({ name: z.string(), additionalInstructions: z.string().optional() }),
  }),
  z.object({
    kind: z.literal("promptFromTemplate"),
    input: z.object({ name: z.string(), args: z.array(z.string()).optional() }),
  }),
  z.object({
    kind: z.literal("compact"),
    input: z.object({ customInstructions: z.string().optional() }),
  }),
  z.object({ kind: z.literal("abort"), reason: z.string().optional() }),
  z.object({ kind: z.literal("steer"), input: promptInputSchema }),
  z.object({ kind: z.literal("followUp"), input: promptInputSchema }),
]);

const piSessionCommandPayloadSchema: z.ZodType<PiSessionCommandPayload> = z.discriminatedUnion(
  "kind",
  [
    z.object({ commandId: z.string(), kind: z.literal("prompt"), input: promptInputSchema }),
    z.object({
      commandId: z.string(),
      kind: z.literal("skill"),
      input: z.object({ name: z.string(), additionalInstructions: z.string().optional() }),
    }),
    z.object({
      commandId: z.string(),
      kind: z.literal("promptFromTemplate"),
      input: z.object({ name: z.string(), args: z.array(z.string()).optional() }),
    }),
    z.object({
      commandId: z.string(),
      kind: z.literal("compact"),
      input: z.object({ customInstructions: z.string().optional() }),
    }),
    z.object({ commandId: z.string(), kind: z.literal("abort"), reason: z.string().optional() }),
    z.object({ commandId: z.string(), kind: z.literal("steer"), input: promptInputSchema }),
    z.object({ commandId: z.string(), kind: z.literal("followUp"), input: promptInputSchema }),
  ],
);

const commandAckSchema = z.object({
  accepted: z.literal(true),
  commandId: z.string(),
  status: workflowStatusValueSchema,
});

export {
  agentMessageSchema,
  commandAckSchema,
  commandInputSchema,
  piSessionCommandPayloadSchema,
  sessionBaseSchema,
  sessionDetailSchema,
};
