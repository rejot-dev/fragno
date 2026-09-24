/**
 * Adapted from Kysely's QueryExecutorBase
 * Modified from: https://github.com/kysely-org/kysely
 * License: MIT
 * Copyright (c) 2022 Sami Koskimäki
 *
 * Simplified to remove query compilation, streaming, and batching.
 */

import type { ConnectionProvider } from "../connection/connection-provider";
import type { DatabaseConnection, CompiledQuery, QueryResult } from "../sql-driver";
import type { GenericSQLPlugin } from "./plugin";
import type { QueryExecutor } from "./query-executor";

const NO_PLUGINS: ReadonlyArray<GenericSQLPlugin> = Object.freeze([]);

export abstract class QueryExecutorBase implements QueryExecutor {
  readonly #plugins: ReadonlyArray<GenericSQLPlugin>;

  constructor(plugins: ReadonlyArray<GenericSQLPlugin> = NO_PLUGINS) {
    this.#plugins = plugins;
  }

  get plugins(): ReadonlyArray<GenericSQLPlugin> {
    return this.#plugins;
  }

  abstract provideConnection<T>(
    consumer: (connection: DatabaseConnection) => Promise<T>,
  ): Promise<T>;

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    return await this.provideConnection(async (connection) => {
      const result = await connection.executeQuery(compiledQuery);
      return await this.#transformResult(result);
    });
  }

  async *streamQuery<R>(
    compiledQuery: CompiledQuery,
    chunkSize: number,
  ): AsyncIterableIterator<QueryResult<R>> {
    // ConnectionProvider's callback owns the connection; a one-chunk handoff keeps it
    // alive through the caller's awaits without buffering an unbounded result set.
    let pending: QueryResult<R> | undefined;
    let wakeConsumer = () => {};
    let resumeProducer = () => {};
    let finished = false;
    let stopped = false;
    let failure: Error | undefined;
    const producer = (async () => {
      try {
        await this.provideConnection(async (connection) => {
          for await (const result of connection.streamQuery<R>(compiledQuery, chunkSize)) {
            if (stopped) {
              break;
            }
            pending = await this.#transformResult(result);
            await new Promise<void>((resolve) => {
              resumeProducer = resolve;
              wakeConsumer();
            });
            if (stopped) {
              break;
            }
          }
        });
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      } finally {
        finished = true;
        wakeConsumer();
      }
    })();
    try {
      while (!finished || pending !== undefined) {
        if (pending === undefined) {
          await new Promise<void>((resolve) => {
            wakeConsumer = resolve;
          });
          continue;
        }
        const chunk = pending;
        pending = undefined;
        yield chunk;
        resumeProducer();
      }
      await producer;
      if (failure !== undefined) {
        throw failure;
      }
    } finally {
      stopped = true;
      resumeProducer();
      await producer;
    }
  }

  abstract withConnectionProvider(connectionProvider: ConnectionProvider): QueryExecutorBase;

  abstract withPlugin(plugin: GenericSQLPlugin): QueryExecutorBase;

  abstract withoutPlugins(): QueryExecutorBase;

  // oxlint-disable-next-line no-explicit-any
  async #transformResult<T>(result: QueryResult<any>): Promise<QueryResult<T>> {
    for (const plugin of this.#plugins) {
      result = await plugin.transformResult({ result });
    }

    return result;
  }
}
