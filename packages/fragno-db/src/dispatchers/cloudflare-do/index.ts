import type { AnyFragnoInstantiatedDatabaseFragment } from "../../mod";
import { createDurableHooksProcessorGroup } from "../../hooks/durable-hooks-processor";
import { getDurableHooksRuntimeByToken } from "../../hooks/durable-hooks-runtime";
import {
  createDurableHooksDispatcherDurableObject,
  type DurableHooksDispatcherDurableObjectFactory,
  type DurableHooksDispatcherDurableObjectHandler,
  type DurableHooksDispatcherDurableObjectState,
} from "./dispatcher";

export type DurableHooksProcessorOptions = {
  onProcessError?: (error: unknown) => void;
};

export type {
  DurableHooksDispatcherDurableObjectFactory,
  DurableHooksDispatcherDurableObjectHandler,
  DurableHooksDispatcherDurableObjectState,
};

type DurableHooksInternal = {
  durableHooksToken?: object;
};

export function createDurableHooksProcessor<TEnv>(
  fragments: readonly AnyFragnoInstantiatedDatabaseFragment[],
  options: DurableHooksProcessorOptions = {},
): DurableHooksDispatcherDurableObjectFactory<TEnv> {
  const processor = createDurableHooksProcessorGroup(fragments, {
    onError: options.onProcessError,
  });
  const factory = createDurableHooksDispatcherDurableObject<TEnv>({
    createProcessor: () => processor,
    onProcessError: options.onProcessError,
  });

  return (state, env) => {
    const handler = factory(state, env);
    const notifier = {
      notify: (context: Parameters<NonNullable<typeof handler.notify>>[0]) => {
        if (!handler.notify) {
          return;
        }
        return handler.notify(context);
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

    return handler;
  };
}
