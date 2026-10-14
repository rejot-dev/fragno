import { jsonValueSchema } from "@fragno-dev/backoffice-api/v0/shared/json";
import { z } from "zod";

const text = z.object({
  type: z.literal("text"),
  text: z.string().max(65_536),
  textSignature: z.string().optional(),
});
const image = z.object({
  type: z.literal("image"),
  data: z.string().max(65_536),
  mimeType: z.string(),
});
const content = z.array(z.discriminatedUnion("type", [text, image])).max(128);
const usage = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  cacheWrite1h: z.number().nonnegative().optional(),
  reasoning: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative(),
  cost: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    total: z.number().nonnegative(),
  }),
});

/** Untrusted reports must earn their native diagnostic shape before reaching the harness. */
export const piWorkspaceExtensionDiagnosticSchema = z.strictObject({
  severity: z.enum(["info", "warn", "error"]),
  message: z.string().max(65_536),
  code: z.string().max(128).optional(),
});

/** Results are data, not guest capabilities; unsupported result members fail at this boundary. */
export const piWorkspaceExtensionToolResultSchema = z.strictObject({
  content: content.optional(),
  isError: z.boolean().optional(),
  details: jsonValueSchema.optional(),
  diagnostics: z.array(piWorkspaceExtensionDiagnosticSchema).max(128).optional(),
  usage: usage.optional(),
  control: z
    .strictObject({
      addTools: z.array(z.string()).max(16).optional(),
      terminate: z.literal(true).optional(),
      handoff: z.string().max(65_536).optional(),
    })
    .optional(),
});

const userContent = z.union([z.string().max(65_536), content]);
// Request hooks may return existing transcript images/text unchanged; tool-result limits do not apply to that history.
const messageContent = z.array(
  z.discriminatedUnion("type", [
    text.extend({ text: z.string() }),
    image.extend({ data: z.string() }),
  ]),
);
const message = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("system"),
    content: z.union([z.string(), z.array(text)]),
    timestamp: z.number(),
    sections: z.record(z.string(), z.string().nullable()).optional(),
    toolsAdded: z
      .array(
        z.object({
          name: z.string(),
          description: z.string(),
          parameters: z.record(z.string(), jsonValueSchema),
          constrainedSampling: z
            .union([
              z.literal(false),
              z.object({ type: z.literal("json_schema"), strict: z.enum(["prefer", "require"]) }),
              z.object({
                type: z.literal("grammar"),
                variants: z.object({
                  openai_lark: z.string().optional(),
                  openai_regex: z.string().optional(),
                }),
              }),
            ])
            .optional(),
        }),
      )
      .optional(),
    toolsRemoved: z.array(z.object({ name: z.string() })).optional(),
  }),
  z.object({
    role: z.literal("user"),
    content: z.union([z.string(), messageContent]),
    timestamp: z.number(),
  }),
  z.object({
    role: z.literal("assistant"),
    content: z.array(
      z.discriminatedUnion("type", [
        text,
        z.object({
          type: z.literal("thinking"),
          thinking: z.string(),
          thinkingSignature: z.string().optional(),
          redacted: z.boolean().optional(),
        }),
        z.object({
          type: z.literal("toolCall"),
          id: z.string(),
          name: z.string(),
          arguments: z.record(z.string(), jsonValueSchema),
          thoughtSignature: z.string().optional(),
          namespace: z.string().optional(),
        }),
      ]),
    ),
    api: z.string(),
    provider: z.string(),
    model: z.string(),
    usage,
    stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]),
    timestamp: z.number(),
    responseModel: z.string().optional(),
    responseId: z.string().optional(),
    providerThinkingLevel: z.string().optional(),
    thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    diagnostics: z
      .array(
        z.object({
          type: z.string(),
          timestamp: z.number(),
          error: z
            .object({
              name: z.string().optional(),
              message: z.string(),
              stack: z.string().optional(),
              code: z.union([z.string(), z.number()]).optional(),
            })
            .optional(),
          details: z.record(z.string(), jsonValueSchema).optional(),
        }),
      )
      .optional(),
    deferred: z
      .object({
        provider: z.string(),
        modelId: z.string(),
        api: z.string(),
        id: z.string(),
        expiresAt: z.number().optional(),
        pollAfterMs: z.number().optional(),
        data: jsonValueSchema.optional(),
      })
      .optional(),
    errorMessage: z.string().optional(),
    rawStopReason: z.string().optional(),
    endTurn: z.boolean().optional(),
  }),
  z.object({
    role: z.literal("toolResult"),
    toolCallId: z.string(),
    toolName: z.string(),
    content: messageContent,
    nestedCalls: z
      .object({
        complete: z.boolean(),
        calls: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            arguments: z.record(z.string(), jsonValueSchema).optional(),
            argumentsBytes: z.number().nonnegative().optional(),
            status: z.enum(["ok", "error", "unfinished"]),
            durationMs: z.number().nonnegative().optional(),
            error: z.string().optional(),
          }),
        ),
      })
      .optional(),
    details: jsonValueSchema.optional(),
    usage: usage.optional(),
    isError: z.boolean(),
    timestamp: z.number(),
  }),
]);

/** Each hook retains its native return contract; null represents only a guest's undefined result. */
export const piWorkspaceExtensionHookResultSchemas = {
  beforeRequest: z.strictObject({ messages: z.array(message).max(1_000) }).nullable(),
  afterResponse: z.null(),
  onYield: z.strictObject({ continue: userContent }).nullable(),
  afterTools: z.null(),
  beforeTool: z
    .strictObject({
      arguments: z.record(z.string(), jsonValueSchema).optional(),
      block: z.string().max(65_536).optional(),
    })
    .nullable(),
  afterTool: piWorkspaceExtensionToolResultSchema.nullable(),
  beforeCompact: z
    .union([
      z.strictObject({ decline: z.literal(true) }),
      z.strictObject({ summary: z.string().max(65_536) }),
    ])
    .nullable(),
};
