import { getDurableHooksToken } from "../../hooks/durable-hooks-fragment";
import {
  createDurableHooksProcessorGroup,
  type DurableHooksErrorObserver,
} from "../../hooks/durable-hooks-processor";
import { getDurableHooksRuntimeByToken } from "../../hooks/durable-hooks-runtime";
import type { AnyFragnoInstantiatedDatabaseFragment } from "../../mod";
import { createDurableHooksDispatcher, type DurableHooksDispatcher } from "./dispatcher";

export type DurableHooksProcessorOptions = {
  pollIntervalMs?: number;
  onError?: DurableHooksErrorObserver;
};

export type { DurableHooksDispatcher };

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
    notify: async (context: Parameters<typeof dispatcher.notify>[0]) => {
      await dispatcher.notify(context);
    },
  };

  for (const fragment of fragments) {
    const durableHooksToken = getDurableHooksToken(fragment);
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
