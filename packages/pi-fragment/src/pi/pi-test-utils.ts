import { BufferedPumpRegistry } from "@fragno-dev/db/buffered-pump";
import type { WorkflowStepLivePump } from "@fragno-dev/workflows/step-live-pump";
import { createWorkflowsTestHarness, type WorkflowsTestHarness } from "@fragno-dev/workflows/test";

import { instantiate } from "@fragno-dev/core";
import { migrate } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, type SupportedAdapter } from "@fragno-dev/test";

import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@mariozechner/pi-ai";

import { piRoutesFactory } from "../routes";
import { piFragmentDefinition } from "./definition";
import type { createPiFragment } from "./factory";
import type {
  PiFragmentConfig,
  PiAgentRegistry,
  PiToolRegistry,
  PiWorkflowsService,
} from "./types";
import { createPiWorkflows, type PiAgentRunner } from "./workflow/workflow";

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

const buildAssistantMessage = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
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
  stopReason: "stop",
  timestamp: Date.now(),
});

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
  const message = buildAssistantMessage(text);
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
}) =>
  createPiWorkflows({
    agents: options.agents,
    tools: options.tools,
    logging: options.logging,
    agentRunner: options.agentRunner,
  });

type PiFragmentInstance = ReturnType<typeof createPiFragment>;

type WorkflowsHarness = WorkflowsTestHarness<ReturnType<typeof createTestWorkflows>>;

const changedRouteRoundtripGuard = {
  maxRoundtrips: 100,
  routes: [
    { method: "GET", path: "/sessions/:sessionId" },
    { method: "GET", path: "/sessions/:sessionId/export/pi-jsonl" },
    { method: "GET", path: "/sessions/:sessionId/events" },
    { method: "POST", path: "/sessions/:sessionId/command" },
  ],
} satisfies {
  maxRoundtrips: number;
  routes: Array<{ method: "GET" | "POST"; path: string }>;
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
  wrapWorkflowsService?: (service: WorkflowsHarness["fragment"]["services"]) => PiWorkflowsService;
  autoTickHooks?: boolean;
  agentRunner?: PiAgentRunner;
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
  });
  const workflowsHarness = await createWorkflowsTestHarness({
    workflows,
    adapter: options.adapter ?? { type: "kysely-sqlite" },
    testBuilder: buildDatabaseFragmentsTest(),
    autoTickHooks: options.autoTickHooks ?? false,
    fragmentConfig: {
      stepEmissions,
    },
    fragmentOptions: {
      dbRoundtripGuard: changedRouteRoundtripGuard,
    },
  });

  const workflowsService = (
    options.wrapWorkflowsService
      ? options.wrapWorkflowsService(workflowsHarness.fragment.services)
      : workflowsHarness.fragment.services
  ) as PiWorkflowsService;

  const fragment = instantiate(piFragmentDefinition)
    .withConfig(config)
    .withRoutes([piRoutesFactory])
    .withOptions({
      databaseAdapter: workflowsHarness.test.adapter,
      dbRoundtripGuard: changedRouteRoundtripGuard,
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
