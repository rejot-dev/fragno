import type { NodeDurableObjectStorage } from "./node-durable-object-storage";

/** Author-facing Durable Object state; event completion and Graft pushes remain worker-owned. */
export type NodeDurableObjectState = {
  readonly id: DurableObjectId;
  readonly storage: NodeDurableObjectStorage;
  blockConcurrencyWhile<TResult>(callback: () => TResult | Promise<TResult>): Promise<TResult>;
  waitUntil(promise: Promise<unknown>): void;
};
