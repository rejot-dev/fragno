import { z } from "zod";

import {
  piAgentConfigSchema,
  piManagerSessionSchema,
  type PiAgentConfig,
  type PiManagerSession,
} from "@/fragno/pi-manager/pi-agent-contract";
import type {
  PiManagerAbortSessionInput,
  PiManagerCreateSessionInput,
  PiManagerGetSessionInput,
  PiManagerGetSubmissionInput,
  PiManagerListSessionsInput,
  PiManagerRunPromptInput,
  PiManagerRuntime,
  PiManagerSubmitPromptInput,
} from "@/fragno/pi-manager/pi-manager-runtime";
import {
  defineCliArgsParser,
  parseCliTokens,
  readOutputOptions,
} from "@/fragno/runtime-tools/bash-cli";

import { normalizeRuntimeOutput } from "../output-schemas";
import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

export type RegisteredPiCommandContext = { runtime: PiManagerRuntime };
type PiToolContext = BackofficeToolContext<{ pi?: PiManagerRuntime }>;

const piAgentModelSchema = piAgentConfigSchema.shape.model;
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
const piSessionDetailOutputSchema = piRuntimeDirectorySessionOutputSchema.extend({
  view: z.unknown(),
});
const piSessionPageOutputSchema = z.object({
  sessions: z.array(piRuntimeDirectorySessionOutputSchema),
  cursor: z.string().nullable(),
  hasNextPage: z.boolean(),
});
const piPromptReceiptOutputSchema = z.object({
  submissionId: z.number(),
  requestId: z.string(),
});
const piPromptResultOutputSchema = piSessionDetailOutputSchema.extend({
  submission: z.unknown(),
  assistantText: z.string(),
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
const promptSubmitInputSchema = z.strictObject({
  sessionId: z.string().trim().min(1),
  content: z.string().trim().min(1),
  requestId: z.string().trim().min(1).optional(),
  whenBusy: z.enum(["followUp", "steer", "reject"]).optional(),
});
const submissionGetInputSchema = z.strictObject({
  sessionId: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
});
const promptRunInputSchema = promptSubmitInputSchema.extend({
  timeoutMs: z.number().int().positive().optional(),
});

type PiRuntimeSessionOutput = z.output<typeof piRuntimeSessionOutputSchema>;
type PiRuntimeDirectorySessionOutput = z.output<typeof piRuntimeDirectorySessionOutputSchema>;

function serializePiRuntimeSession(session: PiAgentConfig): PiRuntimeSessionOutput {
  return {
    sessionId: session.sessionId,
    name: session.name,
    model: session.model,
    instructions: session.instructions,
    billingOrganizationId: session.billingOrganizationId,
  };
}

function serializePiRuntimeDirectorySession(
  session: PiManagerSession,
): PiRuntimeDirectorySessionOutput {
  return {
    ...serializePiRuntimeSession(session),
    createdAt: session.createdAt,
  };
}

function requirePiManagerRuntime(runtime: PiToolContext["runtimes"]["pi"]): PiManagerRuntime {
  if (!runtime) {
    throw new Error("PI_MANAGER_RUNTIME_UNAVAILABLE");
  }
  return runtime;
}

const parseSessionCreate = defineCliArgsParser<PiManagerCreateSessionInput>("pi.session.create", {
  requestId: { option: "request-id" },
  billingOrganizationId: { option: "billing-organization-id" },
  instructions: {},
  model: { kind: "json", option: "model-json" },
  name: {},
});
const parseSessionGet = defineCliArgsParser<PiManagerGetSessionInput>("pi.session.get", {
  sessionId: { required: true },
});
const parseSessionList = defineCliArgsParser<PiManagerListSessionsInput>("pi.session.list", {
  cursor: {},
  pageSize: { option: "page-size", kind: "integer" },
});
const parsePromptSubmit = defineCliArgsParser<PiManagerSubmitPromptInput>("pi.prompt.submit", {
  sessionId: { required: true },
  content: { required: true },
  requestId: { option: "request-id" },
  whenBusy: { option: "when-busy" },
});
const parseSubmissionGet = defineCliArgsParser<PiManagerGetSubmissionInput>("pi.submission.get", {
  sessionId: { required: true },
  requestId: { option: "request-id", required: true },
});
const parsePromptRun = defineCliArgsParser<PiManagerRunPromptInput>("pi.prompt.run", {
  sessionId: { required: true },
  content: { required: true },
  requestId: { option: "request-id" },
  whenBusy: { option: "when-busy" },
  timeoutMs: { option: "timeout-ms", kind: "integer" },
});
const parseSessionAbort = defineCliArgsParser<PiManagerAbortSessionInput>("pi.session.abort", {
  sessionId: { required: true },
});

function jsonByDefaultOutputOptions(args: string[]) {
  const parsed = parseCliTokens(args);
  const output = readOutputOptions(parsed);
  return output.print || parsed.options.has("format")
    ? output
    : { ...output, format: "json" as const };
}

const sessionCreateTool = defineBackofficeRuntimeTool({
  id: "pi.session.create",
  namespace: "pi",
  name: "createSession",
  description: "Create a durable Pi agent in the current scoped directory.",
  requiredPermissions: ["modify"],
  inputSchema: sessionCreateInputSchema,
  outputSchema: piRuntimeSessionOutputSchema,
  execute: async (input, context: PiToolContext) => {
    const session = await requirePiManagerRuntime(context.runtimes.pi).createSession(input);
    return serializePiRuntimeSession(session);
  },
  adapters: {
    bash: {
      command: "pi.session.create",
      help: {
        summary: "pi.session.create creates a durable Pi agent in the current scope.",
        options: [
          {
            name: "request-id",
            valueRequired: true,
            valueName: "request-id",
            description: "Stable idempotency key for replay-safe creation",
          },
          {
            name: "model-json",
            valueRequired: true,
            valueName: "json",
            description:
              'Optional durable model selection, for example {"provider":"openai","modelId":"gpt-6-luna"}. Omitting it uses the configured default.',
          },
          { name: "name", valueRequired: true, valueName: "name", description: "Session name" },
          {
            name: "instructions",
            valueRequired: true,
            valueName: "text",
            description: "Session-specific agent instructions",
          },
          {
            name: "billing-organization-id",
            valueRequired: true,
            valueName: "organization-id",
            description: "Billing owner required for user-scoped sessions",
          },
        ],
        examples: [
          `pi.session.create --request-id workflow-123:create-research-agent --name research --model-json '${JSON.stringify({ provider: "openai", modelId: "gpt-6-luna" })}'`,
        ],
      },
      parse: parseSessionCreate,
      format: (data) => ({ data }),
    },
  },
});

const sessionGetTool = defineBackofficeRuntimeTool({
  id: "pi.session.get",
  namespace: "pi",
  name: "getSession",
  description: "Get a durable Pi directory record and its conversation view.",
  requiredPermissions: ["read"],
  inputSchema: z.strictObject({ sessionId: z.string().trim().min(1) }),
  outputSchema: piSessionDetailOutputSchema,
  execute: async (input, context: PiToolContext) => {
    const session = await requirePiManagerRuntime(context.runtimes.pi).getSession(input);
    return {
      ...serializePiRuntimeDirectorySession(session),
      view: normalizeRuntimeOutput(session.view),
    };
  },
  adapters: {
    bash: {
      command: "pi.session.get",
      help: {
        summary: "pi.session.get retrieves a durable Pi session and conversation view.",
        options: [
          {
            name: "session-id",
            required: true,
            valueRequired: true,
            valueName: "session-id",
            description: "Durable Pi session id",
          },
        ],
        examples: ["pi.session.get --session-id session-123 --format json"],
      },
      parse: parseSessionGet,
      format: (data) => ({ data }),
    },
  },
});

const sessionListTool = defineBackofficeRuntimeTool({
  id: "pi.session.list",
  namespace: "pi",
  name: "listSessions",
  description: "List one cursor-paginated page from the durable Pi directory.",
  requiredPermissions: ["read"],
  inputSchema: sessionListInputSchema,
  outputSchema: piSessionPageOutputSchema,
  execute: async (input, context: PiToolContext) => {
    const page = await requirePiManagerRuntime(context.runtimes.pi).listSessions(input);
    return {
      sessions: page.sessions.map(serializePiRuntimeDirectorySession),
      cursor: page.cursor,
      hasNextPage: page.hasNextPage,
    };
  },
  adapters: {
    bash: {
      command: "pi.session.list",
      help: {
        summary: "pi.session.list lists a page of durable Pi sessions.",
        options: [
          { name: "cursor", valueRequired: true, valueName: "cursor", description: "Page cursor" },
          {
            name: "page-size",
            valueRequired: true,
            valueName: "count",
            description: "Page size from 1 to 100",
          },
        ],
        examples: ["pi.session.list --page-size 10 --format json"],
      },
      parse: parseSessionList,
      outputOptions: jsonByDefaultOutputOptions,
      format: (data) => ({ data }),
    },
  },
});

const promptSubmitTool = defineBackofficeRuntimeTool({
  id: "pi.prompt.submit",
  namespace: "pi",
  name: "submitPrompt",
  description: "Durably admit a prompt and return its deduplicated submission receipt.",
  requiredPermissions: ["modify"],
  inputSchema: promptSubmitInputSchema,
  outputSchema: piPromptReceiptOutputSchema,
  execute: async (input, context: PiToolContext) => {
    return piPromptReceiptOutputSchema.parse(
      normalizeRuntimeOutput(
        await requirePiManagerRuntime(context.runtimes.pi).submitPrompt(input),
      ),
    );
  },
  adapters: {
    bash: {
      command: "pi.prompt.submit",
      help: {
        summary: "pi.prompt.submit admits durable agent work without waiting for completion.",
        options: [
          {
            name: "session-id",
            required: true,
            valueRequired: true,
            valueName: "session-id",
            description: "Durable Pi session id",
          },
          {
            name: "content",
            required: true,
            valueRequired: true,
            valueName: "text",
            description: "Prompt content",
          },
          {
            name: "request-id",
            valueRequired: true,
            valueName: "request-id",
            description: "Optional deduplication key",
          },
          {
            name: "when-busy",
            valueRequired: true,
            valueName: "mode",
            description: "followUp, steer, or reject",
          },
        ],
        examples: ['pi.prompt.submit --session-id session-123 --content "Investigate the failure"'],
      },
      parse: parsePromptSubmit,
      format: (data) => ({ data }),
    },
  },
});

const submissionGetTool = defineBackofficeRuntimeTool({
  id: "pi.submission.get",
  namespace: "pi",
  name: "getSubmission",
  description: "Get the durable status of one prompt submission.",
  requiredPermissions: ["read"],
  inputSchema: submissionGetInputSchema,
  outputSchema: z.unknown(),
  execute: async (input, context: PiToolContext) => {
    return normalizeRuntimeOutput(
      await requirePiManagerRuntime(context.runtimes.pi).getSubmission(input),
    );
  },
  adapters: {
    bash: {
      command: "pi.submission.get",
      help: {
        summary: "pi.submission.get reads one durable prompt submission.",
        options: [
          {
            name: "session-id",
            required: true,
            valueRequired: true,
            valueName: "session-id",
            description: "Durable Pi session id",
          },
          {
            name: "request-id",
            required: true,
            valueRequired: true,
            valueName: "request-id",
            description: "Prompt request id",
          },
        ],
        examples: ["pi.submission.get --session-id session-123 --request-id request-456"],
      },
      parse: parseSubmissionGet,
      format: (data) => ({ data }),
    },
  },
});

const promptRunTool = defineBackofficeRuntimeTool({
  id: "pi.prompt.run",
  namespace: "pi",
  name: "runPrompt",
  description: "Durably admit a prompt, wait for settlement, and return its conversation view.",
  requiredPermissions: ["modify"],
  inputSchema: promptRunInputSchema,
  outputSchema: piPromptResultOutputSchema,
  execute: async (input, context: PiToolContext) => {
    const result = await requirePiManagerRuntime(context.runtimes.pi).runPrompt(input);
    return {
      ...serializePiRuntimeDirectorySession(result),
      view: normalizeRuntimeOutput(result.view),
      submission: normalizeRuntimeOutput(result.submission),
      assistantText: result.assistantText,
    };
  },
  adapters: {
    bash: {
      command: "pi.prompt.run",
      help: {
        summary: "pi.prompt.run admits a prompt and waits for its durable submission to settle.",
        options: [
          {
            name: "session-id",
            required: true,
            valueRequired: true,
            valueName: "session-id",
            description: "Durable Pi session id",
          },
          {
            name: "content",
            required: true,
            valueRequired: true,
            valueName: "text",
            description: "Prompt content",
          },
          {
            name: "request-id",
            valueRequired: true,
            valueName: "request-id",
            description: "Optional deduplication key",
          },
          {
            name: "when-busy",
            valueRequired: true,
            valueName: "mode",
            description: "followUp, steer, or reject",
          },
          {
            name: "timeout-ms",
            valueRequired: true,
            valueName: "milliseconds",
            description: "Maximum wait; admitted work continues after timeout",
          },
        ],
        examples: [
          'pi.prompt.run --session-id session-123 --content "Summarize your findings" --print assistantText',
        ],
      },
      parse: parsePromptRun,
      outputOptions: jsonByDefaultOutputOptions,
      format: (data) => ({ data }),
    },
  },
});

const sessionAbortTool = defineBackofficeRuntimeTool({
  id: "pi.session.abort",
  namespace: "pi",
  name: "abortSession",
  description: "Abort active foreground and background work in a durable Pi agent.",
  requiredPermissions: ["modify"],
  inputSchema: z.strictObject({ sessionId: z.string().trim().min(1) }),
  outputSchema: z.object({ aborted: z.literal(true) }),
  execute: async (input, context: PiToolContext) => {
    await requirePiManagerRuntime(context.runtimes.pi).abortSession(input);
    return { aborted: true as const };
  },
  adapters: {
    bash: {
      command: "pi.session.abort",
      help: {
        summary: "pi.session.abort cancels active work in a durable Pi agent.",
        options: [
          {
            name: "session-id",
            required: true,
            valueRequired: true,
            valueName: "session-id",
            description: "Durable Pi session id",
          },
        ],
        examples: ["pi.session.abort --session-id session-123"],
      },
      parse: parseSessionAbort,
      format: (data) => ({ data }),
    },
  },
});

export const piRuntimeTools = [
  sessionCreateTool,
  sessionGetTool,
  sessionListTool,
  promptSubmitTool,
  submissionGetTool,
  promptRunTool,
  sessionAbortTool,
] as const;

export const piToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "pi",
  permissions: {
    read: "Read durable Pi sessions and submissions.",
    modify: "Create durable Pi sessions, submit prompts, and abort active work.",
  },
  tools: piRuntimeTools,
  isAvailable: (context: PiToolContext) => !!context.runtimes.pi,
});
