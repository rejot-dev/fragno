import type { AnySchema } from "@fragno-dev/db/schema";
import { atom, onMount, type ReadableAtom } from "nanostores";

import { registeredSchemaName } from "../sqlite/layout";
import type { LofiSqliteReplicaStatus } from "../sqlite/replica";
import type { LofiSchemaRegistration } from "../types";
import type { LofiZqlPort, LofiZqlRequest, LofiZqlResponse } from "./protocol";
import { lofiZqlSchema, type LofiZqlSchema } from "./schema";
import { createBuilder } from "./vendor/zql/src/query/create-builder.ts";
import { asQueryInternals } from "./vendor/zql/src/query/query-internals.ts";
import type { HumanReadable, Query } from "./vendor/zql/src/query/query.ts";
import type { SchemaQuery } from "./vendor/zql/src/query/schema-query.ts";

export type LofiZqlResult<TData> =
  | { status: "loading" }
  | { status: "ready"; data: TData }
  | { status: "error"; message: string };

/** A store of a query's live result. */
export type LofiZqlView<TData> = ReadableAtom<LofiZqlResult<TData>>;

export type LofiZqlSchemaClient<TSchema extends AnySchema> = {
  /** Starts ZQL queries on the schema's tables. */
  readonly query: SchemaQuery<LofiZqlSchema<TSchema>>;
  /**
   * A store of the query's live result. The worker maintains the result while the store has
   * listeners, and drops it when the last one leaves.
   */
  store<TTable extends keyof TSchema["tables"] & string, TReturn>(
    query: Query<TTable, LofiZqlSchema<TSchema>, TReturn>,
  ): LofiZqlView<HumanReadable<TReturn>>;
};

export type LofiZqlClient = {
  /**
   * The replica's status, as the worker last reported it. `getStatus` and `subscribeStatus` need no
   * `this`, so they can go to React's `useSyncExternalStore` directly.
   */
  getStatus: () => LofiSqliteReplicaStatus;
  /** Calls `listener` whenever `getStatus` changes. Returns the unsubscribe function. */
  subscribeStatus: (listener: () => void) => () => void;
  /** Queries one of the schemas the worker's replica holds. */
  forSchema<const TSchema extends AnySchema>(schema: TSchema): LofiZqlSchemaClient<TSchema>;
};

/**
 * Connects to the replica that a worker serving `serveLofiZql` maintains, through `port`, once the
 * worker reports it open; rejects if it fails to open. `schemas` are the worker replica's `schemas`
 * and `localSchemas`.
 */
export function connectLofiZql(options: {
  port: LofiZqlPort;
  schemas: LofiSchemaRegistration[];
}): Promise<LofiZqlClient> {
  const receivers = new Map<number, (response: ViewResponse) => void>();
  const statusListeners = new Set<() => void>();
  let nextId = 0;
  const send = (request: LofiZqlRequest) => {
    options.port.postMessage(request);
  };

  return new Promise((resolve, reject) => {
    let status: LofiSqliteReplicaStatus | null = null;
    const client: LofiZqlClient = {
      // The client is handed out only after the first status arrived.
      getStatus: () => status!,
      subscribeStatus(listener) {
        statusListeners.add(listener);
        return () => {
          statusListeners.delete(listener);
        };
      },
      forSchema(schema) {
        const registration = options.schemas.find((candidate) => candidate.schema === schema);
        if (!registration) {
          throw new Error(`Schema "${schema.name}" is not one of the replica's schemas.`);
        }
        const schemaName = registeredSchemaName(registration);
        return {
          query: createBuilder(lofiZqlSchema(schema)),
          store(query) {
            const { ast, format } = asQueryInternals(query);
            const $result = atom<LofiZqlResult<never>>({ status: "loading" });
            onMount($result, () => {
              const id = nextId++;
              receivers.set(id, (response) => {
                $result.set(
                  response.type === "data"
                    ? { status: "ready", data: response.data as never }
                    : { status: "error", message: response.message },
                );
              });
              send({ type: "materialize", id, schemaName, ast, format });
              return () => {
                receivers.delete(id);
                send({ type: "destroy", id });
                $result.set({ status: "loading" });
              };
            });
            return $result;
          },
        };
      },
    };

    options.port.onmessage = (event: MessageEvent<LofiZqlResponse>) => {
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

type ViewResponse = Extract<LofiZqlResponse, { id: number }>;
