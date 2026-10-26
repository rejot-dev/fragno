import { backofficeScopePathSegment } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { fetchFragnoInternalDescription, resolveFragnoInternalUrls } from "@fragno-dev/db/outbox";
import type {
  LofiSqliteClient,
  LofiSqliteReplica,
  LofiSqliteReplicaOptions,
  LofiSqliteView,
} from "@fragno-dev/lofi/sqlite";
import {
  openLofiSqliteMemoryFiles,
  openLofiSqliteTab,
  rebuildLofiSqliteProjections,
  waitForLofiSqliteReplica,
  type LofiSqliteProjectionTables,
} from "@fragno-dev/lofi/sqlite/testing";
import type { LofiSqliteViewEngine } from "@fragno-dev/lofi/sqlite/worker";

export type ScenarioReplicaScope = {
  readonly replica: LofiSqliteClient;
  sync(): Promise<void>;
  drain(): Promise<void>;
  /**
   * Rebuilds the replica's projections from the rows it stores, as changed projection code would,
   * and returns their tables before and after; see `rebuildLofiSqliteProjections`. Call it after
   * `drain()`.
   */
  rebuildProjections(): Promise<{
    before: LofiSqliteProjectionTables;
    after: LofiSqliteProjectionTables;
  }>;
};

export type ScenarioReplicaDatabase = {
  forScope(scope: BackofficeContextScope): ScenarioReplicaScope;
  forOrg(orgId: string): ScenarioReplicaScope;
};

export type ScenarioReplicaDatabaseRuntime = ScenarioReplicaDatabase & {
  syncAll(): Promise<void>;
  cleanup(): Promise<void>;
};

type ScenarioReplicaScopeRuntime = ScenarioReplicaScope & {
  cleanup(): Promise<void>;
};

type ScenarioReplicaOptions = {
  name: string;
  drainRuntime(): Promise<void>;
  baseUrl(scope: BackofficeContextScope): string;
  createFetch(scope: BackofficeContextScope): typeof fetch;
};

type ScenarioReplicaConnection = {
  baseUrl: string;
  fetch: typeof fetch;
  onError: (error: unknown) => void;
  openDatabase: Awaited<ReturnType<typeof openLofiSqliteMemoryFiles>>["open"];
};

type OpenedScenarioReplica = {
  replica: LofiSqliteClient;
  /** The replica that applies the outbox, which `sync` waits for. */
  writer: LofiSqliteReplica;
  rebuildProjections: ScenarioReplicaScope["rebuildProjections"];
  close(): Promise<void>;
};

/**
 * One SQLite replica per scope, opened like the replica worker of a browser's only tab opens it,
 * with wa-sqlite's in-memory files standing in for OPFS and Node's Web Locks and BroadcastChannel
 * for the browser's. Read its views with `readScenarioReplicaView`.
 */
export function createScenarioReplicaDatabase(
  options: ScenarioReplicaOptions &
    Pick<
      LofiSqliteReplicaOptions,
      "schemas" | "localSchemas" | "projections" | "ephemeralTables"
    > & {
      engines: LofiSqliteViewEngine[];
    },
): ScenarioReplicaDatabaseRuntime {
  return createScenarioReplicaScopes(options, async (connection) => {
    // The scope's only tab, so it leads.
    const tab = await openLofiSqliteTab({
      replica: {
        baseUrl: connection.baseUrl,
        fetch: connection.fetch,
        schemas: options.schemas,
        localSchemas: options.localSchemas,
        projections: options.projections,
        ephemeralTables: options.ephemeralTables,
        onError: connection.onError,
        retryDelayMs: 10,
      },
      engines: options.engines,
      openDatabase: connection.openDatabase,
      heartbeatIntervalMs: 1_000,
      leaderTimeoutMs: 10_000,
    });
    const writer = await tab.host.leading;
    return {
      replica: tab.client,
      writer,
      rebuildProjections: async () => {
        const database = await connection.openDatabase({ databaseName: writer.databaseName });
        try {
          return await rebuildLofiSqliteProjections({ ...options, database });
        } finally {
          await database.close();
        }
      },
      close: () => tab.close(),
    };
  });
}

/**
 * The data a new view first shows: the worker builds it after everything already applied. Pass a
 * view no one else mounted. Fails when the view does.
 */
export function readScenarioReplicaView<TData>(view: LofiSqliteView<TData>): Promise<TData> {
  return new Promise((resolve, reject) => {
    const unsubscribe = view.subscribe((result) => {
      if (result.status === "loading") {
        return;
      }
      queueMicrotask(unsubscribe);
      if (result.status === "ready") {
        resolve(result.data);
      } else {
        reject(new Error(result.message));
      }
    });
  });
}

function createScenarioReplicaScopes(
  options: ScenarioReplicaOptions,
  open: (connection: ScenarioReplicaConnection) => Promise<OpenedScenarioReplica>,
): ScenarioReplicaDatabaseRuntime {
  const scopes = new Map<string, ScenarioReplicaScopeRuntime>();
  let files: ReturnType<typeof openLofiSqliteMemoryFiles> | undefined;

  const forScope = (scope: BackofficeContextScope): ScenarioReplicaScope => {
    const key = backofficeScopePathSegment(scope);
    const existing = scopes.get(key);
    if (existing) {
      return existing;
    }

    const fetch = options.createFetch(scope);
    const baseUrl = options.baseUrl(scope);
    const errors: unknown[] = [];
    let replica: LofiSqliteClient | undefined;
    files ??= openLofiSqliteMemoryFiles({ statementDelayMs: 0 });
    const opening = files.then(async (memoryFiles) => {
      const opened = await open({
        baseUrl,
        fetch,
        onError: (error) => {
          errors.push(error);
        },
        openDatabase: memoryFiles.open,
      });
      replica = opened.replica;
      return opened;
    });

    const sync = async () => {
      const [opened, description] = await Promise.all([
        opening,
        fetchFragnoInternalDescription({
          internalUrl: resolveFragnoInternalUrls(baseUrl).internal,
          fetch,
        }),
      ]);
      if (description.currentVersionstamp !== null) {
        await waitForLofiSqliteReplica(opened.writer, description.currentVersionstamp, {
          timeoutMs: 2_000,
        }).catch((error: unknown) => {
          throw errors.length > 0 ? new AggregateError(errors, `${options.name} failed.`) : error;
        });
      }
    };

    const scopeRuntime: ScenarioReplicaScopeRuntime = {
      get replica() {
        if (!replica) {
          throw new Error(`Call sync() or drain() before reading ${options.name}.replica.`);
        }
        return replica;
      },
      sync,
      drain: async () => {
        await options.drainRuntime();
        await sync();
      },
      rebuildProjections: async () => (await opening).rebuildProjections(),
      cleanup: async () => {
        await opening.then(
          (opened) => opened.close(),
          () => {},
        );
      },
    };

    void opening.catch(() => {});
    scopes.set(key, scopeRuntime);
    return scopeRuntime;
  };

  return {
    forScope,
    forOrg: (orgId) => forScope({ kind: "org", orgId, jurisdiction: null }),
    syncAll: async () => {
      await Promise.all([...scopes.values()].map((scopeRuntime) => scopeRuntime.sync()));
    },
    cleanup: async () => {
      try {
        await Promise.all([...scopes.values()].map((scopeRuntime) => scopeRuntime.cleanup()));
      } finally {
        scopes.clear();
      }
    },
  };
}
