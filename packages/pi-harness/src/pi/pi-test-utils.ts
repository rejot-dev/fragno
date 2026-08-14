import { BufferedPumpRegistry } from "@fragno-dev/db/buffered-pump";
import type { MutationOperation } from "@fragno-dev/db/mutation-recorder";
import type { AnySchema } from "@fragno-dev/db/schema";
import {
  workflowStepLivePumpKey,
  type WorkflowStepLivePump,
} from "@fragno-dev/workflows/step-live-pump";
import {
  createWorkflowsTestHarness,
  recordWorkflowStepRunForTest,
  type RecordedWorkflowStepRun,
  type WorkflowsTestHarness,
} from "@fragno-dev/workflows/test";
import type { WorkflowRegistryEntry, WorkflowStep } from "@fragno-dev/workflows/workflow";

import { instantiate } from "@fragno-dev/core";
import { migrate } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, type SupportedAdapter } from "@fragno-dev/test";
import type { WorkflowsFragmentServices } from "@fragno-dev/workflows";

import { AgentHarness, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type FauxContentBlock,
  type Model,
  type Models,
  type RegisterFauxProviderOptions,
  type SimpleStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";

import { piRoutesFactory } from "../routes";
import { piSchema } from "../schema";
import { piHarnessDefinition } from "./definition";
import type { PiHarnessHooksMap } from "./definition";
import { createPiWorkflows, type createPiFragment } from "./factory";
import { PiHarnessEventStreamDecoders } from "./harness/agent-harness-event-protocol";
import type { PiHarnessFrontendEvent } from "./harness/agent-harness-event-protocol";
import { createModelsForStreamFn } from "./harness/test-models";
import type { PiFragmentConfig } from "./types";
import {
  createPiHarnessSessionState,
  restoreWorkflowBackedSession,
  withWorkflowAgentHarness,
  type PiHarnessOperation,
} from "./workflows/workflow-agent-harness";

export const mockModel: Model<Api> = {
  id: "test-model",
  name: "Test model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 2048,
};

export const createAssistantMessage = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: mockModel.api,
  provider: mockModel.provider,
  model: mockModel.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

export const createTextStreamFn =
  (text: string, usage?: Usage): StreamFn =>
  () => {
    const stream = createAssistantMessageEventStream();
    const message = createAssistantMessage(text);
    if (usage) {
      message.usage = { ...usage, cost: { ...usage.cost } };
    }

    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
    stream.push({ type: "done", reason: "stop", message });

    return stream;
  };

export type FauxPiHarnessCheckpoint = {
  type: "checkpoint";
  name: string;
};

export const fauxCheckpoint = (name: string): FauxPiHarnessCheckpoint => ({
  type: "checkpoint",
  name,
});

export type FauxPiHarnessEventCheckpoint = {
  type: "eventCheckpoint";
  name: string;
  eventType: string;
  contentIndex?: number;
  messageRole?: string;
  toolCallId?: string;
  occurrence?: number;
};

export const fauxEventCheckpoint = (
  name: string,
  eventType: string,
  options: Omit<FauxPiHarnessEventCheckpoint, "type" | "name" | "eventType"> = {},
): FauxPiHarnessEventCheckpoint => ({
  type: "eventCheckpoint",
  name,
  eventType,
  ...options,
});

export type FauxPiHarnessThinkingWithCheckpoints = {
  type: "thinkingWithCheckpoints";
  parts: readonly (string | FauxPiHarnessCheckpoint)[];
};

export const fauxThinkingWithCheckpoints = (
  parts: readonly (string | FauxPiHarnessCheckpoint)[],
): FauxPiHarnessThinkingWithCheckpoints => ({
  type: "thinkingWithCheckpoints",
  parts,
});

type FauxPiHarnessScriptContent =
  | FauxContentBlock
  | FauxPiHarnessCheckpoint
  | FauxPiHarnessEventCheckpoint
  | FauxPiHarnessThinkingWithCheckpoints;

export type FauxPiHarnessResponse = Omit<AssistantMessage, "content"> & {
  content: readonly FauxPiHarnessScriptContent[];
};

export const fauxAssistantMessageWithCheckpoints = (
  content: FauxPiHarnessScriptContent | readonly FauxPiHarnessScriptContent[],
  options: Parameters<typeof fauxAssistantMessage>[1] = {},
): FauxPiHarnessResponse => ({
  ...fauxAssistantMessage([], options),
  content: Array.isArray(content) ? content : [content],
});

export type FauxPiHarnessPromptOptions = {
  workflowName: string;
  sessionId: string;
  operation: Extract<PiHarnessOperation, { kind: "prompt" }>;
  responses: readonly (AssistantMessage | FauxPiHarnessResponse)[];
  tools?: readonly AgentTool[];
  systemPrompt?: string;
  fauxProviderOptions?: RegisterFauxProviderOptions;
};

type FauxCheckpointMatcher = {
  name: string;
  matches: (event: Record<string, unknown>) => boolean;
};

const assistantEvent = (event: Record<string, unknown>) => {
  const value = event["assistantMessageEvent"];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
};

const assistantEventPartialText = (event: Record<string, unknown>, contentIndex: number) => {
  const update = assistantEvent(event);
  const partial = update?.["partial"];
  if (!partial || typeof partial !== "object") {
    return null;
  }
  const content = (partial as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) {
    return null;
  }
  const block = content[contentIndex];
  if (!block || typeof block !== "object") {
    return null;
  }
  const thinking = (block as Record<string, unknown>)["thinking"];
  return typeof thinking === "string" ? thinking : null;
};

const createBlockEndMatcher = (
  name: string,
  block: FauxContentBlock,
  contentIndex: number,
): FauxCheckpointMatcher => {
  const eventType =
    block.type === "thinking"
      ? "thinking_end"
      : block.type === "text"
        ? "text_end"
        : "toolcall_end";
  return {
    name,
    matches: (event) =>
      event["type"] === "message_update" &&
      assistantEvent(event)?.["type"] === eventType &&
      assistantEvent(event)?.["contentIndex"] === contentIndex,
  };
};

const createEventMatcher = (checkpoint: FauxPiHarnessEventCheckpoint): FauxCheckpointMatcher => {
  let matchedEvents = 0;

  return {
    name: checkpoint.name,
    matches: (event) => {
      const update = assistantEvent(event);
      const typeMatches =
        event["type"] === checkpoint.eventType ||
        (event["type"] === "message_update" && update?.["type"] === checkpoint.eventType);
      if (!typeMatches) {
        return false;
      }
      if (
        checkpoint.contentIndex !== undefined &&
        update?.["contentIndex"] !== checkpoint.contentIndex
      ) {
        return false;
      }
      const message = event["message"];
      if (
        checkpoint.messageRole !== undefined &&
        (!message ||
          typeof message !== "object" ||
          (message as Record<string, unknown>)["role"] !== checkpoint.messageRole)
      ) {
        return false;
      }
      if (
        checkpoint.toolCallId !== undefined &&
        event["toolCallId"] !== checkpoint.toolCallId &&
        (!message ||
          typeof message !== "object" ||
          (message as Record<string, unknown>)["toolCallId"] !== checkpoint.toolCallId)
      ) {
        return false;
      }
      matchedEvents += 1;
      return matchedEvents === (checkpoint.occurrence ?? 1);
    },
  };
};

const compileFauxPiHarnessResponses = (
  responses: readonly (AssistantMessage | FauxPiHarnessResponse)[],
): { responses: AssistantMessage[]; checkpoints: FauxCheckpointMatcher[] } => {
  const checkpoints: FauxCheckpointMatcher[] = [];
  const compiled = responses.map((message) => {
    const content: FauxContentBlock[] = [];
    let previousBlock: FauxContentBlock | null = null;
    let previousContentIndex = -1;

    for (const block of message.content) {
      if (block.type === "checkpoint") {
        if (!previousBlock) {
          throw new Error(`Checkpoint ${block.name} must follow a response content block.`);
        }
        checkpoints.push(createBlockEndMatcher(block.name, previousBlock, previousContentIndex));
        continue;
      }

      if (block.type === "eventCheckpoint") {
        checkpoints.push(createEventMatcher(block));
        continue;
      }

      if (block.type === "thinkingWithCheckpoints") {
        let thinking = "";
        const contentIndex = content.length;
        for (const part of block.parts) {
          if (typeof part === "string") {
            thinking += part;
            continue;
          }
          const minLength = thinking.length;
          checkpoints.push({
            name: part.name,
            matches: (event) =>
              event["type"] === "message_update" &&
              assistantEvent(event)?.["type"] === "thinking_delta" &&
              assistantEvent(event)?.["contentIndex"] === contentIndex &&
              (assistantEventPartialText(event, contentIndex)?.length ?? 0) >= minLength,
          });
        }
        previousBlock = { type: "thinking", thinking };
        previousContentIndex = contentIndex;
        content.push(previousBlock);
        continue;
      }

      previousBlock = block;
      previousContentIndex = content.length;
      content.push(block);
    }

    return { ...message, content };
  });

  return { responses: compiled, checkpoints };
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createCheckpointStreamFn = (options: {
  responses: readonly AssistantMessage[];
  checkpoints: ReturnType<typeof createCheckpointState>;
  getMutations: () => MutationOperation<AnySchema>[];
  flushEmissions: () => Promise<void>;
  fauxProviderOptions?: RegisterFauxProviderOptions;
}): StreamFn => {
  let nextResponse = 0;
  const minTokenSize = Math.max(
    1,
    Math.min(
      options.fauxProviderOptions?.tokenSize?.min ?? 1,
      options.fauxProviderOptions?.tokenSize?.max ?? 1,
    ),
  );
  const maxTokenSize = Math.max(minTokenSize, options.fauxProviderOptions?.tokenSize?.max ?? 1);
  const split = (text: string) => {
    const chunks: string[] = [];
    let index = 0;
    while (index < text.length) {
      const charSize = Math.max(1, maxTokenSize * 4);
      chunks.push(text.slice(index, index + charSize));
      index += charSize;
    }
    return chunks.length > 0 ? chunks : [""];
  };

  const pauseIfCheckpoint = async (event: Record<string, unknown>) => {
    for (const checkpoint of options.checkpoints.values()) {
      if (checkpoint.hit || !checkpoint.matches(event)) {
        continue;
      }
      checkpoint.hit = true;
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      await options.flushEmissions();
      let resume: () => void = () => undefined;
      const resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const checkpointMutations = [...options.getMutations()];
      checkpoint.deferred.resolve({
        name: checkpoint.name,
        mutations: checkpointMutations,
        mutationsWithDeletedStepEmissions: () =>
          mutationsWithDeletedStepEmissions(checkpointMutations),
        resume,
      });
      await resumed;
      break;
    }
  };

  return (model, _context, _streamOptions?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    const response = options.responses[nextResponse++];

    queueMicrotask(() => {
      void (async () => {
        if (!response) {
          stream.end();
          return;
        }

        const message: AssistantMessage = {
          ...structuredClone(response),
          api: model.api,
          provider: model.provider,
          model: model.id,
        };
        const partial: AssistantMessage = { ...message, content: [] };
        stream.push({ type: "start", partial: { ...partial } });
        await pauseIfCheckpoint({ type: "message_start", message: { ...partial } });
        const pushUpdate = async (assistantMessageEvent: AssistantMessageEvent) => {
          stream.push(assistantMessageEvent);
          await pauseIfCheckpoint({
            type: "message_update",
            assistantMessageEvent,
            message: { ...partial },
          });
        };

        for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
          const block = message.content[contentIndex];
          if (block.type === "thinking") {
            partial.content = [...partial.content, { type: "thinking", thinking: "" }];
            await pushUpdate({ type: "thinking_start", contentIndex, partial: { ...partial } });
            for (const chunk of split(block.thinking)) {
              (partial.content[contentIndex] as { thinking: string }).thinking += chunk;
              await pushUpdate({
                type: "thinking_delta",
                contentIndex,
                delta: chunk,
                partial: { ...partial },
              });
            }
            await pushUpdate({
              type: "thinking_end",
              contentIndex,
              content: block.thinking,
              partial: { ...partial },
            });
            continue;
          }

          if (block.type === "text") {
            partial.content = [...partial.content, { type: "text", text: "" }];
            await pushUpdate({ type: "text_start", contentIndex, partial: { ...partial } });
            for (const chunk of split(block.text)) {
              (partial.content[contentIndex] as { text: string }).text += chunk;
              await pushUpdate({
                type: "text_delta",
                contentIndex,
                delta: chunk,
                partial: { ...partial },
              });
            }
            await pushUpdate({
              type: "text_end",
              contentIndex,
              content: block.text,
              partial: { ...partial },
            });
            continue;
          }

          partial.content = [
            ...partial.content,
            { type: "toolCall", id: block.id, name: block.name, arguments: {} },
          ];
          await pushUpdate({ type: "toolcall_start", contentIndex, partial: { ...partial } });
          for (const chunk of split(JSON.stringify(block.arguments))) {
            await pushUpdate({
              type: "toolcall_delta",
              contentIndex,
              delta: chunk,
              partial: { ...partial },
            });
          }
          (partial.content[contentIndex] as { arguments: unknown }).arguments = block.arguments;
          await pushUpdate({
            type: "toolcall_end",
            contentIndex,
            toolCall: block,
            partial: { ...partial },
          });
        }

        const reason =
          message.stopReason === "length" ||
          message.stopReason === "stop" ||
          message.stopReason === "toolUse"
            ? message.stopReason
            : "stop";
        stream.push({ type: "done", reason, message });
        await pauseIfCheckpoint({ type: "message_end", message });
      })();
    });

    return stream;
  };
};

const createCheckpointState = (checkpoints: readonly FauxCheckpointMatcher[]) =>
  new Map(
    checkpoints.map((checkpoint) => [
      checkpoint.name,
      { ...checkpoint, hit: false, deferred: createDeferred<FauxPiHarnessCheckpointResult>() },
    ]),
  );

export type PiHarnessScenarioEmission = {
  readonly id: string;
  readonly workflowName: string;
  readonly instanceId: string;
  readonly stepKey: string;
  readonly epoch: string;
  readonly payload: unknown;
};

export const createPiHarnessScenarioEventDecoder = () => {
  const decoders = new PiHarnessEventStreamDecoders();
  const decodedEventsByEmissionId = new Map<string, PiHarnessFrontendEvent | undefined>();

  return (emission: PiHarnessScenarioEmission): PiHarnessFrontendEvent | undefined => {
    const emissionId = `${emission.workflowName}\u0000${emission.instanceId}\u0000${emission.id}`;
    if (decodedEventsByEmissionId.has(emissionId)) {
      return decodedEventsByEmissionId.get(emissionId);
    }

    const payload = emission.payload;
    if (typeof payload !== "object" || payload === null || !("kind" in payload)) {
      decodedEventsByEmissionId.set(emissionId, undefined);
      return undefined;
    }

    const identity = {
      stepKey: `${emission.workflowName}\u0000${emission.instanceId}\u0000${emission.stepKey}`,
      executionId: emission.epoch,
      epoch: emission.epoch,
    };
    if (payload.kind === "harness-operation-start") {
      decoders.start(identity);
      decodedEventsByEmissionId.set(emissionId, undefined);
      return undefined;
    }
    if (payload.kind === "harness-operation-complete") {
      decoders.finish(identity);
      decodedEventsByEmissionId.set(emissionId, undefined);
      return undefined;
    }
    if (payload.kind !== "harness-event" || !("event" in payload)) {
      decodedEventsByEmissionId.set(emissionId, undefined);
      return undefined;
    }

    try {
      const event = decoders.decode(identity, payload.event);
      decodedEventsByEmissionId.set(emissionId, event);
      return event;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (
        message.startsWith("PI_HARNESS_EVENT_PROTOCOL_UNKNOWN_") ||
        message === "PI_HARNESS_EVENT_PROTOCOL_MESSAGE_UPDATE_WITHOUT_ASSISTANT_START"
      ) {
        decodedEventsByEmissionId.set(emissionId, undefined);
        return undefined;
      }
      throw error;
    }
  };
};

const decodedHarnessEventFromMutation = (
  mutation: MutationOperation<AnySchema>,
  decoders: PiHarnessEventStreamDecoders,
): Record<string, unknown> | null => {
  if (mutation.type !== "create" || mutation.table !== "workflow_step_emission") {
    return null;
  }
  const values = mutation.values as Record<string, unknown>;
  const stepKey = values["stepKey"];
  const executionId = values["executionId"];
  const epoch = values["epoch"];
  if (typeof stepKey !== "string" || typeof executionId !== "string" || typeof epoch !== "string") {
    throw new Error("Faux Pi harness emission is missing its stream identity.");
  }
  const identity = { stepKey, executionId, epoch };
  const payload = values["payload"];
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const payloadRecord = payload as Record<string, unknown>;
  if (payloadRecord["kind"] === "harness-operation-start") {
    decoders.start(identity);
    return null;
  }
  if (payloadRecord["kind"] === "harness-operation-complete") {
    decoders.finish(identity);
    return null;
  }
  if (payloadRecord["kind"] !== "harness-event") {
    return null;
  }
  return decoders.decode(identity, payloadRecord["event"]) as unknown as Record<string, unknown>;
};

export type FauxPiHarnessCheckpointResult = {
  name: string;
  mutations: MutationOperation<AnySchema>[];
  mutationsWithDeletedStepEmissions: () => MutationOperation<AnySchema>[];
  resume: () => void;
};

export type StartedFauxPiHarnessPrompt = {
  waitForCheckpoint: (name: string) => Promise<FauxPiHarnessCheckpointResult>;
  done: Promise<RecordedWorkflowStepRun>;
  mutationsWithDeletedStepEmissions: (
    mutations?: readonly MutationOperation<AnySchema>[],
  ) => MutationOperation<AnySchema>[];
};

const mutationsWithDeletedStepEmissions = (
  mutations: readonly MutationOperation<AnySchema>[],
): MutationOperation<AnySchema>[] => [
  ...mutations,
  ...mutations.flatMap((mutation): MutationOperation<AnySchema>[] => {
    if (mutation.type !== "create" || mutation.table !== "workflow_step_emission") {
      return [];
    }

    return [
      {
        type: "delete",
        schema: mutation.schema,
        namespace: mutation.namespace,
        table: mutation.table,
        id: mutation.generatedExternalId,
        checkVersion: false,
      },
    ];
  }),
];

const createDeterministicFauxProvider = (options?: RegisterFauxProviderOptions) =>
  fauxProvider({
    api: "faux",
    tokenSize: { min: 1, max: 1 },
    tokensPerSecond: 0,
    ...options,
  });

const runFauxPiHarnessPrompt = async (
  step: WorkflowStep<PiHarnessHooksMap>,
  options: FauxPiHarnessPromptOptions,
  model: Model<string>,
  models: Models,
) => {
  const operationId = `${options.workflowName}:${options.sessionId}:faux-turn`;
  const state = createPiHarnessSessionState({
    metadata: {
      id: options.sessionId,
      createdAt: "2000-01-01T00:00:00.000Z",
    },
  });

  return await step.do("faux-turn", async (tx) => {
    const {
      session,
      storage,
      options: restoredOptions,
    } = restoreWorkflowBackedSession({
      operationId,
      state,
      previousEmissions: await tx.previousEmissions(),
      models,
    });
    const harness = new AgentHarness({
      systemPrompt: options.systemPrompt ?? "You are helpful.",
      model,
      models,
      tools: [...(options.tools ?? [])],
      ...restoredOptions,
    });
    const stopOnTools = new Set(options.operation.stopOnTools ?? []);
    if (stopOnTools.size > 0) {
      harness.on("tool_result", (toolResult) =>
        stopOnTools.has(toolResult.toolName) ? { terminate: true } : undefined,
      );
    }

    return await withWorkflowAgentHarness({
      session,
      storage,
      harness,
      tx,
      runDurableStep: () => harness.prompt(...options.operation.args),
    });
  });
};

export const startFauxPiHarnessPrompt = (
  options: FauxPiHarnessPromptOptions,
): StartedFauxPiHarnessPrompt => {
  const compiled = compileFauxPiHarnessResponses(options.responses);
  const checkpoints = createCheckpointState(compiled.checkpoints);
  const stepEmissions = new BufferedPumpRegistry<WorkflowStepLivePump>();
  const pumpKey = workflowStepLivePumpKey(options.workflowName, options.sessionId);
  let mutations: MutationOperation<AnySchema>[] = [];
  const streamFn = createCheckpointStreamFn({
    responses: compiled.responses,
    checkpoints,
    getMutations: () => mutations,
    flushEmissions: async () => {
      await stepEmissions.get(pumpKey)?.flushNow();
    },
    fauxProviderOptions: options.fauxProviderOptions,
  });
  const model: Model<string> = {
    id: "faux-1",
    name: "Faux Model",
    api: "faux",
    provider: "faux",
    baseUrl: "http://localhost:0",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };

  const models = createModelsForStreamFn(model, streamFn);
  const eventDecoders = new PiHarnessEventStreamDecoders();
  const done = recordWorkflowStepRunForTest({
    workflowName: options.workflowName,
    instanceId: options.sessionId,
    schemas: [{ schema: piSchema, namespace: "pi-harness" }],
    stepEmissions,
    run: async (step) => await runFauxPiHarnessPrompt(step, options, model, models),
    onMutations: async ({ mutations: newMutations, allMutations }) => {
      mutations = [...allMutations];
      const previousMutationCount = allMutations.length - newMutations.length;
      for (const [index, mutation] of newMutations.entries()) {
        const event = decodedHarnessEventFromMutation(mutation, eventDecoders);
        if (!event) {
          continue;
        }
        for (const checkpoint of checkpoints.values()) {
          if (checkpoint.hit || !checkpoint.matches(event)) {
            continue;
          }
          checkpoint.hit = true;
          let resume: () => void = () => undefined;
          const resumed = new Promise<void>((resolve) => {
            resume = resolve;
          });
          const checkpointMutations = allMutations.slice(0, previousMutationCount + index + 1);
          checkpoint.deferred.resolve({
            name: checkpoint.name,
            mutations: checkpointMutations,
            mutationsWithDeletedStepEmissions: () =>
              mutationsWithDeletedStepEmissions(checkpointMutations),
            resume,
          });
          await resumed;
          break;
        }
      }
    },
  });

  void done.then(
    () => {
      for (const checkpoint of checkpoints.values()) {
        if (!checkpoint.hit) {
          checkpoint.deferred.reject(new Error(`Checkpoint ${checkpoint.name} was not reached.`));
        }
      }
    },
    (error: unknown) => {
      for (const checkpoint of checkpoints.values()) {
        if (!checkpoint.hit) {
          checkpoint.deferred.reject(error);
        }
      }
    },
  );

  return {
    waitForCheckpoint: (name) => {
      const checkpoint = checkpoints.get(name);
      if (!checkpoint) {
        return Promise.reject(new Error(`Unknown checkpoint ${name}.`));
      }
      return checkpoint.deferred.promise;
    },
    done,
    mutationsWithDeletedStepEmissions: (snapshot = mutations) =>
      mutationsWithDeletedStepEmissions(snapshot),
  };
};

/**
 * Run one Pi harness prompt against the faux provider and record the workflow
 * UOW mutations produced by the real workflow runner. This mirrors the Pi AI
 * faux-provider style: `operation` is passed to the harness, `responses` are
 * queued as model responses, and `tools` are normal AgentTool definitions
 * executed by the harness. Callers can then project the returned UOW mutations
 * into Lofi, a database adapter, or another test target.
 */
export const recordFauxPiHarnessPrompt = async (options: FauxPiHarnessPromptOptions) => {
  const compiled = compileFauxPiHarnessResponses(options.responses);
  const faux = createDeterministicFauxProvider(options.fauxProviderOptions);
  faux.setResponses([...compiled.responses]);
  const models = createModels();
  models.setProvider(faux.provider);

  return await recordWorkflowStepRunForTest({
    workflowName: options.workflowName,
    instanceId: options.sessionId,
    schemas: [{ schema: piSchema, namespace: "pi-harness" }],
    run: async (step) => await runFauxPiHarnessPrompt(step, options, faux.getModel(), models),
  });
};

type PiFragmentInstance = ReturnType<typeof createPiFragment>;
type WorkflowsHarness = WorkflowsTestHarness;

type DatabaseFragmentsTest = {
  fragments: {
    pi: {
      fragment: PiFragmentInstance;
      callRoute: PiFragmentInstance["callRoute"];
      callRouteRaw: PiFragmentInstance["callRouteRaw"];
      services: PiFragmentInstance["services"];
      callServices: PiFragmentInstance["callServices"];
    };
  };
  workflows: WorkflowsHarness;
  test: {
    cleanup: () => Promise<void>;
  };
};

type BuildHarnessOptions = {
  adapter?: SupportedAdapter;
  wrapWorkflowsService?: (
    service: WorkflowsHarness["fragment"]["services"],
  ) => WorkflowsFragmentServices;
  autoTickHooks?: boolean;
  workflows?: WorkflowRegistryEntry[];
};

export const buildHarness: (
  config: PiFragmentConfig,
  options?: BuildHarnessOptions,
) => Promise<DatabaseFragmentsTest> = async (config, options = {}) => {
  const stepEmissions = new BufferedPumpRegistry<WorkflowStepLivePump>();
  const workflows = createPiWorkflows({
    logging: config.logging,
    workflows: options.workflows ?? config.workflows,
  });
  const workflowsHarness = await createWorkflowsTestHarness({
    workflows,
    adapter: options.adapter ?? { type: "kysely-sqlite" },
    testBuilder: buildDatabaseFragmentsTest(),
    autoTickHooks: options.autoTickHooks ?? false,
    fragmentConfig: {
      stepEmissions,
    },
  });

  const workflowsService = (
    options.wrapWorkflowsService
      ? options.wrapWorkflowsService(workflowsHarness.fragment.services)
      : workflowsHarness.fragment.services
  ) as WorkflowsFragmentServices;

  const fragment = instantiate(piHarnessDefinition)
    .withConfig({ ...config, workflows: options.workflows ?? config.workflows })
    .withRoutes([piRoutesFactory])
    .withOptions({
      databaseAdapter: workflowsHarness.test.adapter,
    })
    .withServices({ workflows: workflowsService })
    .build();

  await migrate(fragment);

  return {
    fragments: {
      pi: {
        fragment,
        callRoute: fragment.callRoute.bind(fragment),
        callRouteRaw: fragment.callRouteRaw.bind(fragment),
        services: fragment.services,
        callServices: fragment.callServices.bind(fragment),
      },
    },
    workflows: workflowsHarness,
    test: {
      cleanup: workflowsHarness.test.cleanup,
    },
  };
};
