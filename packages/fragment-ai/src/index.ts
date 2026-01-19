import { createClientBuilder } from "@fragno-dev/core/client";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { instantiate } from "@fragno-dev/core";
import { computed } from "nanostores";
import { aiFragmentDefinition, type AiRunLiveEvent, type AiThinkingLevel } from "./definition";
import { aiRoutesFactory } from "./routes";

export type AiModelRef = {
  id: string;
  provider?: string;
  api?: "openai-responses";
  baseUrl?: string;
  headers?: Record<string, string>;
};

export type AiThinkingBudgets = {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
};

export type AiWakeEvent =
  | { type: "run.queued"; runId: string }
  | { type: "openai.webhook.received"; openaiEventId: string; responseId: string };

export type AiDispatcher = {
  wake: (payload: AiWakeEvent) => Promise<void> | void;
};

export type AiRunnerTickOptions = {
  maxRuns?: number;
  maxWebhookEvents?: number;
};

export type AiRunnerTickResult = {
  processedRuns: number;
  processedWebhookEvents: number;
};

export interface AiFragmentConfig {
  apiKey?: string;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  baseUrl?: string;
  defaultModel?: AiModelRef;
  defaultDeepResearchModel?: AiModelRef;
  thinkingLevel?: AiThinkingLevel;
  thinkingBudgets?: AiThinkingBudgets;
  temperature?: number;
  maxTokens?: number;
  sessionId?: string;
  openai?: {
    reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    reasoningSummary?: "auto" | "detailed" | "concise" | null;
    serviceTier?: string;
  };
  webhookSecret?: string;
  enableRunnerTick?: boolean;
  dispatcher?: AiDispatcher;
  runner?: {
    maxWorkPerTick?: number;
    tick?: (
      options: AiRunnerTickOptions,
    ) => Promise<AiRunnerTickResult | void> | AiRunnerTickResult | void;
  };
  retries?: {
    maxAttempts?: number;
    baseDelayMs?: number;
  };
  storage?: {
    persistDeltas?: boolean;
    persistOpenAIRawResponses?: boolean;
    retentionDays?: number | null;
  };
}

const STREAM_EVENT_BUFFER_SIZE = 200;

const routes = [aiRoutesFactory] as const;

export function createAiFragment(
  config: AiFragmentConfig = {},
  fragnoConfig: FragnoPublicConfigWithDatabase,
) {
  return instantiate(aiFragmentDefinition)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(fragnoConfig)
    .build();
}

export function createAiFragmentClients(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(aiFragmentDefinition, fragnoConfig, routes);
  const runStream = builder.createMutator(
    "POST",
    "/threads/:threadId/runs:stream",
    (invalidate, params) => {
      const { threadId } = params.pathParams;
      if (!threadId) {
        return;
      }
      invalidate("GET", "/threads/:threadId/runs", { pathParams: { threadId } });
      invalidate("GET", "/threads/:threadId/messages", { pathParams: { threadId } });
    },
  );

  const streamEvents = computed(runStream.mutatorStore, ({ data }) => {
    if (!Array.isArray(data)) {
      return [] as AiRunLiveEvent[];
    }

    const items = data as AiRunLiveEvent[];
    if (items.length <= STREAM_EVENT_BUFFER_SIZE) {
      return items;
    }

    return items.slice(-STREAM_EVENT_BUFFER_SIZE);
  });

  const streamText = computed(streamEvents, (events) => {
    let text = "";

    for (const event of events) {
      if (event.type === "output.text.delta") {
        text += event.delta;
      } else if (event.type === "output.text.done") {
        text = event.text;
      }
    }

    return text;
  });

  const streamStatus = computed(streamEvents, (events) => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (!event) {
        continue;
      }

      if (event.type === "run.final") {
        return { runId: event.runId, status: event.status, run: event.run };
      }

      if (event.type === "run.status") {
        return { runId: event.runId, status: event.status };
      }
    }

    return undefined;
  });

  const streamError = computed(runStream.mutatorStore, ({ error }) => error);

  const startRunStream = async ({
    threadId,
    input,
  }: {
    threadId: string;
    input?: {
      type?: string;
      executionMode?: string;
      inputMessageId?: string;
      modelId?: string;
      thinkingLevel?: string;
      systemPrompt?: string | null;
    };
  }) => {
    return runStream.mutatorStore.mutate({
      body: input,
      path: { threadId },
    });
  };

  return {
    useThreads: builder.createHook("/threads"),
    useThread: builder.createHook("/threads/:threadId"),
    useMessages: builder.createHook("/threads/:threadId/messages"),
    useRuns: builder.createHook("/threads/:threadId/runs"),
    useRun: builder.createHook("/runs/:runId"),
    useRunEvents: builder.createHook("/runs/:runId/events"),
    useArtifacts: builder.createHook("/runs/:runId/artifacts"),
    useArtifact: builder.createHook("/artifacts/:artifactId"),
    useCreateThread: builder.createMutator("POST", "/threads", (invalidate) => {
      invalidate("GET", "/threads", { pathParams: undefined });
    }),
    useUpdateThread: builder.createMutator("PATCH", "/threads/:threadId", (invalidate, params) => {
      const { threadId } = params.pathParams;
      if (!threadId) {
        return;
      }
      invalidate("GET", "/threads/:threadId", { pathParams: { threadId } });
      invalidate("GET", "/threads", { pathParams: undefined });
    }),
    useDeleteThread: builder.createMutator(
      "DELETE",
      "/admin/threads/:threadId",
      (invalidate, params) => {
        const { threadId } = params.pathParams;
        if (!threadId) {
          return;
        }
        invalidate("GET", "/threads/:threadId", { pathParams: { threadId } });
        invalidate("GET", "/threads", { pathParams: undefined });
      },
    ),
    useAppendMessage: builder.createMutator(
      "POST",
      "/threads/:threadId/messages",
      (invalidate, params) => {
        const { threadId } = params.pathParams;
        if (!threadId) {
          return;
        }
        invalidate("GET", "/threads/:threadId/messages", { pathParams: { threadId } });
        invalidate("GET", "/threads", { pathParams: undefined });
      },
    ),
    useCreateRun: builder.createMutator("POST", "/threads/:threadId/runs", (invalidate, params) => {
      const { threadId } = params.pathParams;
      if (!threadId) {
        return;
      }
      invalidate("GET", "/threads/:threadId/runs", { pathParams: { threadId } });
    }),
    useCreateRunStream: runStream,
    useCancelRun: builder.createMutator("POST", "/runs/:runId/cancel", (invalidate, params) => {
      const { runId } = params.pathParams;
      if (!runId) {
        return;
      }
      invalidate("GET", "/runs/:runId", { pathParams: { runId } });
      invalidate("GET", "/runs/:runId/events", { pathParams: { runId } });
    }),
    useRunStream: builder.createStore({
      startRunStream,
      text: streamText,
      status: streamStatus,
      events: streamEvents,
      error: streamError,
    }),
    useStreamText: builder.createStore(streamText),
    useStreamStatus: builder.createStore(streamStatus),
    useStreamEvents: builder.createStore(streamEvents),
    useStreamError: builder.createStore(streamError),
    startRunStream,
  };
}

export { aiFragmentDefinition, aiFragmentDefinition as aiDefinition } from "./definition";
export { aiRoutesFactory } from "./routes";
export type {
  AiArtifact,
  AiMessage,
  AiRun,
  AiRunExecutionMode,
  AiRunEvent,
  AiRunStatus,
  AiRunType,
  AiThread,
  AiRunLiveEvent,
  AiToolCallStatus,
  AiWebhookEvent,
} from "./definition";
export type { FragnoRouteConfig } from "@fragno-dev/core";
