import { createClientBuilder } from "@fragno-dev/core/client";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { instantiate } from "@fragno-dev/core";
import { aiFragmentDefinition, type AiThinkingLevel } from "./definition";

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

const routes = [] as const;

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
  createClientBuilder(aiFragmentDefinition, fragnoConfig, routes);

  return {};
}

export { aiFragmentDefinition, aiFragmentDefinition as aiDefinition } from "./definition";
export type {
  AiArtifact,
  AiMessage,
  AiRun,
  AiRunExecutionMode,
  AiRunStatus,
  AiRunType,
  AiThread,
  AiWebhookEvent,
} from "./definition";
export type { FragnoRouteConfig } from "@fragno-dev/core";
