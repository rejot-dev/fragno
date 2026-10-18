import { deserialize, serialize } from "node:v8";

import type {
  NodeDurableObjectId,
  NodeDurableObjectState,
} from "../runtime/node-durable-object-state";
import type {
  NodeDurableObjectStorage,
  NodeDurableObjectTransaction,
} from "../runtime/node-durable-object-storage";
import { runNodeObjectEvent } from "../runtime/node-object-event";
import type { NodeObjectInputGate } from "../runtime/node-object-input-gate";
import { currentNodeObjectOutputBoundary } from "../runtime/node-object-output-boundary";
import type { ManagedNodeRuntimeObjectDatabase } from "../sqlite/managed-node-runtime-object-database";
import { createNodeDurableObjectSqlStorage } from "../sqlite/node-durable-object-sql-storage";
import {
  GraftObjectAlarmCoordinator,
  readGraftObjectAlarm,
  type GraftObjectAlarm,
} from "./graft-object-alarm-coordinator";

type GraftStorageListOptions = {
  prefix?: string;
};

/** Stores the runtime's narrow KV and alarm compatibility surface in the object's Graft database. */
export class GraftDurableObjectState implements NodeDurableObjectState {
  readonly id: NodeDurableObjectId;
  readonly storage: NodeDurableObjectStorage;

  readonly #database: ManagedNodeRuntimeObjectDatabase;
  readonly #alarmCoordinator: GraftObjectAlarmCoordinator;
  readonly #pendingWaitUntil = new Set<Promise<unknown>>();
  readonly #pendingBlockConcurrency = new Set<Promise<unknown>>();
  #deliveringAlarmInstallationId: string | null = null;
  #pendingWorkSettledListener: (() => void) | null = null;

  constructor(
    id: NodeDurableObjectId,
    database: ManagedNodeRuntimeObjectDatabase,
    alarmCoordinator: GraftObjectAlarmCoordinator,
  ) {
    this.id = id;
    this.#database = database;
    this.#alarmCoordinator = alarmCoordinator;
    this.storage = gateStorageInput(
      {
        get: this.#get.bind(this),
        put: this.#put.bind(this),
        delete: this.#delete.bind(this),
        list: this.#list.bind(this),
        getAlarm: this.#getAlarm.bind(this),
        setAlarm: this.#setAlarm.bind(this),
        deleteAlarm: this.#deleteAlarm.bind(this),
        sql: createNodeDurableObjectSqlStorage(database),
        transaction: (callback) =>
          this.#alarmCoordinator.transaction(
            async () => await callback(this.#createTransactionStorage()),
          ),
        transactionSync: (callback) => this.#alarmCoordinator.transactionSync(callback),
      },
      database.inputGate,
    );
  }

  get hasPendingWork(): boolean {
    return (
      this.#pendingWaitUntil.size > 0 ||
      this.#pendingBlockConcurrency.size > 0 ||
      this.#database.inputGate.hasPendingInput
    );
  }

  dueAlarm(now: number): GraftObjectAlarm | null {
    const alarm = this.#readAlarm();
    return alarm && alarm.timestamp <= now ? alarm : null;
  }

  async prepareForEvent(): Promise<void> {
    // Admission checks authority without flushing another output scope's unconfirmed writes.
    await this.#database.accessOutsideTransaction(() => {
      this.#database.ensureDurableStoragePosition(0);
    });
    await this.#drainBlocking();
    await this.#database.accessOutsideTransaction(() => {
      this.#database.ensureDurableStoragePosition(0);
    });
  }

  async runEvent<TResult>(operation: () => TResult | Promise<TResult>): Promise<TResult> {
    await this.prepareForEvent();
    return await this.#database.inputGate.runEvent(() =>
      this.#database.accessOutsideTransaction(() => this.#runDurableEvent(operation)),
    );
  }

  async accessStorage<TResult>(operation: () => TResult | Promise<TResult>): Promise<TResult> {
    return await this.#database.accessOutsideTransaction(operation);
  }

  ensureOutputDurable(requiredPosition: number): void {
    this.#database.ensureDurableStoragePosition(requiredPosition);
  }

  async deliverAlarm(
    expectedAlarm: GraftObjectAlarm,
    now: number,
    handler: () => Promise<void>,
  ): Promise<boolean> {
    if (
      this.#deliveringAlarmInstallationId !== null ||
      this.dueAlarm(now)?.installationId !== expectedAlarm.installationId
    ) {
      return false;
    }
    this.#deliveringAlarmInstallationId = expectedAlarm.installationId;
    try {
      await handler();
      return await this.#alarmCoordinator.consumeAlarm(expectedAlarm.installationId);
    } finally {
      this.#deliveringAlarmInstallationId = null;
    }
  }

  blockConcurrencyWhile<TResult>(callback: () => TResult | Promise<TResult>): Promise<TResult> {
    const promise = this.#database.inputGate.runCriticalSection(
      async () => await this.#runDurableEvent(callback),
    );
    this.#pendingBlockConcurrency.add(promise);
    void promise.then(
      () => {
        this.#pendingBlockConcurrency.delete(promise);
        this.#pendingWorkSettledListener?.();
      },
      () => {
        this.#pendingBlockConcurrency.delete(promise);
        this.#pendingWorkSettledListener?.();
      },
    );
    return promise;
  }

  waitUntil(promise: Promise<unknown>): void {
    const tracked = Promise.resolve(promise);
    this.#pendingWaitUntil.add(tracked);
    void tracked.then(
      () => {
        this.#pendingWaitUntil.delete(tracked);
        this.#pendingWorkSettledListener?.();
      },
      () => {
        this.#pendingWaitUntil.delete(tracked);
        this.#pendingWorkSettledListener?.();
      },
    );
  }

  setPendingWorkSettledListener(listener: (() => void) | null): void {
    this.#pendingWorkSettledListener = listener;
    this.#database.inputGate.setInputSettledListener(listener);
  }

  async #drainBlocking(): Promise<boolean> {
    return await this.#drainSet(this.#pendingBlockConcurrency);
  }

  async drainWaitUntil(): Promise<boolean> {
    const drainedWaitUntil = await this.#drainSet(this.#pendingWaitUntil);
    const drainedBlocking = await this.#drainSet(this.#pendingBlockConcurrency);
    return drainedWaitUntil || drainedBlocking;
  }

  async #drainSet(promises: Set<Promise<unknown>>): Promise<boolean> {
    const pending = [...promises];
    if (pending.length === 0) {
      return false;
    }
    await Promise.all(pending);
    return true;
  }

  async #get<TResult = unknown>(
    keyOrKeys: string | string[],
  ): Promise<TResult | Map<string, TResult> | undefined> {
    return await this.#database.access(() =>
      this.#database.read((database) => {
        if (Array.isArray(keyOrKeys)) {
          const result = new Map<string, TResult>();
          for (const key of keyOrKeys) {
            const row = database.get("SELECT value FROM node_runtime_values WHERE key = ?", [
              key,
            ]) as { value: Uint8Array } | null;
            if (row) {
              result.set(key, deserialize(row.value) as TResult);
            }
          }
          return result;
        }
        const row = database.get("SELECT value FROM node_runtime_values WHERE key = ?", [
          keyOrKeys,
        ]) as { value: Uint8Array } | null;
        return row ? (deserialize(row.value) as TResult) : undefined;
      }),
    );
  }

  async #put<TResult>(keyOrEntries: string | Record<string, TResult>, value?: TResult) {
    const entries =
      typeof keyOrEntries === "string"
        ? new Map([[keyOrEntries, value]])
        : new Map(Object.entries(keyOrEntries));
    await this.#database.access(() => {
      this.#database.write((database) => {
        for (const [key, entryValue] of entries) {
          database.run(
            `INSERT INTO node_runtime_values (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            [key, serialize(entryValue)],
          );
        }
      });
    });
  }

  #delete(key: string): Promise<boolean>;
  #delete(keys: string[]): Promise<number>;
  async #delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    const deleted = await this.#database.access(() =>
      this.#database.write((database) => {
        let count = 0;
        for (const key of keys) {
          count += database.run("DELETE FROM node_runtime_values WHERE key = ?", [key]).changes;
        }
        return count;
      }),
    );
    return Array.isArray(keyOrKeys) ? deleted : deleted > 0;
  }

  async #list<TResult = unknown>(
    options: GraftStorageListOptions = {},
  ): Promise<Map<string, TResult>> {
    return await this.#database.access(() =>
      this.#database.read((database) => {
        const rows = database.all(
          "SELECT key, value FROM node_runtime_values ORDER BY key",
          [],
        ) as {
          key: string;
          value: Uint8Array;
        }[];
        return new Map(
          rows
            .filter((row) => !options.prefix || row.key.startsWith(options.prefix))
            .map((row) => [row.key, deserialize(row.value) as TResult]),
        );
      }),
    );
  }

  async #getAlarm(): Promise<number | null> {
    return await this.#database.access(() => {
      const alarm = this.#readAlarm();
      if (alarm?.installationId === this.#deliveringAlarmInstallationId) {
        return null;
      }
      return alarm?.timestamp ?? null;
    });
  }

  #createTransactionStorage(): NodeDurableObjectTransaction {
    return bindStorageTransaction(
      {
        get: this.#get.bind(this),
        put: this.#put.bind(this),
        delete: this.#delete.bind(this),
        list: this.#list.bind(this),
        getAlarm: this.#getAlarm.bind(this),
        setAlarm: this.#setAlarm.bind(this),
        deleteAlarm: this.#deleteAlarm.bind(this),
        rollback: () => {
          this.#database.rollbackTransaction();
        },
      },
      this.#database.captureTransactionRunner(),
      this.#database.inputGate,
    );
  }

  async #setAlarm(timestamp: number | Date): Promise<void> {
    const alarmTimestamp = timestamp instanceof Date ? timestamp.getTime() : Math.trunc(timestamp);
    if (!Number.isSafeInteger(alarmTimestamp) || alarmTimestamp < 0) {
      throw new Error("NODE_OBJECT_ALARM_TIMESTAMP_INVALID");
    }
    await this.#alarmCoordinator.setAlarm(alarmTimestamp);
  }

  async #deleteAlarm(): Promise<void> {
    await this.#alarmCoordinator.deleteAlarm();
  }

  async #runDurableEvent<TResult>(operation: () => TResult | Promise<TResult>): Promise<TResult> {
    const outputBoundary = currentNodeObjectOutputBoundary();
    return await this.#database.runStorageOperation(() =>
      runNodeObjectEvent(operation, async () => {
        await this.#database.accessOutsideTransaction(() => {
          const position = this.#database.committedStoragePosition;
          if (outputBoundary) {
            outputBoundary.observeStoragePosition(position);
          } else {
            this.#database.ensureDurableStoragePosition(position);
          }
        });
      }),
    );
  }

  #readAlarm(): GraftObjectAlarm | null {
    return readGraftObjectAlarm(this.#database);
  }
}

function gateStorageInput(
  storage: NodeDurableObjectStorage,
  inputGate: NodeObjectInputGate,
): NodeDurableObjectStorage {
  return new Proxy(storage, {
    get(target, property) {
      const properties = target as unknown as Record<PropertyKey, unknown>;
      const value = properties[property];
      if (
        typeof value !== "function" ||
        property === "transaction" ||
        property === "transactionSync"
      ) {
        return value;
      }
      const method = value as (...args: unknown[]) => Promise<unknown>;
      return (...args: unknown[]) => inputGate.runInput(() => method(...args));
    },
  });
}

/** Explicit handles retain ownership, not lifetime: completed transactions still reject every call. */
function bindStorageTransaction<TStorage extends object>(
  storage: TStorage,
  run: <TResult>(operation: () => TResult) => TResult,
  inputGate: NodeObjectInputGate,
): TStorage {
  return new Proxy(storage, {
    get(target, property) {
      const properties = target as Record<PropertyKey, unknown>;
      const value = run(() => properties[property]);
      if (typeof value !== "function") {
        return value;
      }
      const method = value as (this: TStorage, ...args: unknown[]) => unknown;
      return (...args: unknown[]) =>
        run(() =>
          property === "rollback"
            ? method.call(target, ...args)
            : inputGate.runInput(() => run(() => method.call(target, ...args))),
        );
    },
  });
}
