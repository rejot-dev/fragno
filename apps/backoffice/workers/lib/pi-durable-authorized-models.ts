import type { Models } from "@earendil-works/pi-ai/models";

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";

/** Authorization guards actual generation, compaction and deferred fetches, not fail-open extension hooks. */
export function createAuthorizedPiDurableModels(
  models: Models,
  authorize: () => Promise<void>,
): Models {
  function requestFailure(
    model: Model<string>,
    signal: AbortSignal | undefined,
    cause: unknown,
  ): AssistantMessage {
    return {
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
      stopReason: signal?.aborted ? "aborted" : "error",
      errorMessage: `PI_AGENT_MODEL_REQUEST_FAILED: ${cause instanceof Error ? cause.message : String(cause)}`,
      timestamp: Date.now(),
    };
  }

  async function authorizedMessage(
    model: Model<string>,
    signal: AbortSignal | undefined,
    request: () => Promise<AssistantMessage>,
  ): Promise<AssistantMessage> {
    try {
      await authorize();
      signal?.throwIfAborted();
    } catch (cause) {
      // Return the SDK's model-error shape so it settles inputs rather than faulting a task mid-run.
      return requestFailure(model, signal, cause);
    }
    return await request();
  }

  function authorizedStream(
    model: Model<string>,
    signal: AbortSignal | undefined,
    start: () => AssistantMessageEventStream,
  ): AssistantMessageEventStream {
    const output = createAssistantMessageEventStream();
    void (async () => {
      try {
        await authorize();
        signal?.throwIfAborted();
        const source = start();
        for await (const event of source) {
          output.push(event);
        }
        // Provider streams may complete with `end(message)` without emitting a `done` event.
        // Forwarding only events leaves the durable generation waiting forever and causes recovery
        // to append the same partial response on every wake.
        output.end(await source.result());
      } catch (cause) {
        const reason = signal?.aborted ? "aborted" : "error";
        const error = requestFailure(model, signal, cause);
        output.push({ type: "error", reason, error });
        output.end(error);
      }
    })();
    return output;
  }

  const guarded = {
    streamSimple: ((model, context, options) =>
      authorizedStream(model, options?.signal, () =>
        models.streamSimple(model, context, options),
      )) satisfies Models["streamSimple"],
    completeSimple: ((model, context, options) =>
      authorizedMessage(model, options?.signal, () =>
        models.completeSimple(model, context, options),
      )) satisfies Models["completeSimple"],
    fetchDeferred: ((model, handle, options) =>
      authorizedMessage(model, options?.signal, () =>
        models.fetchDeferred(model, handle, options),
      )) satisfies Models["fetchDeferred"],
  };
  return new Proxy(models, {
    get(target, key) {
      if (key === "streamSimple") {
        return guarded.streamSimple;
      }
      if (key === "completeSimple") {
        return guarded.completeSimple;
      }
      if (key === "fetchDeferred") {
        return guarded.fetchDeferred;
      }
      // Models uses instance-owned credentials; forwarded methods must retain their original receiver.
      const value = target[key as keyof Models];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
