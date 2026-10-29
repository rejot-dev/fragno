import { atom, onMount, type ReadableAtom } from "nanostores";

import type { LofiSchemaRegistration } from "../types";
import type {
  LofiSqlitePort,
  LofiSqliteRequest,
  LofiSqliteResponse,
  LofiSqliteViewResponse,
} from "./protocol";
import type { LofiSqliteReplicaStatus } from "./replica";

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
   * A live view that the worker's view engine of `kind` maintains, such as a read view of
   * `lofiSqliteReadViews`. `query` must survive `postMessage`.
   */
  view<TData>(kind: string, query: unknown): LofiSqliteView<TData>;
};

/**
 * Connects to the replica through `port`, to a worker serving `serveLofiSqlite`, once a tab has
 * opened the replica or failed to and tries again, whose error the status then holds. Rejects if
 * the backend was replaced since the page loaded. `schemas` are the worker replica's `schemas` and
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

  const view = <TData>(kind: string, query: unknown): LofiSqliteView<TData> => {
    const $result = atom<LofiSqliteViewResult<TData>>({ status: "loading" });
    onMount($result, () => {
      const id = nextId++;
      receivers.set(id, (response) => {
        if (response.type === "error") {
          $result.set({ status: "error", message: response.message });
          return;
        }
        $result.set({ status: "ready", data: response.data as TData });
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
      view,
    };

    const updateStatus = (next: LofiSqliteReplicaStatus) => {
      const opening = status === null;
      status = next;
      if (opening) {
        resolve(client);
      }
      for (const listener of statusListeners) {
        listener();
      }
    };
    options.port.onmessage = (event: MessageEvent<LofiSqliteResponse>) => {
      const response = event.data;
      switch (response.type) {
        case "status":
          updateStatus(response.status);
          break;
        case "failed":
          if (status === null) {
            reject(new Error(response.message));
          } else {
            updateStatus({ ...status, error: response.message });
          }
          break;
        case "unavailable":
          // Until a tab opens the replica, nothing says how far it caught up.
          updateStatus(
            status === null
              ? { phase: "catching-up", fraction: null, error: response.message }
              : { ...status, error: response.message },
          );
          break;
        case "data":
        case "error":
          receivers.get(response.id)?.(response);
          break;
      }
    };
  });
}
