import {
  piPromptReceiptOutputSchema,
  type PiAgentDefinitionCreate,
  type PiAgentMessagePage,
  type PiManagerAgent,
} from "@fragno-dev/backoffice-api/v0/pi";

import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import type {
  PiManagerAgentInput,
  PiManagerPromptInput,
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
type PiToolContext = BackofficeToolContext<{
  pi?: PiManagerRuntime;
  state: BackofficeStateBackend | undefined;
}>;

function requirePiManagerRuntime(runtime: PiToolContext["runtimes"]["pi"]): PiManagerRuntime {
  if (!runtime) {
    throw new Error("PI_MANAGER_RUNTIME_UNAVAILABLE");
  }
  return runtime;
}

const parseAgentList = defineCliArgsParser<Record<string, never>>("pi.agent.list", {});
const parseAgentBackfillEvents = defineCliArgsParser<Record<string, never>>(
  "pi.agent.backfillEvents",
  {},
);
const parseAgentGet = defineCliArgsParser<PiManagerAgentInput>("pi.agent.get", {
  agentName: { option: "agent", required: true },
});
const parsePromptSubmit = defineCliArgsParser<PiManagerSubmitPromptInput>("pi.prompt.submit", {
  agentName: { option: "agent", required: true },
  content: { required: true },
  requestId: { option: "request-id" },
  whenBusy: { option: "when-busy" },
  notifyWhenDone: { option: "notify-when-done", kind: "boolean" },
  subagent: { kind: "boolean" },
});
const parsePromptGet = defineCliArgsParser<PiManagerPromptInput>("pi.prompt.get", {
  agentName: { option: "agent", required: true },
  requestId: { option: "request-id", required: true },
});
const parseAgentStop = defineCliArgsParser<PiManagerAgentInput>("pi.agent.stop", {
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
  });
}
const parseAgentDelete = defineCliArgsParser<PiManagerAgentInput>("pi.agent.delete", {
  agentName: { option: "agent", required: true },
});
const parseAgentMessages = defineCliArgsParser<{
  agentName: string;
  last?: number;
  before?: number;
  subagent?: string;
}>("pi.agent.messages", {
  agentName: { option: "agent", required: true },
  last: { kind: "positiveInteger" },
  before: { kind: "positiveInteger" },
  subagent: {},
});
const parseAgentExport = defineCliArgsParser<{ agentName: string; out: string }>(
  "pi.agent.export",
  {
    agentName: { option: "agent", required: true },
    out: { option: "output", required: true },
  },
);

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
function agentDefinition({ provisioned: _provisioned, ...definition }: PiManagerAgent) {
  return definition;
}

/** A page as a transcript to read, with how to read further back above its oldest message. */
function messagesTranscript({ messages, before }: PiAgentMessagePage) {
  const blocks = messages.map((message) =>
    message.role === "notification"
      ? `[notification · ${message.sentAt}]\n${message.notifications
          .map(({ routeId, eventId }) =>
            routeId === null ? `event ${eventId}` : `event ${eventId} via route ${routeId}`,
          )
          .join("\n")}`
      : `[${message.role} · ${message.sentAt}]\n${message.text}`,
  );
  if (before !== null) {
    blocks.unshift(`(earlier messages: --before ${before})`);
  }
  return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
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
    return agentDefinition(await requirePiManagerRuntime(context.runtimes.pi).getAgent(input));
  },
  adapters: {
    bash: {
      command: "pi.agent.get",
      help: {
        summary: "pi.agent.get retrieves an agent's definition.",
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
            name: "notify-when-done",
            description:
              "From an agent's turn: notify the calling agent with the event recording how the prompt ended",
          },
          {
            name: "subagent",
            description:
              "Run the prompt in a new conversation of the agent, beside its own, that ends once it answers",
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

const promptGetTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("pi.prompt.get"),
  namespace: "pi",
  name: "getPrompt",
  execute: async (input, context: PiToolContext) =>
    await requirePiManagerRuntime(context.runtimes.pi).getPrompt(input),
  adapters: {
    bash: {
      command: "pi.prompt.get",
      help: {
        summary:
          "pi.prompt.get tells where a prompt submitted with a request ID stands, and its answer once completed.",
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
            description: "The request ID the prompt was submitted with",
          },
        ],
        examples: ["pi.prompt.get --agent assistant --request-id triage-42"],
      },
      parse: parsePromptGet,
      format: (data) => ({ data }),
    },
  },
});

const agentStopTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("pi.agent.stop"),
  namespace: "pi",
  name: "stopAgent",
  execute: async (input, context: PiToolContext) => {
    await requirePiManagerRuntime(context.runtimes.pi).stopAgent(input);
    return { stopped: true as const };
  },
  adapters: {
    bash: {
      command: "pi.agent.stop",
      help: {
        summary: "pi.agent.stop aborts an agent's work and pauses its queue.",
        options: [
          {
            name: "agent",
            required: true,
            valueRequired: true,
            valueName: "agent-name",
            description: "Agent name",
          },
        ],
        examples: ["pi.agent.stop --agent assistant"],
      },
      parse: parseAgentStop,
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

const agentBackfillEventsTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("pi.agent.backfillEvents"),
  namespace: "pi",
  name: "backfillAgentEvents",
  execute: async (_input, context: PiToolContext) =>
    await requirePiManagerRuntime(context.runtimes.pi).backfillAgentEvents(),
  adapters: {
    bash: {
      command: "pi.agent.backfillEvents",
      help: {
        summary: "pi.agent.backfillEvents records the scope's defined agents as pi agent.* events.",
        options: [],
        examples: ["pi.agent.backfillEvents --format json"],
      },
      parse: parseAgentBackfillEvents,
      outputOptions: jsonByDefaultOutputOptions,
      format: (data) => ({ data }),
    },
  },
});

const agentMessagesTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("pi.agent.messages"),
  namespace: "pi",
  name: "listMessages",
  execute: async (input, context: PiToolContext) =>
    await requirePiManagerRuntime(context.runtimes.pi).listMessages(input),
  adapters: {
    bash: {
      command: "pi.agent.messages",
      help: {
        summary:
          "pi.agent.messages prints an agent's most recent messages, oldest first, without thinking or tool calls.",
        options: [
          {
            name: "agent",
            required: true,
            valueRequired: true,
            valueName: "agent-name",
            description: "Agent name",
          },
          {
            name: "last",
            valueRequired: true,
            valueName: "count",
            description: "How many of the most recent messages to print, up to 100; default 20",
          },
          {
            name: "before",
            valueRequired: true,
            valueName: "entry-id",
            description: "Print the messages before this one, as a previous page suggests",
          },
          {
            name: "subagent",
            valueRequired: true,
            valueName: "request-id",
            description: "Print the messages of the agent's subagent this request started",
          },
        ],
        examples: [
          "pi.agent.messages --agent assistant --last 1",
          "pi.agent.messages --agent assistant --last 50 --format json",
        ],
      },
      parse: parseAgentMessages,
      format: (data, options) =>
        options.format === "json" || options.print
          ? { data }
          : { stdout: messagesTranscript(data) },
    },
  },
});

const agentExportTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("pi.agent.export"),
  namespace: "pi",
  name: "exportConversation",
  getResource: ({ out }) => ({ path: out }),
  execute: async ({ agentName, out }, context: PiToolContext) => {
    const state = context.runtimes.state;
    if (!state) {
      throw new Error("Exporting a conversation requires the workspace filesystem.");
    }
    const jsonl = await requirePiManagerRuntime(context.runtimes.pi).exportConversation({
      agentName,
    });
    await state.writeFile(out, jsonl);
    // Every line after the header is one entry.
    return { path: out, entryCount: jsonl.split("\n").filter(Boolean).length - 1 };
  },
  adapters: {
    bash: {
      command: "pi.agent.export",
      help: {
        summary:
          "pi.agent.export writes an agent's whole conversation history, tool calls included, to a JSONL file, oldest entry first.",
        options: [
          {
            name: "agent",
            required: true,
            valueRequired: true,
            valueName: "agent-name",
            description: "Agent name",
          },
          {
            name: "output",
            required: true,
            valueRequired: true,
            valueName: "path",
            description: "Absolute path of the JSONL file to write under /workspace",
          },
        ],
        examples: ["pi.agent.export --agent assistant --output /workspace/assistant.jsonl"],
      },
      parse: parseAgentExport,
      format: (data, options) =>
        options.format === "json" || options.print
          ? { data }
          : { stdout: `Wrote ${data.entryCount} entries to ${data.path}.\n` },
    },
  },
});

export const piRuntimeTools = [
  agentListTool,
  agentGetTool,
  agentMessagesTool,
  agentExportTool,
  agentCreateTool,
  agentUpdateTool,
  agentDeleteTool,
  promptSubmitTool,
  promptGetTool,
  agentStopTool,
  agentBackfillEventsTool,
] as const;

export const piToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "pi",
  tools: piRuntimeTools,
  isAvailable: (context: PiToolContext) => !!context.runtimes.pi,
});
