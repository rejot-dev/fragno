import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  registerApiProvider,
  unregisterApiProviders,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";

import type { PiHarnessAgentOptions } from "./run-pi-harness-step";

const createStreamFailureMessage = (model: Model<Api>, error: unknown): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "error",
  errorMessage: error instanceof Error ? error.message : String(error),
  timestamp: Date.now(),
});

/**
 * Test-only adapter for Pi harness stream injection.
 *
 * Production harness runs should rely on a normal `Model` whose `api` is backed by a registered
 * pi-ai provider. This helper exists for tests/scenarios that pass an inline `streamFn` so they can
 * drive the agent with deterministic scripted streams without touching real model providers.
 *
 * `AgentHarness` ultimately calls pi-ai's global `streamSimple(model, context, options)` path.
 * Because the low-level harness does not accept a stream function directly, this adapter temporarily
 * registers a provider for `agent.model.api` and routes that provider to the test `streamFn`.
 *
 * The registration is process-global and keyed by API. Keep it scoped to a single harness step and
 * always call the returned unregister function in `finally` (as `runPiHarnessStep` does). Do not use
 * this as a general runtime extension point; register a real pi-ai provider instead.
 */
export const registerAgentStreamFn = <TTool extends AgentTool>(
  agent: PiHarnessAgentOptions<TTool>,
  sourceId: string,
): (() => void) => {
  if (!agent.streamFn) {
    return () => {};
  }

  const streamSimple = (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const proxy = createAssistantMessageEventStream();

    void (async () => {
      let finalMessage: AssistantMessage | undefined;

      try {
        const source = await agent.streamFn?.(model, context, options);
        if (!source) {
          return;
        }

        for await (const event of source) {
          proxy.push(event);
        }
      } catch (error: unknown) {
        finalMessage = createStreamFailureMessage(model, error);
      } finally {
        proxy.end(finalMessage);
      }
    })();

    return proxy;
  };

  registerApiProvider(
    {
      api: agent.model.api,
      stream: streamSimple as unknown as (
        model: Model<Api>,
        context: Context,
        options?: StreamOptions,
      ) => AssistantMessageEventStream,
      streamSimple,
    },
    sourceId,
  );

  return () => unregisterApiProviders(sourceId);
};
