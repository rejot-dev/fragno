// Source: /Users/wilco/dev/review-mode/apps/review-mode/workers/pi-fragment.do.ts
// Snapshot date: 2026-03-04

import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/cloudflare-do";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import { DurableObject } from "cloudflare:workers";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import { migrate } from "@fragno-dev/db";
import type { createPiFragment } from "@fragno-dev/pi-fragment";

import { getModel, streamSimple } from "@mariozechner/pi-ai";

import { createWorkflowsFragment, type WorkflowsFragmentConfig } from "./workflows-fragment";

const API_KEY_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "ZAI_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

const resolveEnvValue = (env: CloudflareEnv, key: string): string | undefined => {
  const record = env as unknown as Record<string, unknown>;
  const direct = record[key];
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  if (processEnv && processEnv[key]) {
    return processEnv[key];
  }
  return undefined;
};

const logApiKeyStatus = (env: CloudflareEnv) => {
  const status = Object.fromEntries(
    API_KEY_NAMES.map((key) => [key, Boolean(resolveEnvValue(env, key))]),
  ) as Record<string, boolean>;
  const anyKey = Object.values(status).some(Boolean);
  if (anyKey) {
    console.info("pi-fragment: API key detected", status);
  } else {
    console.warn("pi-fragment: no API keys detected", status);
  }
};

const summarizePayload = (payload: unknown) => {
  if (!payload || typeof payload !== "object") {
    return { type: typeof payload };
  }
  const record = payload as Record<string, unknown>;
  const messages = Array.isArray(record.messages) ? record.messages.length : undefined;
  const tools = Array.isArray(record.tools) ? record.tools.length : undefined;
  return {
    keys: Object.keys(record),
    messages,
    tools,
  };
};

const createLoggingStreamFn = () => {
  return async (...args: Parameters<typeof streamSimple>) => {
    const [model, context, options] = args;
    console.info("pi-fragment: LLM request", {
      provider: model.provider,
      model: model.id,
      api: model.api,
      messages: context.messages.length,
      tools: context.tools?.length ?? 0,
    });

    const stream = await streamSimple(model, context, {
      ...options,
      onPayload: (payload) => {
        console.debug("pi-fragment: LLM payload", {
          provider: model.provider,
          model: model.id,
          api: model.api,
          summary: summarizePayload(payload),
        });
        options?.onPayload?.(payload);
      },
    });

    stream
      .result()
      .then((message) => {
        console.info("pi-fragment: LLM response", {
          provider: message.provider,
          model: message.model,
          api: message.api,
          stopReason: message.stopReason,
          usage: message.usage,
        });
      })
      .catch((error) => {
        console.error("pi-fragment: LLM response failed", {
          error,
          provider: model.provider,
          model: model.id,
          api: model.api,
        });
      });

    return stream;
  };
};

export class PiFragment extends DurableObject<CloudflareEnv> {
  private fragment: ReturnType<typeof createPiFragment> | null = null;
  private hooksDispatcher: ReturnType<ReturnType<typeof createDurableHooksProcessor>> | null = null;
  private initPromise: Promise<void>;

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    const adapter = new SqlAdapter({
      dialect: new DurableObjectDialect({ ctx }),
      driverConfig: new CloudflareDurableObjectsDriverConfig(),
    });

    this.initPromise = ctx.blockConcurrencyWhile(async () => {
      const { createPi, createPiFragment, defineAgent } = await import("@fragno-dev/pi-fragment");
      logApiKeyStatus(env);
      const defaultModel = getModel("openai", "gpt-4.1") ?? getModel("openai", "gpt-4.1-mini");
      if (!defaultModel) {
        throw new Error("pi-fragment: default model not found in pi-ai registry");
      }
      console.info("pi-fragment: using default model", {
        provider: defaultModel.provider,
        model: defaultModel.id,
        api: defaultModel.api,
      });
      const pi = createPi()
        .agent(
          defineAgent("default", {
            systemPrompt: "You are helpful.",
            model: defaultModel,
            streamFn: createLoggingStreamFn(),
            onEvent: (event, context) => {
              if (event.type === "message_start" && event.message.role === "assistant") {
                console.info("pi-fragment: LLM stream started", {
                  sessionId: context.sessionId,
                  turnId: context.turnId,
                  provider: event.message.provider,
                  model: event.message.model,
                  api: event.message.api,
                });
              }
              if (event.type === "message_end" && event.message.role === "assistant") {
                console.info("pi-fragment: LLM stream ended", {
                  sessionId: context.sessionId,
                  turnId: context.turnId,
                  provider: event.message.provider,
                  model: event.message.model,
                  api: event.message.api,
                  stopReason: event.message.stopReason,
                  usage: event.message.usage,
                });
              }
            },
          }),
        )
        .build();
      const workflowsRuntime = defaultFragnoRuntime;
      const workflowsConfig: WorkflowsFragmentConfig<typeof pi.workflows> = {
        workflows: pi.workflows,
        runtime: workflowsRuntime,
      };
      const workflowsFragment = createWorkflowsFragment(workflowsConfig, {
        databaseAdapter: adapter,
        mountRoute: "/api/workflows",
      });
      type PiFragmentDeps = NonNullable<Parameters<typeof createPiFragment>[2]>;

      const piFragment = createPiFragment(
        pi.config,
        {
          databaseAdapter: adapter,
          mountRoute: "/api/pi-fragment",
        },
        {
          workflows: workflowsFragment.services as unknown as PiFragmentDeps["workflows"],
        },
      );
      this.fragment = piFragment;

      await migrate(workflowsFragment as unknown as Parameters<typeof migrate>[0]);
      await migrate(piFragment as unknown as Parameters<typeof migrate>[0]);

      // TODO: Remove filtering once fragno-db handles fragments without durable hooks upstream.
      const hookFragments = [workflowsFragment, piFragment].filter((fragment) => {
        const internal = fragment.$internal as { durableHooksToken?: object } | undefined;
        return Boolean(internal?.durableHooksToken);
      }) as unknown as Parameters<typeof createDurableHooksProcessor>[0];

      this.hooksDispatcher = hookFragments.length
        ? createDurableHooksProcessor<CloudflareEnv>(hookFragments, {
            onProcessError: (error) => {
              console.error("pi-fragment: durable hooks processing failed", error);
            },
          })(ctx, env)
        : null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.initPromise;
    if (!this.fragment) {
      throw new Error("PiFragment failed to initialize");
    }
    let proxyRequest = request;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const bodyText = await request.text();
      proxyRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: bodyText,
      });
    }
    const response = await this.fragment.handler(proxyRequest);
    return response;
  }

  async alarm(): Promise<void> {
    await this.initPromise;
    await this.hooksDispatcher?.alarm?.();
  }
}
