import type { LofiSqliteReplicaStatus } from "./replica";

/**
 * What a page asks of its replica worker: a view, which the leading tab maintains, or to close,
 * which the worker answers with `closed` once it closed and, if it led, handed over.
 */
export type LofiSqliteRequest = LofiSqliteViewRequest | { type: "close" };

/** A view request. `kind` names the view engine that maintains the view; `query` is in its terms. */
export type LofiSqliteViewRequest =
  | { type: "subscribe"; id: number; kind: string; query: unknown }
  | { type: "unsubscribe"; id: number };

/**
 * What the worker tells the page. It sends `status` once a tab has opened the replica and whenever
 * the status changes. A tab that could not open it sends `failed` if it never will, because the
 * backend was replaced, or `unavailable` if it tries again, as after a failed request.
 */
export type LofiSqliteResponse =
  | { type: "status"; status: LofiSqliteReplicaStatus }
  | { type: "closed" }
  | { type: "failed"; message: string }
  | { type: "unavailable"; message: string }
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
  | { type: "unavailable"; message: string }
  | (LofiSqliteViewRequest & { tab: string });

/** A `MessagePort`, a `Worker`, or a dedicated worker's global scope. */
export type LofiSqlitePort = {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
};
