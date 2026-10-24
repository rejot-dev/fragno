import { backofficeScopePathSegment } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { fetchFragnoInternalDescription, resolveFragnoInternalUrls } from "@fragno-dev/db/outbox";
import {
  openLofiSqliteReplica,
  type LofiSqliteReplica,
  type LofiSqliteReplicaOptions,
} from "@fragno-dev/lofi/sqlite";
import {
  openLofiSqliteMemoryFiles,
  waitForLofiSqliteReplica,
} from "@fragno-dev/lofi/sqlite/testing";
import { connectLofiZql, type LofiZqlClient, type LofiZqlView } from "@fragno-dev/lofi/zql";
import { serveLofiZql } from "@fragno-dev/lofi/zql/worker";

import type { LofiSchemaRegistration } from "@fragno-dev/lofi";

export type ScenarioReplicaScope<TReplica> = {
  readonly replica: TReplica;
  sync(): Promise<void>;
  drain(): Promise<void>;
};

export type ScenarioReplicaDatabase<TReplica> = {
  forScope(scope: BackofficeContextScope): ScenarioReplicaScope<TReplica>;
  forOrg(orgId: string): ScenarioReplicaScope<TReplica>;
};

export type ScenarioReplicaDatabaseRuntime<TReplica> = ScenarioReplicaDatabase<TReplica> & {
  syncAll(): Promise<void>;
  cleanup(): Promise<void>;
};

type ScenarioReplicaScopeRuntime<TReplica> = ScenarioReplicaScope<TReplica> & {
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

type OpenedScenarioReplica<TReplica> = {
  replica: TReplica;
  /** The replica that applies the outbox, which `sync` waits for. */
  writer: LofiSqliteReplica;
  close(): Promise<void>;
};

/**
 * One SQLite replica per scope, opened like a browser tab opens it on the page, with wa-sqlite's
 * in-memory files standing in for OPFS and Node's Web Locks and BroadcastChannel for the browser's.
 */
export function createScenarioReplicaDatabase(
  options: ScenarioReplicaOptions &
    Pick<LofiSqliteReplicaOptions, "schemas"> &
    Partial<Pick<LofiSqliteReplicaOptions, "localSchemas" | "projections" | "ephemeralTables">>,
): ScenarioReplicaDatabaseRuntime<LofiSqliteReplica> {
  return createScenarioReplicaScopes(options, async (connection) => {
    const replica = await openLofiSqliteReplica(
      {
        baseUrl: connection.baseUrl,
        fetch: connection.fetch,
        schemas: options.schemas,
        localSchemas: options.localSchemas ?? [],
        projections: options.projections ?? [],
        ephemeralTables: options.ephemeralTables ?? [],
        onError: connection.onError,
        retryDelayMs: 10,
      },
      { openDatabase: connection.openDatabase },
    );
    return { replica, writer: replica, close: () => replica.close() };
  });
}

/**
 * One SQLite replica per scope, opened like a browser tab's replica worker opens it, with a
 * MessageChannel for the worker's port. Read its views with `readScenarioReplicaView`.
 */
export function createScenarioReplicaWorkerDatabase(
  options: ScenarioReplicaOptions & { schemas: LofiSchemaRegistration[] },
): ScenarioReplicaDatabaseRuntime<LofiZqlClient> {
  return createScenarioReplicaScopes(options, async (connection) => {
    const channel = new MessageChannel();
    const [host, client] = await Promise.all([
      serveLofiZql({
        replica: {
          baseUrl: connection.baseUrl,
          fetch: connection.fetch,
          schemas: options.schemas,
          localSchemas: [],
          projections: [],
          ephemeralTables: [],
          onError: connection.onError,
          retryDelayMs: 10,
        },
        port: channel.port1,
        openDatabase: connection.openDatabase,
      }),
      connectLofiZql({ port: channel.port2, schemas: options.schemas }),
    ]);
    return {
      replica: client,
      writer: host.replica,
      close: async () => {
        await host.close();
        channel.port1.close();
        channel.port2.close();
      },
    };
  });
}

/**
 * The data a new view first shows: the worker builds it after everything already applied. Pass a
 * view no one else mounted. Fails when the view does.
 */
export function readScenarioReplicaView<TData>(view: LofiZqlView<TData>): Promise<TData> {
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

function createScenarioReplicaScopes<TReplica>(
  options: ScenarioReplicaOptions,
  open: (connection: ScenarioReplicaConnection) => Promise<OpenedScenarioReplica<TReplica>>,
): ScenarioReplicaDatabaseRuntime<TReplica> {
  const scopes = new Map<string, ScenarioReplicaScopeRuntime<TReplica>>();
  let files: ReturnType<typeof openLofiSqliteMemoryFiles> | undefined;

  const forScope = (scope: BackofficeContextScope): ScenarioReplicaScope<TReplica> => {
    const key = backofficeScopePathSegment(scope);
    const existing = scopes.get(key);
    if (existing) {
      return existing;
    }

    const fetch = options.createFetch(scope);
    const baseUrl = options.baseUrl(scope);
    const errors: unknown[] = [];
    let replica: TReplica | undefined;
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

    const scopeRuntime: ScenarioReplicaScopeRuntime<TReplica> = {
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
    forOrg: (orgId) => forScope({ kind: "org", orgId }),
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
