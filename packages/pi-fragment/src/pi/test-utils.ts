import { instantiate } from "@fragno-dev/core";
import { migrate } from "@fragno-dev/db";
import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@mariozechner/pi-ai";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import { buildDatabaseFragmentsTest, type SupportedAdapter } from "@fragno-dev/test";
import { createWorkflowsTestHarness, type WorkflowsTestHarness } from "@fragno-dev/workflows/test";

import { piFragmentDefinition } from "./definition";
import { piRoutesFactory } from "../routes";
import { piSchema } from "../schema";
import { createPiWorkflows } from "./workflow";
import type { createPiFragment } from "./factory";
import type {
  PiFragmentConfig,
  PiAgentRegistry,
  PiToolSideEffectReducerRegistry,
  PiToolRegistry,
  PiWorkflowsService,
} from "./types";

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

const extractMessageText = (messages: AgentMessage[]): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || typeof message !== "object" || message.role !== "user") {
      continue;
    }
    const content = message.content;
    if (!Array.isArray(content)) {
      continue;
    }
    const textBlock = content.find((block) => {
      if (!block || typeof block !== "object") {
        return false;
      }
      return (block as { type?: string }).type === "text";
    }) as { text?: string } | undefined;
    if (textBlock?.text) {
      return textBlock.text;
    }
  }
  return "";
};

type StreamFnScriptOptions = {
  result?: AssistantMessage;
  resultError?: Error;
};

export const createStreamFnScript = (
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

export const createFailingStreamFn = (options: { failOnceForText?: string } = {}): StreamFn => {
  let failedOnce = false;

  return (model, input, ctx) => {
    const userText = extractMessageText(input.messages);
    const message = buildAssistantMessage(`assistant:${userText}`);
    const shouldFail =
      !failedOnce &&
      typeof options.failOnceForText === "string" &&
      options.failOnceForText === userText;

    if (shouldFail) {
      failedOnce = true;
    }

    const streamFn = createStreamFnScript(
      [
        { type: "start", partial: message },
        { type: "done", reason: "stop", message },
      ],
      { result: message, resultError: shouldFail ? new Error("STREAM_FAIL") : undefined },
    );

    return streamFn(model, input, ctx as never);
  };
};

export const createInvalidResultStreamFn = (): StreamFn => {
  return (_model, input) => {
    const userText = extractMessageText(input.messages);
    const message = buildAssistantMessage(`assistant:${userText}`);
    const stream = createAssistantMessageEventStream();

    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });

    return Object.assign(stream, {
      result: async () => ({ invalid: true }),
    });
  };
};

export const createDelayedStreamFn = (delayMs = 25): StreamFn => {
  return (_model, input) => {
    const stream = createAssistantMessageEventStream();
    const userText = extractMessageText(input.messages);
    const message = buildAssistantMessage(`assistant:${userText}`);

    setTimeout(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    }, delayMs);

    return Object.assign(stream, {
      result: async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return message;
      },
    });
  };
};

export const createTestWorkflows = (options: {
  agents: PiAgentRegistry;
  tools: PiToolRegistry;
  toolSideEffectReducers?: PiToolSideEffectReducerRegistry;
  logging?: PiFragmentConfig["logging"];
}) =>
  createPiWorkflows({
    agents: options.agents,
    tools: options.tools,
    toolSideEffectReducers: options.toolSideEffectReducers,
    logging: options.logging,
  });

type PiFragmentInstance = ReturnType<typeof createPiFragment>;

type WorkflowsHarness = WorkflowsTestHarness<ReturnType<typeof createTestWorkflows>>;

export type DatabaseFragmentsTest = {
  fragments: {
    pi: {
      callRoute: PiFragmentInstance["callRoute"];
      db: SimpleQueryInterface<typeof piSchema>;
    };
  };
  workflows: WorkflowsHarness;
  test: {
    cleanup: () => Promise<void>;
  };
};
export const buildHarness = async (
  config: PiFragmentConfig,
  options: {
    adapter?: SupportedAdapter;
    wrapWorkflowsService?: (
      service: WorkflowsHarness["fragment"]["services"],
    ) => PiWorkflowsService;
    autoTickHooks?: boolean;
  } = {},
): Promise<DatabaseFragmentsTest> => {
  const workflows = createTestWorkflows({
    agents: config.agents,
    tools: config.tools,
    toolSideEffectReducers: config.toolSideEffectReducers,
    logging: config.logging,
  });
  const workflowsHarness = await createWorkflowsTestHarness({
    workflows,
    adapter: options.adapter ?? { type: "kysely-sqlite" },
    testBuilder: buildDatabaseFragmentsTest(),
    autoTickHooks: options.autoTickHooks ?? false,
  });

  const workflowsService = (
    options.wrapWorkflowsService
      ? options.wrapWorkflowsService(workflowsHarness.fragment.services)
      : workflowsHarness.fragment.services
  ) as PiWorkflowsService;

  const fragment = instantiate(piFragmentDefinition)
    .withConfig(config)
    .withRoutes([piRoutesFactory])
    .withOptions({ databaseAdapter: workflowsHarness.test.adapter })
    .withServices({ workflows: workflowsService })
    .build();

  await migrate(fragment);

  const deps = fragment.$internal?.deps as { schema?: typeof piSchema; namespace?: string | null };
  const namespace = deps?.namespace ?? "pi_fragment";
  const db = workflowsHarness.test.adapter.createQueryEngine(piSchema, namespace);

  return {
    fragments: {
      pi: {
        callRoute: fragment.callRoute.bind(fragment),
        db,
      },
    },
    workflows: workflowsHarness,
    test: {
      cleanup: workflowsHarness.test.cleanup,
    },
  };
};
