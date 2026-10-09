import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { automationActorsSchema } from "./automation";
import { backofficeContextScopeSchema } from "./shared/scope";

export const piAgentModelSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
});

/** Session choices accepted from callers; an omitted model selects the configured default. */
export const piAgentCreationSchema = z.object({
  name: z.string().nullable(),
  model: piAgentModelSchema.optional(),
  instructions: z.string().default(""),
  billingOrganizationId: z.string().trim().min(1).nullable().default(null),
});

/** Provisioning persists actor provenance and a concrete immutable model selection. */
export const piAgentConfigSchema = piAgentCreationSchema.extend({
  model: piAgentModelSchema,
  scope: backofficeContextScopeSchema,
  scopeRestriction: backofficeContextScopeSchema.nullable(),
  sessionId: z.string().min(1),
  actors: automationActorsSchema,
});

/** Initial agent choices are immutable; Pi owns subsequent conversation state. */
export type PiAgentConfig = z.infer<typeof piAgentConfigSchema>;

/** Directory records share the provisioning contract and use database creation time. */
export const piManagerSessionSchema = piAgentConfigSchema.extend({ createdAt: z.string() });

export type PiManagerSession = z.infer<typeof piManagerSessionSchema>;

const piRuntimeSessionOutputSchema = z.object({
  sessionId: piAgentConfigSchema.shape.sessionId,
  name: piAgentConfigSchema.shape.name,
  model: piAgentConfigSchema.shape.model,
  instructions: piAgentConfigSchema.shape.instructions,
  billingOrganizationId: piAgentConfigSchema.shape.billingOrganizationId,
});

const piRuntimeDirectorySessionOutputSchema = piRuntimeSessionOutputSchema.extend({
  createdAt: piManagerSessionSchema.shape.createdAt,
});

export type PiRuntimeDirectorySessionOutput = z.output<
  typeof piRuntimeDirectorySessionOutputSchema
>;

export const piPromptReceiptOutputSchema = z.object({
  submissionId: z.number(),
  requestId: z.string(),
});

const piSessionDetailOutputSchema = piRuntimeDirectorySessionOutputSchema.extend({
  view: z.unknown(),
});

const piPromptResultOutputSchema = piSessionDetailOutputSchema.extend({
  submission: z.unknown(),
  assistantText: z.string(),
});

export type PiRuntimeSessionOutput = z.output<typeof piRuntimeSessionOutputSchema>;

const piSessionPageOutputSchema = z.object({
  sessions: z.array(piRuntimeDirectorySessionOutputSchema),
  cursor: z.string().nullable(),
  hasNextPage: z.boolean(),
});

const promptSubmitInputSchema = z.strictObject({
  sessionId: z.string().trim().min(1),
  content: z.string().trim().min(1),
  requestId: z.string().trim().min(1).optional(),
  whenBusy: z.enum(["followUp", "steer", "reject"]).optional(),
});

const promptRunInputSchema = promptSubmitInputSchema.extend({
  timeoutMs: z.number().int().positive().optional(),
});

const sessionCreateInputSchema = z.strictObject({
  requestId: z.string().trim().min(1).max(256).optional(),
  billingOrganizationId: z.string().trim().min(1).nullable().optional(),
  instructions: z.string().optional(),
  model: piAgentModelSchema.optional(),
  name: z.string().trim().min(1).nullable().optional(),
});

const sessionListInputSchema = z.strictObject({
  cursor: z.string().trim().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});

const submissionGetInputSchema = z.strictObject({
  sessionId: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
});

export const piOperations = {
  "pi.session.create": {
    description:
      "Create a durable Pi agent in the current scoped directory. User-scoped child sessions inherit the calling Pi session or workflow's billing organization when billingOrganizationId is omitted.",
    input: sessionCreateInputSchema,
    output: piRuntimeSessionOutputSchema,
  },
  "pi.session.get": {
    description: "Get a durable Pi directory record and its conversation view.",
    input: z.strictObject({ sessionId: z.string().trim().min(1) }),
    output: piSessionDetailOutputSchema,
  },
  "pi.session.list": {
    description: "List one cursor-paginated page from the durable Pi directory.",
    input: sessionListInputSchema,
    output: piSessionPageOutputSchema,
  },
  "pi.prompt.submit": {
    description: "Durably admit a prompt and return its deduplicated submission receipt.",
    input: promptSubmitInputSchema,
    output: piPromptReceiptOutputSchema,
  },
  "pi.submission.get": {
    description: "Get the durable status of one prompt submission.",
    input: submissionGetInputSchema,
    output: z.unknown(),
  },
  "pi.prompt.run": {
    description: "Durably admit a prompt, wait for settlement, and return its conversation view.",
    input: promptRunInputSchema,
    output: piPromptResultOutputSchema,
  },
  "pi.session.abort": {
    description: "Abort active foreground and background work in a durable Pi agent.",
    input: z.strictObject({ sessionId: z.string().trim().min(1) }),
    output: z.object({ aborted: z.literal(true) }),
  },
} satisfies Record<string, BackofficeApiOperation>;
