import type { LofiSqliteReplicaStatus } from "./replica";

/**
 * What a page asks of its replica worker. `kind` names the view engine that maintains the view,
 * and `query` is in that engine's terms.
 */
export type LofiSqliteRequest =
  | { type: "subscribe"; id: number; kind: string; query: unknown }
  | { type: "unsubscribe"; id: number };

/**
 * What the worker tells the page. It sends `status` once a tab has opened the replica and whenever
 * the status changes, or `failed` if the replica could not open.
 */
export type LofiSqliteResponse =
  | { type: "status"; status: LofiSqliteReplicaStatus }
  | { type: "failed"; message: string }
  | LofiSqliteViewResponse;

export type LofiSqliteViewResponse =
  | { type: "data"; id: number; data: unknown }
  | { type: "error"; id: number; message: string };

/**
 * What the workers of one replica's tabs tell each other on their shared channel. The leader, the
 * tab that holds the replica, answers each other tab's views on that tab's own channel.
 */
export type LofiSqliteTabMessage =
  /** A tab became the leader: the others send their views again. */
  | { type: "leader" }
  /** The leader still runs. */
  | { type: "heartbeat" }
  /** A tab opened and asks the leader for the status. */
  | { type: "hello" }
  | { type: "status"; status: LofiSqliteReplicaStatus }
  | { type: "failed"; message: string }
  | (LofiSqliteRequest & { tab: string });

/** A `MessagePort`, a `Worker`, or a dedicated worker's global scope. */
export type LofiSqlitePort = {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
};
