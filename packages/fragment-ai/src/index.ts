import { createClientBuilder } from "@fragno-dev/core/client";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { instantiate } from "@fragno-dev/core";
import { aiFragmentDefinition, type AiThinkingLevel } from "./definition";
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
    useCancelRun: builder.createMutator("POST", "/runs/:runId/cancel", (invalidate, params) => {
      const { runId } = params.pathParams;
      if (!runId) {
        return;
      }
      invalidate("GET", "/runs/:runId", { pathParams: { runId } });
      invalidate("GET", "/runs/:runId/events", { pathParams: { runId } });
    }),
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
  AiWebhookEvent,
} from "./definition";
export type { FragnoRouteConfig } from "@fragno-dev/core";
