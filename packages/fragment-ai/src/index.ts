import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { instantiate } from "@fragno-dev/core";
import type { FragnoDispatcher } from "@fragno-dev/core";
import { aiFragmentDefinition, type AiThinkingLevel } from "./definition";
import type { AiLogger } from "./logging";
import type { AiHistoryCompactor } from "./history";
import { aiRoutesFactory } from "./routes";
import type { AiToolRegistry } from "./tool-execution";
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
export type { AiHistoryCompactor };
export type { AiToolRegistry };
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

export type AiArtifactStore = {
  put: (params: {
    runId: string;
    threadId: string;
    type: string;
    title: string | null;
    mimeType: string;
    data: unknown;
    text: string | null;
  }) => { key: string; metadata?: unknown } | Promise<{ key: string; metadata?: unknown }>;
  delete?: (params: { key: string; metadata?: unknown }) => void | Promise<void>;
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
  history?: {
    maxMessages?: number;
    compactor?: AiHistoryCompactor;
  };
  storage?: {
    persistDeltas?: boolean;
    persistOpenAIRawResponses?: boolean;
    retentionDays?: number | null;
    artifactStore?: AiArtifactStore;
  };
  toolRegistry?: AiToolRegistry;
  toolPolicy?: AiToolPolicy;
  logger?: AiLogger;
}

const routes = [aiRoutesFactory] as const;

export function createAiFragment(
  fragnoConfig: FragnoPublicConfigWithDatabase,
  config: AiFragmentConfig = {},
) {
  return instantiate(aiFragmentDefinition)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(fragnoConfig)
    .build();
}
export { createAiFragmentClients } from "./client/clients";

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
