import { backofficeScopePathSegment } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { fetchFragnoInternalDescription, resolveFragnoInternalUrls } from "@fragno-dev/db/outbox";
import { openLofiSqliteReplica, type LofiSqliteReplica } from "@fragno-dev/lofi/sqlite";
import {
  openLofiSqliteMemoryFiles,
  waitForLofiSqliteReplica,
} from "@fragno-dev/lofi/sqlite/testing";

import type { LofiSchemaRegistration } from "@fragno-dev/lofi";

export type ScenarioReplicaScope = {
  readonly replica: LofiSqliteReplica;
  sync(): Promise<void>;
  drain(): Promise<void>;
};

export type ScenarioReplicaDatabase = {
  forScope(scope: BackofficeContextScope): ScenarioReplicaScope;
  forOrg(orgId: string): ScenarioReplicaScope;
};

export type ScenarioReplicaDatabaseRuntime = ScenarioReplicaDatabase & {
  syncAll(): Promise<void>;
  cleanup(): Promise<void>;
};

type ScenarioReplicaScopeRuntime = ScenarioReplicaScope & { cleanup(): Promise<void> };

/**
 * One SQLite replica per scope, opened like a browser tab opens it, with wa-sqlite's in-memory
 * files standing in for OPFS and Node's Web Locks and BroadcastChannel for the browser's.
 */
export function createScenarioReplicaDatabase(options: {
  name: string;
  schemas: LofiSchemaRegistration[];
  drainRuntime(): Promise<void>;
  baseUrl(scope: BackofficeContextScope): string;
  createFetch(scope: BackofficeContextScope): typeof fetch;
}): ScenarioReplicaDatabaseRuntime {
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
    let replica: LofiSqliteReplica | undefined;
    files ??= openLofiSqliteMemoryFiles({ statementDelayMs: 0 });
    const opening = files.then(async (memoryFiles) => {
      replica = await openLofiSqliteReplica(
        {
          baseUrl,
          fetch,
          schemas: options.schemas,
          localSchemas: [],
          projections: [],
          ephemeralTables: [],
          onError: (error) => {
            errors.push(error);
          },
          retryDelayMs: 10,
        },
        { openDatabase: memoryFiles.open },
      );
      return replica;
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
        await waitForLofiSqliteReplica(opened, description.currentVersionstamp, {
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
