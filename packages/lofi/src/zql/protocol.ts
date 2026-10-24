import type { LofiSqliteReplicaStatus } from "../sqlite/replica";
import type { AST } from "./vendor/zero-protocol/src/ast.ts";
import type { Format } from "./vendor/zero-types/src/format.ts";

/** What a page asks of the worker that maintains its ZQL views. */
export type LofiZqlRequest =
  | { type: "materialize"; id: number; schemaName: string; ast: AST; format: Format }
  | { type: "destroy"; id: number };

/**
 * What the worker tells the page. It sends `status` once the replica opened and whenever the
 * status changes, or `failed` once if the replica could not open.
 */
export type LofiZqlResponse =
  | { type: "status"; status: LofiSqliteReplicaStatus }
  | { type: "failed"; message: string }
  | { type: "data"; id: number; data: unknown }
  | { type: "error"; id: number; message: string };

/** A `MessagePort`, a `Worker`, or a dedicated worker's global scope. */
export type LofiZqlPort = {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
};
