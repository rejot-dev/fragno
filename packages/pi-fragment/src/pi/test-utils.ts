import { instantiate } from "@fragno-dev/core";
import { migrate } from "@fragno-dev/db";
import type { AgentEvent, AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@mariozechner/pi-ai";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import { buildDatabaseFragmentsTest, type SupportedAdapter } from "@fragno-dev/test";
import { createWorkflowsTestHarness, type WorkflowsTestHarness } from "@fragno-dev/workflows/test";
import {
  defineWorkflow,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowsRegistry,
} from "@fragno-dev/workflows";
import { z } from "zod";

import { piFragmentDefinition } from "./definition";
import { piRoutesFactory } from "../routes";
import { piSchema } from "../schema";
import { PI_WORKFLOW_NAME } from "./workflow";
import type { createPiFragment } from "./factory";
import type {
  PiFragmentConfig,
  PiAgentRegistry,
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

type AgentLoopParams = {
  sessionId: string;
  agentName: string;
  systemPrompt?: string;
  initialMessages?: AgentMessage[];
};

const agentLoopParamsSchema: z.ZodType<AgentLoopParams> = z.object({
  sessionId: z.string(),
  agentName: z.string(),
  systemPrompt: z.string().optional(),
  initialMessages: z.array(z.custom<AgentMessage>()).optional(),
});

const userMessageSchema = z.object({
  text: z.string().optional(),
  done: z.boolean().optional(),
  steeringMode: z.enum(["all", "one-at-a-time"]).optional(),
});

const buildUserMessage = (text: string): AgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});

export const createTestWorkflows = (options: {
  agents: PiAgentRegistry;
  tools: PiToolRegistry;
}) => {
  return {
    agentLoop: defineWorkflow(
      { name: PI_WORKFLOW_NAME, schema: agentLoopParamsSchema },
      async (event: WorkflowEvent<AgentLoopParams>, step: WorkflowStep) => {
        const params = agentLoopParamsSchema.parse(event.payload ?? {});
        const agent = options.agents[params.agentName];
        if (!agent) {
          throw new Error(`Agent ${params.agentName} not found.`);
        }

        let messages: AgentMessage[] = Array.isArray(params.initialMessages)
          ? params.initialMessages
          : [];
        let turn = 0;

        while (true) {
          const userEvent = await step.waitForEvent(`wait-user-${turn}`, {
            type: "user_message",
            timeout: "1 hour",
          });
          const payload = userMessageSchema.parse(userEvent.payload ?? {});
          const userResult = await step.do(`user-${turn}`, async () => {
            const userMessage = buildUserMessage(payload.text ?? "");
            return { messages: [...messages, userMessage], user: userMessage };
          });
          messages = userResult.messages;

          const assistantResult = await step.do(`assistant-${turn}`, async () => {
            const fallbackAssistantMessage = {
              role: "assistant",
              content: [{ type: "text", text: `assistant:${payload.text ?? ""}` }],
            } as AgentMessage;
            let assistantMessage = fallbackAssistantMessage;
            const trace: AgentEvent[] = [];

            if (agent.streamFn) {
              const stream = await Promise.resolve(
                agent.streamFn(
                  agent.model,
                  { systemPrompt: params.systemPrompt ?? agent.systemPrompt, messages },
                  { apiKey: "test" },
                ),
              );
              if (stream && typeof stream === "object" && Symbol.asyncIterator in stream) {
                for await (const eventItem of stream as AsyncIterable<unknown>) {
                  trace.push({
                    type: "message_update",
                    message: fallbackAssistantMessage,
                    assistantMessageEvent: eventItem as never,
                  } as AgentEvent);
                }
              }
              if (
                stream &&
                typeof stream === "object" &&
                "result" in stream &&
                typeof stream.result === "function"
              ) {
                try {
                  const result = await stream.result();
                  if (result && typeof result === "object" && "role" in result) {
                    assistantMessage = result as AgentMessage;
                  }
                } catch {
                  assistantMessage = fallbackAssistantMessage;
                }
              }
            }

            return {
              messages: [...messages, assistantMessage],
              trace,
              assistant: assistantMessage,
            };
          });

          messages = assistantResult.messages;

          if (payload.done) {
            return { messages };
          }

          turn += 1;
        }
      },
    ),
  } satisfies WorkflowsRegistry;
};

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
  const workflows = createTestWorkflows({ agents: config.agents, tools: config.tools });
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

export const drainWorkflowRunner = async (
  workflows: DatabaseFragmentsTest["workflows"],
  workflowName: string,
  instanceId: string,
  options: { maxTicks?: number } = {},
): Promise<{ status: string }> => {
  const maxTicks = options.maxTicks ?? 10;

  const buildTickPayload = async () => {
    const instances = await workflows.db.find("workflow_instance");
    const instance = instances.find(
      (row: unknown) => String((row as { id?: unknown }).id) === instanceId,
    ) as { id?: unknown; runNumber?: number } | undefined;
    if (!instance) {
      throw new Error(`Workflow instance ${instanceId} not found.`);
    }
    return {
      workflowName,
      instanceId,
      instanceRef: String(instance.id ?? instanceId),
      runNumber: typeof instance.runNumber === "number" ? instance.runNumber : 0,
      reason: "event" as const,
    };
  };

  const payload = await buildTickPayload();
  await workflows.runUntilIdle(payload, { maxTicks });

  return await workflows.getStatus(workflowName, instanceId);
};
