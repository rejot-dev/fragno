import {
  openLofiSqliteReplica,
  type LofiSqliteReplica,
  type LofiSqliteReplicaOptions,
} from "../sqlite/replica";
import { LofiZqlEngine } from "./engine";
import type { LofiZqlPort, LofiZqlRequest, LofiZqlResponse } from "./protocol";
import type { LofiZqlSqliteDatabase } from "./wa-sqlite";

export type LofiZqlHostOptions = {
  replica: LofiSqliteReplicaOptions;
  /** Where the page's requests arrive and its views' data goes. */
  port: LofiZqlPort;
  openDatabase(options: { databaseName: string }): Promise<LofiZqlSqliteDatabase>;
};

export type LofiZqlHost = {
  readonly replica: LofiSqliteReplica;
  /** Stops answering the page, then closes the replica like `LofiSqliteReplica.close`. */
  close(): Promise<void>;
};

/**
 * Opens a SQLite replica and maintains the ZQL views the page on the other end of `port` asks
 * for, incrementally as outbox entries arrive. The page learns the replica's status, or why it
 * failed to open.
 */
export async function serveLofiZql(options: LofiZqlHostOptions): Promise<LofiZqlHost> {
  const post = (response: LofiZqlResponse) => {
    options.port.postMessage(response);
  };
  const { replica, withEngine } = await openReplicaEngine(options).catch((error: unknown) => {
    post({ type: "failed", message: errorMessage(error) });
    throw error;
  });

  // The page sends requests only after the first status, so none arrive before this handler.
  options.port.onmessage = (event: MessageEvent<LofiZqlRequest>) => {
    const request = event.data;
    if (request.type === "materialize") {
      withEngine((engine) => {
        engine.materialize(request.id, {
          schemaName: request.schemaName,
          ast: request.ast,
          format: request.format,
          listener: (data) => {
            post({ type: "data", id: request.id, data });
          },
        });
      }).catch((error: unknown) => {
        post({ type: "error", id: request.id, message: errorMessage(error) });
      });
    } else {
      withEngine((engine) => {
        engine.destroy(request.id);
      }).catch(options.replica.onError);
    }
  };

  // Notifications that arrive while a refresh waits for the lock are covered by it.
  let refreshQueued = false;
  const unsubscribe = replica.subscribe(() => {
    if (refreshQueued) {
      return;
    }
    refreshQueued = true;
    withEngine((engine) => {
      refreshQueued = false;
      engine.refresh();
    }).catch(options.replica.onError);
  });
  const postStatus = () => {
    post({ type: "status", status: replica.getStatus() });
  };
  const unsubscribeStatus = replica.subscribeStatus(postStatus);
  postStatus();

  return {
    replica,
    async close() {
      options.port.onmessage = null;
      unsubscribe();
      unsubscribeStatus();
      await replica.close();
    },
  };
}

async function openReplicaEngine(options: LofiZqlHostOptions) {
  let database: LofiZqlSqliteDatabase | undefined;
  const replica = await openLofiSqliteReplica(options.replica, {
    openDatabase: async (open) => (database = await options.openDatabase(open)),
  });
  const { connection } = database!;
  const registrations = [...options.replica.schemas, ...options.replica.localSchemas];
  let engine: LofiZqlEngine | undefined;
  return {
    replica,
    withEngine: (operation: (engine: LofiZqlEngine) => void) =>
      replica.read(async (locked) => {
        // A read takes the lock that the engine's synchronous statements need.
        await locked.execute(`SELECT 1 FROM "sqlite_schema" LIMIT 1`);
        engine ??= new LofiZqlEngine(connection, registrations);
        operation(engine);
      }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
