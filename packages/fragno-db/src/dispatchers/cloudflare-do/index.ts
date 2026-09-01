import { getDurableHooksToken } from "../../hooks/durable-hooks-fragment";
import {
  createDurableHooksProcessorGroup,
  type DurableHooksErrorObserver,
} from "../../hooks/durable-hooks-processor";
import { getDurableHooksRuntimeByToken } from "../../hooks/durable-hooks-runtime";
import type { DurableHooksInstrumentation } from "../../hooks/hooks";
import type { AnyFragnoInstantiatedDatabaseFragment } from "../../mod";
import {
  createDurableHooksDispatcherDurableObject,
  type DurableHooksDispatcherDurableObjectFactory,
  type DurableHooksDispatcherDurableObjectHandler,
  type DurableHooksDispatcherDurableObjectState,
} from "./dispatcher";

export type DurableHooksProcessorOptions = {
  onProcessError?: DurableHooksErrorObserver;
  /**
   * Overrides each fragment's durable-hook instrumentation before the fragments are exposed.
   */
  instrumentation?: DurableHooksInstrumentation;
};

export type {
  DurableHooksDispatcherDurableObjectFactory,
  DurableHooksDispatcherDurableObjectHandler,
  DurableHooksDispatcherDurableObjectState,
};

export function createDurableHooksProcessor<TEnv>(
  fragments: readonly AnyFragnoInstantiatedDatabaseFragment[],
  options: DurableHooksProcessorOptions = {},
): DurableHooksDispatcherDurableObjectFactory<TEnv> {
  const processor = createDurableHooksProcessorGroup(fragments, {
    onError: options.onProcessError,
    instrumentation: options.instrumentation,
  });
  const factory = createDurableHooksDispatcherDurableObject<TEnv>({
    createProcessor: () => processor,
    onProcessError: options.onProcessError,
  });

  return (state, env) => {
    const handler = factory(state, env);
    const notifier = {
      notify: async (context: Parameters<NonNullable<typeof handler.notify>>[0]) => {
        await handler.notify?.(context);
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

    return handler;
  };
}
