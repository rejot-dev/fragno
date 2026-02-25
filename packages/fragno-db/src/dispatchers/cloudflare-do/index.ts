import type { AnyFragnoInstantiatedDatabaseFragment } from "../../mod";
import { createDurableHooksProcessorGroup } from "../../hooks/durable-hooks-processor";
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

export function createDurableHooksProcessor<TEnv>(
  fragments: readonly AnyFragnoInstantiatedDatabaseFragment[],
  options: DurableHooksProcessorOptions = {},
): DurableHooksDispatcherDurableObjectFactory<TEnv> {
  const processor = createDurableHooksProcessorGroup(fragments, {
    onError: options.onProcessError,
  });
  return createDurableHooksDispatcherDurableObject<TEnv>({
    createProcessor: () => processor,
    onProcessError: options.onProcessError,
  });
}
