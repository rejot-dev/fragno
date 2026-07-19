import { BufferedPumpRegistry } from "@fragno-dev/db/buffered-pump";
import { workflowsSchema } from "@fragno-dev/workflows/schema";
import type { WorkflowStepLivePump } from "@fragno-dev/workflows/step-live-pump";
import { createWorkflowsTestHarness, type WorkflowsTestHarness } from "@fragno-dev/workflows/test";

import { instantiate } from "@fragno-dev/core";
import { migrate } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, type SupportedAdapter } from "@fragno-dev/test";
import type { WorkflowsFragmentServices } from "@fragno-dev/workflows";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  parseStreamingJson,
  type Api,
  type AssistantMessage,
  type Model,
  type StopReason,
  type ToolCall,
} from "@earendil-works/pi-ai";

import { piRoutesFactory } from "../routes";
import { piFragmentDefinition } from "./definition";
import type { PiWorkflowDefinition } from "./dsl";
import type { createPiFragment } from "./factory";
import { createPiWorkflows, type PiAgentRunner } from "./factory";
import type { PiFragmentConfig, PiAgentRegistry, PiToolRegistry } from "./types";

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

const buildAssistantMessage = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-responses",
  provider: "openai",
  model: "test-model",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: Date.now(),
});

type ScriptedAssistantTurnOptions = {
  waitBeforeStart?: Promise<unknown>;
  waitBeforeEnd?: Promise<unknown>;
};

type StreamingToolCall = ToolCall & { partialJson?: string };

type ScriptedToolCallOptions = {
  id: string;
  args: Record<string, unknown>;
  deltas?: string[];
};

const cloneAssistantMessage = (message: AssistantMessage): AssistantMessage => ({
  ...message,
  content: message.content.map((block) =>
    block.type === "toolCall"
      ? ({ ...block, arguments: { ...block.arguments } } as ToolCall)
      : { ...block },
  ),
  usage: {
    ...message.usage,
    cost: { ...message.usage.cost },
  },
});

type ScriptedAssistantTurn =
  | ({
      type: "text";
      text: string;
      stopReason?: Extract<StopReason, "stop" | "length">;
    } & ScriptedAssistantTurnOptions)
  | ({ type: "toolCall"; toolCall: ToolCall; deltas?: string[] } & ScriptedAssistantTurnOptions);

export const createAssistantStreamScript = () => {
  const turns: ScriptedAssistantTurn[] = [];
  let nextTurnOptions: ScriptedAssistantTurnOptions = {};
  const takeNextTurnOptions = () => {
    const options = nextTurnOptions;
    nextTurnOptions = {};
    return options;
  };
  const builder = {
    waitBeforeStart(waitBeforeStart: Promise<unknown>) {
      nextTurnOptions = { ...nextTurnOptions, waitBeforeStart };
      return builder;
    },
    waitBeforeEnd(waitBeforeEnd: Promise<unknown>) {
      nextTurnOptions = { ...nextTurnOptions, waitBeforeEnd };
      return builder;
    },
    text(text: string, options: { stopReason?: Extract<StopReason, "stop" | "length"> } = {}) {
      turns.push({ type: "text", text, stopReason: options.stopReason, ...takeNextTurnOptions() });
      return builder;
    },
    toolCall(name: string, options: ScriptedToolCallOptions) {
      turns.push({
        type: "toolCall",
        toolCall: { type: "toolCall", id: options.id, name, arguments: options.args },
        deltas: options.deltas,
        ...takeNextTurnOptions(),
      });
      return builder;
    },
    build(): { streamFn: StreamFn } {
      let nextTurnIndex = 0;
      return {
        streamFn: async () => {
          const turn = turns[nextTurnIndex];
          if (!turn) {
            throw new Error(`No scripted assistant turn available at index ${nextTurnIndex}.`);
          }
          nextTurnIndex += 1;
          await turn.waitBeforeStart;

          const stream = createAssistantMessageEventStream();

          void (async () => {
            if (turn.type === "toolCall") {
              const finalMessage = buildAssistantMessage([turn.toolCall], "toolUse");
              const startMessage = buildAssistantMessage([], "toolUse");
              const partialToolCall: StreamingToolCall = {
                type: "toolCall",
                id: turn.toolCall.id,
                name: turn.toolCall.name,
                arguments: {},
                partialJson: "",
              };
              const partialMessage = buildAssistantMessage([partialToolCall], "toolUse");

              stream.push({ type: "start", partial: cloneAssistantMessage(startMessage) });
              stream.push({
                type: "toolcall_start",
                contentIndex: 0,
                partial: cloneAssistantMessage(partialMessage),
              });

              for (const delta of turn.deltas ?? []) {
                partialToolCall.partialJson = `${partialToolCall.partialJson ?? ""}${delta}`;
                partialToolCall.arguments = parseStreamingJson(partialToolCall.partialJson);
                stream.push({
                  type: "toolcall_delta",
                  contentIndex: 0,
                  delta,
                  partial: cloneAssistantMessage(partialMessage),
                });
              }

              await turn.waitBeforeEnd;
              stream.push({
                type: "toolcall_end",
                contentIndex: 0,
                toolCall: turn.toolCall,
                partial: cloneAssistantMessage(finalMessage),
              });
              stream.push({ type: "done", reason: "toolUse", message: finalMessage });
              return;
            }

            const message = buildAssistantMessage(
              [{ type: "text", text: turn.text }],
              turn.stopReason ?? "stop",
            );

            stream.push({ type: "start", partial: cloneAssistantMessage(message) });
            stream.push({
              type: "text_start",
              contentIndex: 0,
              partial: cloneAssistantMessage(message),
            });
            stream.push({
              type: "text_delta",
              contentIndex: 0,
              delta: turn.text,
              partial: cloneAssistantMessage(message),
            });
            await turn.waitBeforeEnd;
            stream.push({
              type: "text_end",
              contentIndex: 0,
              content: turn.text,
              partial: cloneAssistantMessage(message),
            });
            stream.push({ type: "done", reason: turn.stopReason ?? "stop", message });
          })();

          return stream;
        },
      };
    },
  };
  return builder;
};

type StreamFnScriptOptions = {
  result?: AssistantMessage;
  resultError?: Error;
};

const createStreamFnScript = (
  events: Array<{ type: string; [key: string]: unknown }>,
  options: StreamFnScriptOptions = {},
): StreamFn => {
  return () => {
    const stream = createAssistantMessageEventStream();
    let lastMessage: AssistantMessage | null = null;

    for (const event of events) {
      stream.push(event as never);
      if (event && typeof event === "object") {
        const eventMessage = event["message"];
        if (eventMessage && typeof eventMessage === "object") {
          lastMessage = eventMessage as AssistantMessage;
        } else {
          const eventPartial = event["partial"];
          if (eventPartial && typeof eventPartial === "object") {
            lastMessage = eventPartial as AssistantMessage;
          }
        }
      }
    }

    return Object.assign(stream, {
      result: async () => {
        if (options.resultError) {
          throw options.resultError;
        }
        if (options.result) {
          return options.result;
        }
        if (lastMessage) {
          return lastMessage;
        }
        throw new Error("STREAM_RESULT_MISSING");
      },
    });
  };
};

export const createStreamFn = (text: string): StreamFn => {
  const message = buildAssistantMessage([{ type: "text", text }]);
  return createStreamFnScript(
    [
      { type: "start", partial: message },
      { type: "text_start", contentIndex: 0, partial: message },
      { type: "text_delta", contentIndex: 0, delta: text, partial: message },
      { type: "text_end", contentIndex: 0, content: text, partial: message },
      { type: "done", reason: "stop", message },
    ],
    { result: message },
  );
};

const createTestWorkflows = (options: {
  agents: PiAgentRegistry;
  tools: PiToolRegistry;
  logging?: PiFragmentConfig["logging"];
  agentRunner?: PiAgentRunner;
  workflows?: PiWorkflowDefinition[];
}) =>
  createPiWorkflows({
    agents: options.agents,
    tools: options.tools,
    logging: options.logging,
    agentRunner: options.agentRunner,
    workflows: options.workflows,
  });

type PiFragmentInstance = ReturnType<typeof createPiFragment>;

type WorkflowsHarness = WorkflowsTestHarness;

export const getWorkflowInstanceRef = async (
  workflows: WorkflowsHarness,
  workflowName: string,
  instanceId: string,
): Promise<string> => {
  const uow = workflows.db.createUnitOfWork("read-workflow-instance-ref");
  uow.registerSchema(workflowsSchema, workflowsSchema.name);
  const [instance] = (
    await uow
      .forSchema(workflowsSchema)
      .find("workflow_instance", (b) =>
        b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
          eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
        ),
      )
      .executeRetrieve()
  )[0];

  if (!instance) {
    throw new Error(`Workflow instance ${workflowName}/${instanceId} not found.`);
  }

  return instance.id.toString();
};

type DatabaseFragmentsTest = {
  fragments: {
    pi: {
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
  agentRunner?: PiAgentRunner;
  workflows?: PiWorkflowDefinition[];
};

export const buildHarness: (
  config: PiFragmentConfig,
  options?: BuildHarnessOptions,
) => Promise<DatabaseFragmentsTest> = async (config, options = {}) => {
  const stepEmissions = new BufferedPumpRegistry<WorkflowStepLivePump>();
  const workflows = createTestWorkflows({
    agents: config.agents,
    tools: config.tools,
    logging: config.logging,
    agentRunner: options.agentRunner,
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

  const fragment = instantiate(piFragmentDefinition)
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
