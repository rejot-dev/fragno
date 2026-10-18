import type { NodeDurableObjectStorage } from "./node-durable-object-storage";

/** Named runtime object identity; names are local to their binding, not Cloudflare hexadecimal IDs. */
export type NodeDurableObjectId = {
  readonly name: string;
  toString(): string;
  equals(other: { toString(): string }): boolean;
};

/** State consumed by object implementations; event completion and Graft pushes remain worker-owned. */
export type NodeDurableObjectState = {
  readonly id: NodeDurableObjectId;
  readonly storage: NodeDurableObjectStorage;
  blockConcurrencyWhile<TResult>(callback: () => TResult | Promise<TResult>): Promise<TResult>;
  waitUntil(promise: Promise<unknown>): void;
};
