import { atom, onMount, type ReadableAtom } from "nanostores";

import type { LofiSchemaRegistration } from "../types";
import type {
  LofiSqlitePort,
  LofiSqliteRequest,
  LofiSqliteResponse,
  LofiSqliteViewResponse,
} from "./protocol";
import {
  decodeLofiSqliteQueryRows,
  type LofiSqliteQuery,
  type LofiSqliteQueryRow,
  type LofiSqliteResultColumn,
} from "./query";
import type { LofiSqliteReplicaStatus } from "./replica";
import type { LofiSqliteRawRow, LofiSqliteSqlViewQuery } from "./views";

export type LofiSqliteViewResult<TData> =
  | { status: "loading" }
  | { status: "ready"; data: TData }
  | { status: "error"; message: string };

/**
 * A store of a query's live result. The leading tab's worker maintains the result while the store
 * has listeners, and drops it when the last one leaves.
 */
export type LofiSqliteView<TData> = ReadableAtom<LofiSqliteViewResult<TData>>;

export type LofiSqliteClient = {
  /** The worker replica's `schemas` and `localSchemas`. */
  readonly schemas: readonly LofiSchemaRegistration[];
  /**
   * The replica's status, as the worker last reported it. `getStatus` and `subscribeStatus` need no
   * `this`, so they can go to React's `useSyncExternalStore` directly.
   */
  getStatus: () => LofiSqliteReplicaStatus;
  /** Calls `listener` whenever `getStatus` changes. Returns the unsubscribe function. */
  subscribeStatus: (listener: () => void) => () => void;
  /**
   * A live SQL view: its rows, decoded with the query's declared columns. The worker runs the
   * query again after every batch the replica applies, and sends the rows when they changed.
   */
  sql<TColumns extends Record<string, LofiSqliteResultColumn>>(
    query: LofiSqliteQuery<TColumns>,
  ): LofiSqliteView<LofiSqliteQueryRow<TColumns>[]>;
  /**
   * A live view that the worker's view engine of `kind` maintains, for packages that add one.
   * `query` must survive `postMessage`.
   */
  view<TData>(kind: string, query: unknown): LofiSqliteView<TData>;
};

/**
 * Connects to the replica through `port`, to a worker serving `serveLofiSqlite`, once a tab has
 * opened the replica; rejects if it fails to open. `schemas` are the worker replica's `schemas` and
 * `localSchemas`.
 */
export function connectLofiSqlite(options: {
  port: LofiSqlitePort;
  schemas: LofiSchemaRegistration[];
}): Promise<LofiSqliteClient> {
  const receivers = new Map<number, (response: LofiSqliteViewResponse) => void>();
  const statusListeners = new Set<() => void>();
  let nextId = 0;
  const send = (request: LofiSqliteRequest) => {
    options.port.postMessage(request);
  };

  const view = <TData>(
    kind: string,
    query: unknown,
    decode: (data: unknown) => TData,
  ): LofiSqliteView<TData> => {
    const $result = atom<LofiSqliteViewResult<TData>>({ status: "loading" });
    onMount($result, () => {
      const id = nextId++;
      receivers.set(id, (response) => {
        if (response.type === "error") {
          $result.set({ status: "error", message: response.message });
          return;
        }
        try {
          $result.set({ status: "ready", data: decode(response.data) });
        } catch (error) {
          $result.set({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
      send({ type: "subscribe", id, kind, query });
      return () => {
        receivers.delete(id);
        send({ type: "unsubscribe", id });
        $result.set({ status: "loading" });
      };
    });
    return $result;
  };

  return new Promise((resolve, reject) => {
    let status: LofiSqliteReplicaStatus | null = null;
    const client: LofiSqliteClient = {
      schemas: options.schemas,
      // The client is handed out only after the first status arrived.
      getStatus: () => status!,
      subscribeStatus(listener) {
        statusListeners.add(listener);
        return () => {
          statusListeners.delete(listener);
        };
      },
      sql(query) {
        const sqlQuery: LofiSqliteSqlViewQuery = { sql: query.sql, params: query.params };
        return view("sql", sqlQuery, (rows) =>
          decodeLofiSqliteQueryRows(query, rows as LofiSqliteRawRow[]),
        );
      },
      view: (kind, query) => view(kind, query, (data) => data as never),
    };

    options.port.onmessage = (event: MessageEvent<LofiSqliteResponse>) => {
      const response = event.data;
      switch (response.type) {
        case "status": {
          const opening = status === null;
          status = response.status;
          if (opening) {
            resolve(client);
          }
          for (const listener of statusListeners) {
            listener();
          }
          break;
        }
        case "failed":
          reject(new Error(response.message));
          break;
        case "data":
        case "error":
          receivers.get(response.id)?.(response);
          break;
      }
    };
  });
}
