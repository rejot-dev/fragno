import type { AnyFragnoInstantiatedDatabaseFragment } from "../../mod";
import { createDurableHooksProcessorGroup } from "../../hooks/durable-hooks-processor";
import { getDurableHooksRuntimeByToken } from "../../hooks/durable-hooks-runtime";
import { createDurableHooksDispatcher, type DurableHooksDispatcher } from "./dispatcher";

export type DurableHooksProcessorOptions = {
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
};

export type { DurableHooksDispatcher };

type DurableHooksInternal = {
  durableHooksToken?: object;
};

export function createDurableHooksProcessor(
  fragments: readonly AnyFragnoInstantiatedDatabaseFragment[],
  options: DurableHooksProcessorOptions = {},
): DurableHooksDispatcher {
  const processor = createDurableHooksProcessorGroup(fragments, {
    onError: options.onError,
  });
  const dispatcher = createDurableHooksDispatcher({
    processor,
    pollIntervalMs: options.pollIntervalMs,
    onError: options.onError,
  });

  const notifier = {
    notify: (context: Parameters<typeof dispatcher.notify>[0]) => {
      dispatcher.notify(context);
    },
  };

  for (const fragment of fragments) {
    const internal = fragment.$internal as DurableHooksInternal | undefined;
    const durableHooksToken = internal?.durableHooksToken;
    if (!durableHooksToken) {
      continue;
    }
    const runtime = getDurableHooksRuntimeByToken(durableHooksToken);
    if (!runtime) {
      continue;
    }
    runtime.config.notifier = notifier;
  }

  return dispatcher;
}
