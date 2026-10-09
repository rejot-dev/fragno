import {
  type PiRuntimeDirectorySessionOutput,
  type PiRuntimeSessionOutput,
  piPromptReceiptOutputSchema,
} from "@fragno-dev/backoffice-api/v0/pi";
import type { PiAgentConfig, PiManagerSession } from "@fragno-dev/backoffice-api/v0/pi";

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
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

export type RegisteredPiCommandContext = { runtime: PiManagerRuntime };
type PiToolContext = BackofficeToolContext<{ pi?: PiManagerRuntime }>;

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
  ...backofficeApiOperationToolFields("pi.session.create"),
  namespace: "pi",
  name: "createSession",
  requiredPermissions: ["modify"],
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
            description:
              "Billing owner for user-scoped sessions; omitted child sessions inherit the calling Pi session or workflow's owner",
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
  ...backofficeApiOperationToolFields("pi.session.get"),
  namespace: "pi",
  name: "getSession",
  requiredPermissions: ["read"],
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
  ...backofficeApiOperationToolFields("pi.session.list"),
  namespace: "pi",
  name: "listSessions",
  requiredPermissions: ["read"],
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
  ...backofficeApiOperationToolFields("pi.prompt.submit"),
  namespace: "pi",
  name: "submitPrompt",
  requiredPermissions: ["modify"],
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
  ...backofficeApiOperationToolFields("pi.submission.get"),
  namespace: "pi",
  name: "getSubmission",
  requiredPermissions: ["read"],
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
  ...backofficeApiOperationToolFields("pi.prompt.run"),
  namespace: "pi",
  name: "runPrompt",
  requiredPermissions: ["modify"],
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
  ...backofficeApiOperationToolFields("pi.session.abort"),
  namespace: "pi",
  name: "abortSession",
  requiredPermissions: ["modify"],
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
