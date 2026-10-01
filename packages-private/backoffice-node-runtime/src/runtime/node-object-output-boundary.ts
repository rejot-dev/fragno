import { AsyncLocalStorage } from "node:async_hooks";

/** Records which object storage position an internal RPC result can reveal. */
export type NodeObjectOutputBoundary = {
  assertOpen(): void;
  observeStoragePosition(position: number): void;
};

const activeNodeObjectOutputBoundary = new AsyncLocalStorage<NodeObjectOutputBoundary>();

/** Runs an internal object RPC under the external output boundary that owns its result. */
export function runWithNodeObjectOutputBoundary<TResult>(
  boundary: NodeObjectOutputBoundary,
  operation: () => TResult | Promise<TResult>,
): TResult | Promise<TResult> {
  boundary.assertOpen();
  return activeNodeObjectOutputBoundary.run(boundary, operation);
}

/** Returns the external output boundary inherited by the current object event, when present. */
export function currentNodeObjectOutputBoundary(): NodeObjectOutputBoundary | null {
  return activeNodeObjectOutputBoundary.getStore() ?? null;
}
