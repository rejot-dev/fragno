import type { WorkflowDuration, WorkflowStep } from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import type { AgentHarness, AgentTool, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";

import type { PiHarnessHooksMap } from "../definition";
import type { PiSessionCommandPayload, PiToolDefinition } from "../types";
import {
  createPiHarnessSessionState,
  runPiHarnessStep,
  type PiHarnessAgentOptions,
  type PiHarnessInternalOptions,
  type PiHarnessOperation,
  type PiHarnessSessionStepState,
} from "./run-pi-harness-step";

type AgentLoopToolsInput = readonly AgentTool[];

type AgentToolDetails<TTool> =
  TTool extends PiToolDefinition<infer _Params, infer TDetails> ? TDetails : unknown;

type AgentToolName<TTool> = TTool extends { name: infer TName extends string } ? TName : string;

export type AgentLoopMessage<TTools extends AgentLoopToolsInput = AgentLoopToolsInput> =
  | Exclude<Message, { role: "toolResult" }>
  | (ToolResultMessage<AgentToolDetails<TTools[number]>> & {
      toolName: AgentToolName<TTools[number]>;
      details: AgentToolDetails<TTools[number]>;
    });

export type WaitForPiCommandOptions = {
  timeout?: WorkflowDuration;
};

export type AgentLoopOptions<TTools extends AgentLoopToolsInput = AgentLoopToolsInput> = Omit<
  PiHarnessAgentOptions<TTools[number]>,
  "tools" | "activeToolNames"
> & {
  workflowName: string;
  sessionId: string;
  agentName: string;
  actor?: unknown;
  tools?: TTools;
  initialMessages?: Parameters<typeof createPiHarnessSessionState>[0];
  commandTimeout?: WorkflowDuration;
};

export type AgentLoopStepOptions<TTools extends AgentLoopToolsInput = AgentLoopToolsInput> =
  Partial<Omit<PiHarnessAgentOptions<TTools[number]>, "tools" | "activeToolNames">> & {
    activeToolNames?: readonly AgentToolName<TTools[number]>[];
  };

export type AgentLoopCommandOptions<TTools extends AgentLoopToolsInput = AgentLoopToolsInput> =
  AgentLoopStepOptions<TTools> & {
    stopOnTools?: readonly string[];
  };

export type AgentLoopCommandResult<TTools extends AgentLoopToolsInput = AgentLoopToolsInput> =
  | {
      kind: "agentRun";
      command: PiSessionCommandPayload;
      message: AgentLoopMessage<TTools> | undefined;
    }
  | { kind: "ignored"; command: PiSessionCommandPayload };

export type AgentLoopInternalOptions = PiHarnessInternalOptions;

export type AgentLoop<TTools extends AgentLoopToolsInput = AgentLoopToolsInput> = {
  runStep: (
    name: string,
    operation: PiHarnessOperation,
    options?: AgentLoopStepOptions<TTools>,
  ) => Promise<AgentLoopMessage<TTools> | undefined>;
  executeCommandAndRunStep: (
    command: PiSessionCommandPayload,
    options?: AgentLoopCommandOptions<TTools>,
  ) => Promise<AgentLoopCommandResult<TTools>>;
  waitForCommand: (options?: WaitForPiCommandOptions) => Promise<PiSessionCommandPayload>;
  waitForCommandAndRunStep: (
    options?: AgentLoopCommandOptions<TTools>,
  ) => Promise<AgentLoopCommandResult<TTools>>;
  summary: () => { entryCount: number; leafId: string | null };
  getState: () => PiHarnessSessionStepState;
};

const promptInputSchema = z.object({
  text: z.string(),
  images: z
    .array(z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }))
    .optional(),
});

export const piSessionCommandPayloadSchema: z.ZodType<PiSessionCommandPayload> =
  z.discriminatedUnion("kind", [
    z.object({ commandId: z.string(), kind: z.literal("prompt"), input: promptInputSchema }),
    z.object({ commandId: z.string(), kind: z.literal("abort"), reason: z.string().optional() }),
    z.object({ commandId: z.string(), kind: z.literal("steer"), input: promptInputSchema }),
    z.object({ commandId: z.string(), kind: z.literal("followUp"), input: promptInputSchema }),
    z.object({ commandId: z.string(), kind: z.literal("nextTurn"), input: promptInputSchema }),
  ]);

export const waitForPiCommand = async (
  step: WorkflowStep,
  name = "command",
  options: WaitForPiCommandOptions = {},
): Promise<PiSessionCommandPayload> => {
  const event = await step.waitForEvent<unknown>(name, {
    type: "command",
    timeout: options.timeout,
  });

  return piSessionCommandPayloadSchema.parse(event.payload);
};

const waitStepName = (commandIndex: number): string => `wait-command-${commandIndex}`;
const commandStepName = (command: PiSessionCommandPayload): string =>
  `command:${command.commandId}`;

const mergeSessionEntries = (
  committedEntries: readonly SessionTreeEntry[],
  appendedEntries: readonly SessionTreeEntry[],
): SessionTreeEntry[] => {
  const entries = [...committedEntries];
  const indexesById = new Map(entries.map((entry, index) => [entry.id, index]));

  for (const entry of appendedEntries) {
    const existingIndex = indexesById.get(entry.id);
    if (existingIndex === undefined) {
      indexesById.set(entry.id, entries.length);
      entries.push(entry);
    } else {
      entries[existingIndex] = entry;
    }
  }

  return entries;
};

const messagesFromEntries = <TTools extends AgentLoopToolsInput>(
  entries: readonly SessionTreeEntry[],
): AgentLoopMessage<TTools>[] =>
  entries.flatMap((entry) => {
    if (entry.type !== "message") {
      return [];
    }

    switch (entry.message.role) {
      case "user":
      case "assistant":
      case "toolResult":
        return [entry.message as AgentLoopMessage<TTools>];
      case "bashExecution":
      case "branchSummary":
      case "compactionSummary":
      case "custom":
        return [];
    }

    return [];
  });

const promptArgsFromCommand = (
  command: Extract<PiSessionCommandPayload, { kind: "prompt" | "followUp" | "steer" | "nextTurn" }>,
): Parameters<AgentHarness["prompt"]> =>
  command.input.images
    ? [command.input.text, { images: command.input.images }]
    : [command.input.text];

const operationFromCommand = (command: PiSessionCommandPayload): PiHarnessOperation | undefined => {
  switch (command.kind) {
    case "prompt":
    case "followUp":
    case "steer":
    case "nextTurn":
      return { kind: "prompt", args: promptArgsFromCommand(command) };
    case "abort":
      return undefined;
  }

  return undefined;
};

export const createAgentLoop = <TTools extends AgentLoopToolsInput = AgentLoopToolsInput>(
  step: WorkflowStep<PiHarnessHooksMap>,
  options: AgentLoopOptions<TTools>,
  internalOptions: AgentLoopInternalOptions = {},
): AgentLoop<TTools> => {
  let commandIndex = 0;
  let state = createPiHarnessSessionState(options.initialMessages);

  const summary = () => ({ entryCount: state.entries.length, leafId: state.leafId });

  const runStep: AgentLoop<TTools>["runStep"] = async (name, operation, runOptions = {}) => {
    const {
      workflowName,
      sessionId,
      agentName,
      actor,
      initialMessages: _initialMessages,
      commandTimeout: _commandTimeout,
      ...defaultHarnessOptions
    } = options;
    const runHarnessOptions = runOptions;
    const tools = options.tools;
    const result = await runPiHarnessStep(step, name, {
      ...defaultHarnessOptions,
      ...runHarnessOptions,
      workflowName,
      sessionId,
      agentName,
      actor,
      operation,
      committedEntries: state.entries,
      persistedEntryIds: state.persistedEntryIds,
      tools: tools ? [...tools] : undefined,
      activeToolNames: runOptions.activeToolNames ? [...runOptions.activeToolNames] : undefined,
      internal: internalOptions,
    });
    const persistedEntryIds = new Set(state.persistedEntryIds);
    for (const entry of result.appendedEntries) {
      persistedEntryIds.add(entry.id);
    }
    state = {
      entries: mergeSessionEntries(state.entries, result.appendedEntries),
      leafId: result.leafId,
      persistedEntryIds: [...persistedEntryIds],
    };

    return messagesFromEntries<TTools>(result.appendedEntries).at(-1);
  };

  const executeCommandAndRunStep: AgentLoop<TTools>["executeCommandAndRunStep"] = async (
    command,
    runOptions = {},
  ) => {
    const commandOperation = operationFromCommand(command);
    if (!commandOperation) {
      return { kind: "ignored", command };
    }

    const operation =
      commandOperation.kind === "prompt" && runOptions.stopOnTools
        ? { ...commandOperation, stopOnTools: runOptions.stopOnTools }
        : commandOperation;

    return {
      kind: "agentRun",
      command,
      message: await runStep(commandStepName(command), operation, runOptions),
    };
  };

  const waitForCommand: AgentLoop<TTools>["waitForCommand"] = async (waitOptions = {}) => {
    const command = await waitForPiCommand(step, waitStepName(commandIndex), {
      timeout: waitOptions.timeout ?? options.commandTimeout,
    });
    commandIndex += 1;
    return command;
  };

  return {
    runStep,
    executeCommandAndRunStep,
    waitForCommand,
    async waitForCommandAndRunStep(runOptions = {}) {
      return await executeCommandAndRunStep(await waitForCommand(), runOptions);
    },
    summary,
    getState: () => ({
      entries: [...state.entries],
      leafId: state.leafId,
      persistedEntryIds: [...state.persistedEntryIds],
    }),
  };
};
