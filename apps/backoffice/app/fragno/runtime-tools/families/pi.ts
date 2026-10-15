import {
  piPromptReceiptOutputSchema,
  type PiAgentDefinitionCreate,
  type PiManagerAgent,
} from "@fragno-dev/backoffice-api/v0/pi";

import type {
  PiManagerAgentInput,
  PiManagerGetSubmissionInput,
  PiManagerRunPromptInput,
  PiManagerRuntime,
  PiManagerSubmitPromptInput,
} from "@/fragno/pi/manager/pi-manager-runtime";
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

function requirePiManagerRuntime(runtime: PiToolContext["runtimes"]["pi"]): PiManagerRuntime {
  if (!runtime) {
    throw new Error("PI_MANAGER_RUNTIME_UNAVAILABLE");
  }
  return runtime;
}

const parseAgentList = defineCliArgsParser<Record<string, never>>("pi.agent.list", {});
const parseAgentGet = defineCliArgsParser<PiManagerAgentInput>("pi.agent.get", {
  agentName: { option: "agent", required: true },
});
const parsePromptSubmit = defineCliArgsParser<PiManagerSubmitPromptInput>("pi.prompt.submit", {
  agentName: { option: "agent", required: true },
  content: { required: true },
  requestId: { option: "request-id" },
  whenBusy: { option: "when-busy" },
  billingOrganizationId: { option: "billing-organization-id" },
});
const parseSubmissionGet = defineCliArgsParser<PiManagerGetSubmissionInput>("pi.submission.get", {
  agentName: { option: "agent", required: true },
  requestId: { option: "request-id", required: true },
});
const parsePromptRun = defineCliArgsParser<PiManagerRunPromptInput>("pi.prompt.run", {
  agentName: { option: "agent", required: true },
  content: { required: true },
  requestId: { option: "request-id" },
  whenBusy: { option: "when-busy" },
  billingOrganizationId: { option: "billing-organization-id" },
  timeoutMs: { option: "timeout-ms", kind: "integer" },
});
const parseAgentAbort = defineCliArgsParser<PiManagerAgentInput>("pi.agent.abort", {
  agentName: { option: "agent", required: true },
});
function definitionArgsParser(command: string) {
  return defineCliArgsParser<PiAgentDefinitionCreate>(command, {
    agentName: { option: "agent", required: true },
    description: { required: true },
    instructions: { defaultValue: "" },
    // Turns already run with the prompter's permissions, so the default narrows nothing.
    permissions: { option: "permission", kind: "stringArray", defaultValue: ["*"] },
    model: { defaultValue: null },
    managedBy: { kind: "json", defaultValue: null },
  });
}
const parseAgentDelete = defineCliArgsParser<PiManagerAgentInput>("pi.agent.delete", {
  agentName: { option: "agent", required: true },
});

const definitionOptions = [
  {
    name: "agent",
    required: true,
    valueRequired: true,
    valueName: "agent-name",
    description: "Agent name: lowercase letters, digits, and hyphens",
  },
  {
    name: "description",
    required: true,
    valueRequired: true,
    valueName: "text",
    description: "What the agent is for, shown when choosing an agent",
  },
  {
    name: "instructions",
    valueRequired: true,
    valueName: "markdown",
    description: "Guidance added to the agent's system prompt; omitted adds none",
  },
  {
    name: "permission",
    valueRequired: true,
    valueName: "grant",
    description:
      "Repeatable: *, namespace.*, or namespace.permission to limit the agent; omitted grants *",
  },
  {
    name: "model",
    valueRequired: true,
    valueName: "provider/model-id",
    description: "Model to use; omitted selects the preferred available model",
  },
  {
    name: "managed-by",
    valueRequired: true,
    valueName: "json",
    description: "Marketplace ownership, set by package installers",
  },
];

/** The scope configuration an agent runs with; its conversation's provisioning stays internal. */
function agentDefinition({ provisioning: _provisioning, ...definition }: PiManagerAgent) {
  return definition;
}

function jsonByDefaultOutputOptions(args: string[]) {
  const parsed = parseCliTokens(args);
  const output = readOutputOptions(parsed);
  return output.print || parsed.options.has("format")
    ? output
    : { ...output, format: "json" as const };
}

const agentListTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("pi.agent.list"),
  namespace: "pi",
  name: "listAgents",
  execute: async (_input, context: PiToolContext) => {
    const directory = await requirePiManagerRuntime(context.runtimes.pi).listAgents();
    return { agents: directory.agents.map(agentDefinition) };
  },
  adapters: {
    bash: {
      command: "pi.agent.list",
      help: {
        summary: "pi.agent.list lists the agents defined for the current scope.",
        options: [],
        examples: ["pi.agent.list --format json"],
      },
      parse: parseAgentList,
      outputOptions: jsonByDefaultOutputOptions,
      format: (data) => ({ data }),
    },
  },
});

const agentGetTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("pi.agent.get"),
  namespace: "pi",
  name: "getAgent",
  execute: async (input, context: PiToolContext) => {
    const { view, ...agent } = await requirePiManagerRuntime(context.runtimes.pi).getAgent(input);
    return { ...agentDefinition(agent), view: normalizeRuntimeOutput(view) };
  },
  adapters: {
    bash: {
      command: "pi.agent.get",
      help: {
        summary: "pi.agent.get retrieves an agent and its durable conversation view.",
        options: [
          {
            name: "agent",
            required: true,
            valueRequired: true,
            valueName: "agent-name",
            description: "Agent name",
          },
        ],
        examples: ["pi.agent.get --agent assistant --format json"],
      },
      parse: parseAgentGet,
      format: (data) => ({ data }),
    },
  },
});

const promptSubmitTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("pi.prompt.submit"),
  namespace: "pi",
  name: "submitPrompt",
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
            name: "agent",
            required: true,
            valueRequired: true,
            valueName: "agent-name",
            description: "Agent name",
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
            description:
              "followUp (default) waits for the current turn, steer joins it, reject refuses",
          },
          {
            name: "billing-organization-id",
            valueRequired: true,
            valueName: "organization-id",
            description:
              "Billing owner chosen by a user-scoped agent's first turn; omitted inherits the calling Pi agent or workflow's owner",
          },
        ],
        examples: ['pi.prompt.submit --agent assistant --content "Investigate the failure"'],
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
            name: "agent",
            required: true,
            valueRequired: true,
            valueName: "agent-name",
            description: "Agent name",
          },
          {
            name: "request-id",
            required: true,
            valueRequired: true,
            valueName: "request-id",
            description: "Prompt request id",
          },
        ],
        examples: ["pi.submission.get --agent assistant --request-id request-456"],
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
  execute: async (input, context: PiToolContext) => {
    const result = await requirePiManagerRuntime(context.runtimes.pi).runPrompt(input);
    return {
      agentName: result.agentName,
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
            name: "agent",
            required: true,
            valueRequired: true,
            valueName: "agent-name",
            description: "Agent name",
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
            description:
              "followUp (default) waits for the current turn, steer joins it, reject refuses",
          },
          {
            name: "billing-organization-id",
            valueRequired: true,
            valueName: "organization-id",
            description:
              "Billing owner chosen by a user-scoped agent's first turn; omitted inherits the calling Pi agent or workflow's owner",
          },
          {
            name: "timeout-ms",
            valueRequired: true,
            valueName: "milliseconds",
            description: "Maximum wait; admitted work continues after timeout",
          },
        ],
        examples: [
          'pi.prompt.run --agent assistant --content "Summarize your findings" --print assistantText',
        ],
      },
      parse: parsePromptRun,
      outputOptions: jsonByDefaultOutputOptions,
      format: (data) => ({ data }),
    },
  },
});

const agentAbortTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("pi.agent.abort"),
  namespace: "pi",
  name: "abortAgent",
  execute: async (input, context: PiToolContext) => {
    await requirePiManagerRuntime(context.runtimes.pi).abortAgent(input);
    return { aborted: true as const };
  },
  adapters: {
    bash: {
      command: "pi.agent.abort",
      help: {
        summary: "pi.agent.abort cancels an agent's active work.",
        options: [
          {
            name: "agent",
            required: true,
            valueRequired: true,
            valueName: "agent-name",
            description: "Agent name",
          },
        ],
        examples: ["pi.agent.abort --agent assistant"],
      },
      parse: parseAgentAbort,
      format: (data) => ({ data }),
    },
  },
});

const agentCreateTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("pi.agent.create"),
  namespace: "pi",
  name: "createAgent",
  execute: async (input, context: PiToolContext) =>
    await requirePiManagerRuntime(context.runtimes.pi).createAgent(input),
  adapters: {
    bash: {
      command: "pi.agent.create",
      help: {
        summary: "pi.agent.create defines an agent in the current scope.",
        options: definitionOptions,
        examples: [
          'pi.agent.create --agent reviewer --description "Reviews changes" --instructions "Report problems before suggesting fixes." --permission upload.read',
        ],
      },
      parse: definitionArgsParser("pi.agent.create"),
      format: (data) => ({ data }),
    },
  },
});

const agentUpdateTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("pi.agent.update"),
  namespace: "pi",
  name: "updateAgent",
  execute: async (input, context: PiToolContext) =>
    await requirePiManagerRuntime(context.runtimes.pi).updateAgent(input),
  adapters: {
    bash: {
      command: "pi.agent.update",
      help: {
        summary: "pi.agent.update replaces an agent's whole definition.",
        options: definitionOptions,
        examples: [
          'pi.agent.update --agent reviewer --description "Reviews and fixes changes" --instructions "Fix the problems you find." --permission "*"',
        ],
      },
      parse: definitionArgsParser("pi.agent.update"),
      format: (data) => ({ data }),
    },
  },
});

const agentDeleteTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("pi.agent.delete"),
  namespace: "pi",
  name: "deleteAgent",
  execute: async (input, context: PiToolContext) => {
    await requirePiManagerRuntime(context.runtimes.pi).deleteAgent(input);
    return { deleted: true as const };
  },
  adapters: {
    bash: {
      command: "pi.agent.delete",
      help: {
        summary: "pi.agent.delete removes an agent's definition and keeps its conversation.",
        options: [
          {
            name: "agent",
            required: true,
            valueRequired: true,
            valueName: "agent-name",
            description: "Agent name",
          },
        ],
        examples: ["pi.agent.delete --agent reviewer"],
      },
      parse: parseAgentDelete,
      format: () => ({ stdout: "Deleted agent definition.\n" }),
    },
  },
});

export const piRuntimeTools = [
  agentListTool,
  agentGetTool,
  agentCreateTool,
  agentUpdateTool,
  agentDeleteTool,
  promptSubmitTool,
  submissionGetTool,
  promptRunTool,
  agentAbortTool,
] as const;

export const piToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "pi",
  tools: piRuntimeTools,
  isAvailable: (context: PiToolContext) => !!context.runtimes.pi,
});
