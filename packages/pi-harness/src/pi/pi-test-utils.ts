import { BufferedPumpRegistry } from "@fragno-dev/db/buffered-pump";
import type { WorkflowStepLivePump } from "@fragno-dev/workflows/step-live-pump";
import { createWorkflowsTestHarness, type WorkflowsTestHarness } from "@fragno-dev/workflows/test";
import type { WorkflowRegistryEntry } from "@fragno-dev/workflows/workflow";

import { instantiate } from "@fragno-dev/core";
import { migrate } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, type SupportedAdapter } from "@fragno-dev/test";
import { workflowsSchema } from "@fragno-dev/workflows";
import type { WorkflowsFragmentServices } from "@fragno-dev/workflows";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";

import { piRoutesFactory } from "../routes";
import { piHarnessDefinition } from "./definition";
import { createPiWorkflows, type createPiFragment } from "./factory";
import { NoOpExecutionEnv } from "./harness/execution-env";
import type { PiHarnessAgentOptions } from "./harness/run-pi-harness-step";
import type { PiFragmentConfig } from "./types";

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

export const createEnv = () => new NoOpExecutionEnv();

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
  (text: string): StreamFn =>
  () => {
    const stream = createAssistantMessageEventStream();
    const message = createAssistantMessage(text);

    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
    stream.push({ type: "done", reason: "stop", message });

    return stream;
  };

export const createHarnessOptions = (
  overrides: Partial<PiHarnessAgentOptions> = {},
): PiHarnessAgentOptions => ({
  env: createEnv(),
  systemPrompt: "You are helpful.",
  model: mockModel,
  streamFn: createTextStreamFn("assistant:init"),
  ...overrides,
});

type PiFragmentInstance = ReturnType<typeof createPiFragment>;
type WorkflowsHarness = WorkflowsTestHarness<ReturnType<typeof createPiWorkflows>>;

export const getWorkflowInstanceRef = async (
  workflows: WorkflowsHarness,
  workflowName: string,
  instanceId: string,
): Promise<string> => {
  const [instance] = (
    await workflows.db
      .createUnitOfWork("read-workflow-instance-ref")
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
