import { createClientBuilder } from "@fragno-dev/core/client";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import {
  FragnoClientApiError,
  FragnoClientFetchError,
  FragnoClientUnknownApiError,
} from "@fragno-dev/core/client";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { instantiate } from "@fragno-dev/core";
import type { FragnoDispatcher } from "@fragno-dev/core";
import { atom, computed } from "nanostores";
import { aiFragmentDefinition, type AiRunLiveEvent, type AiThinkingLevel } from "./definition";
import type { AiLogger } from "./logging";
import { aiRoutesFactory } from "./routes";
import type { AiToolPolicy, AiToolPolicyContext, AiToolPolicyDecision } from "./tool-policy";

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

export type { AiLogger };
export type { AiToolPolicy, AiToolPolicyContext, AiToolPolicyDecision };

export type AiWakeEvent =
  | { type: "run.queued"; runId: string }
  | { type: "openai.webhook.received"; openaiEventId: string; responseId: string };

export type AiDispatcher = FragnoDispatcher<AiWakeEvent>;

export type AiRateLimitScope = "webhook_openai" | "runner_tick";

export type AiRateLimiter = (context: {
  scope: AiRateLimitScope;
  headers: Headers;
}) => boolean | Promise<boolean>;

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
  // Expose POST /ai/_runner/tick for manual/cron recovery; prefer dispatcher wake-ups for normal flow.
  enableRunnerTick?: boolean;
  dispatcher?: AiDispatcher;
  rateLimiter?: AiRateLimiter;
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
  limits?: {
    maxMessageBytes?: number;
    maxArtifactBytes?: number;
  };
  storage?: {
    persistDeltas?: boolean;
    persistOpenAIRawResponses?: boolean;
    retentionDays?: number | null;
  };
  toolPolicy?: AiToolPolicy;
  logger?: AiLogger;
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
  const streamEvents = atom<AiRunLiveEvent[]>([]);
  const streamError = atom<Error | undefined>(undefined);

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
    streamEvents.set([]);
    streamError.set(undefined);

    const { fetcher, defaultOptions } = builder.getFetcher();
    const url = builder.buildUrl("/threads/:threadId/runs:stream", { path: { threadId } });

    let response: Response;
    try {
      const headers = new Headers(defaultOptions?.headers ?? {});
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }

      response = await fetcher(url, {
        ...defaultOptions,
        method: "POST",
        headers,
        body: JSON.stringify(input ?? {}),
      });
    } catch (err) {
      const fetchError = FragnoClientFetchError.fromUnknownFetchError(err);
      streamError.set(fetchError);
      throw fetchError;
    }

    if (!response.ok) {
      const apiError = await FragnoClientApiError.fromResponse(response);
      streamError.set(apiError);
      throw apiError;
    }

    if (!response.body) {
      const bodyError = new FragnoClientFetchError("Response body is empty", "NO_BODY");
      streamError.set(bodyError);
      throw bodyError;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const collectedEvents: AiRunLiveEvent[] = [];

    const appendEvent = (event: AiRunLiveEvent) => {
      collectedEvents.push(event);
      const nextEvents = [...streamEvents.get(), event];
      if (nextEvents.length > STREAM_EVENT_BUFFER_SIZE) {
        nextEvents.splice(0, nextEvents.length - STREAM_EVENT_BUFFER_SIZE);
      }
      streamEvents.set(nextEvents);
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (line) {
            try {
              const event = JSON.parse(line) as AiRunLiveEvent;
              appendEvent(event);
            } catch (err) {
              throw new FragnoClientUnknownApiError("Failed to parse NDJSON line", 500, {
                cause: err instanceof Error ? err : undefined,
              });
            }
          }

          newlineIndex = buffer.indexOf("\n");
        }
      }

      const trailing = buffer.trim();
      if (trailing) {
        try {
          const event = JSON.parse(trailing) as AiRunLiveEvent;
          appendEvent(event);
        } catch (err) {
          throw new FragnoClientUnknownApiError("Failed to parse NDJSON line", 500, {
            cause: err instanceof Error ? err : undefined,
          });
        }
      }
    } catch (err) {
      const streamErr =
        err instanceof Error
          ? err
          : new FragnoClientUnknownApiError("Unknown streaming error", 500, {
              cause: err,
            });
      streamError.set(streamErr);
      throw streamErr;
    }

    builder.invalidate("GET", "/threads/:threadId/runs", { pathParams: { threadId } });
    builder.invalidate("GET", "/threads/:threadId/messages", { pathParams: { threadId } });

    return collectedEvents;
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
    useCreateRunStream: builder.createStore({ startRunStream }),
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
export { aiSchema } from "./schema";
export { aiRoutesFactory } from "./routes";
export { createAiRunner, runExecutor } from "./runner";
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
