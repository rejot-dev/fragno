import type { AnyFragnoInstantiatedDatabaseFragment } from "../../mod";
import { createDurableHooksProcessorGroup } from "../../hooks/durable-hooks-processor";
import { createDurableHooksDispatcher, type DurableHooksDispatcher } from "./dispatcher";

export type DurableHooksProcessorOptions = {
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
};

export type { DurableHooksDispatcher };

export function createDurableHooksProcessor(
  fragments: readonly AnyFragnoInstantiatedDatabaseFragment[],
  options: DurableHooksProcessorOptions = {},
): DurableHooksDispatcher {
  const processor = createDurableHooksProcessorGroup(fragments, {
    onError: options.onError,
  });
  return createDurableHooksDispatcher({
    processor,
    pollIntervalMs: options.pollIntervalMs,
    onError: options.onError,
  });
}
