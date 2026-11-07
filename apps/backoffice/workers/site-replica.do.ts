import type { ArtifactSiteDataStatus } from "@fragno-dev/backoffice-api/v0/artifacts";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { SqliteValue } from "@fragno-dev/lofi/sqlite";
import { DurableObject } from "cloudflare:workers";

import type { SiteDataQuery, SiteDataResult } from "@/artifacts/sites/site-data";
import type { SiteReplicaCommands } from "@/backoffice-runtime/object-registry";

import type { SiteReplicaObject, SiteReplicaStorage } from "./site-replica-object";

export class SiteReplica extends DurableObject<CloudflareEnv> implements SiteReplicaCommands {
  #object!: SiteReplicaObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const [{ SiteReplicaObject }, { createCloudflareBackofficeObjectRegistry }] =
        await Promise.all([
          import("./site-replica-object"),
          import("@/backoffice-runtime/cloudflare-durable-object-factory"),
        ]);
      const objects = createCloudflareBackofficeObjectRegistry(env);
      this.#object = new SiteReplicaObject({
        storage: durableObjectSiteReplicaStorage(state.storage),
        alarm: {
          get: () => state.storage.getAlarm(),
          set: (scheduledTime) => state.storage.setAlarm(scheduledTime),
        },
        // Automations serves its outbox to whoever reaches it; browsers reach it once Backoffice
        // checked their membership, and only site Workers of the scope reach this object.
        fetchAutomations: (scope) => {
          const automations = objects.automations.for(scope);
          return (input, init) => automations.http.fetch(new Request(input, init));
        },
      });
    });
  }

  async query(scope: BackofficeContextScope, query: SiteDataQuery): Promise<SiteDataResult> {
    return await this.#object.query(scope, query);
  }

  async warm(scope: BackofficeContextScope): Promise<void> {
    await this.#object.warm(scope);
  }

  async status(scope: BackofficeContextScope): Promise<ArtifactSiteDataStatus> {
    return await this.#object.status(scope);
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }
}

/**
 * The object's SQLite as the copy is kept in it. Durable Object SQLite refuses BEGIN, and a
 * statement joins a transaction only inside the closure `storage.transaction` runs.
 */
function durableObjectSiteReplicaStorage(storage: DurableObjectStorage): SiteReplicaStorage {
  return {
    exec(sql, params = []) {
      const cursor = storage.sql.exec(sql, ...params.map(durableObjectValue));
      return {
        get columnNames() {
          return cursor.columnNames;
        },
        get rowsWritten() {
          return cursor.rowsWritten;
        },
        *[Symbol.iterator]() {
          for (const row of cursor.raw()) {
            yield row.map(sqliteValue);
          }
        },
      };
    },
    transaction: (operation) => storage.transaction(() => operation()),
    deleteAll: () => storage.deleteAll(),
    databaseSize: () => storage.sql.databaseSize,
  };
}

// The adapter binds 64-bit integers as bigints, which Durable Object SQLite does not take.
function durableObjectValue(value: SqliteValue): SqlStorageValue {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(`${value} is too large for a site replica to store.`);
    }
    return Number(value);
  }
  return value instanceof Uint8Array ? value.slice().buffer : value;
}

function sqliteValue(value: SqlStorageValue): SqliteValue {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}
