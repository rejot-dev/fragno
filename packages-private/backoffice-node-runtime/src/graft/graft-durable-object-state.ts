import { deserialize, serialize } from "node:v8";

import type {
  BackofficeDurableObjectState,
  BackofficeObjectAlarm,
} from "../runtime/local-durable-objects";
import type { NodeDurableObjectStorage } from "../runtime/node-durable-object-storage";
import { runNodeObjectEvent } from "../runtime/node-object-event";
import { currentNodeObjectOutputBoundary } from "../runtime/node-object-output-boundary";
import type { ManagedNodeRuntimeObjectDatabase } from "../sqlite/managed-node-runtime-object-database";
import { createNodeDurableObjectSqlStorage } from "../sqlite/node-durable-object-sql-storage";

type GraftStorageListOptions = {
  prefix?: string;
};

/** Stores the runtime's narrow KV and alarm compatibility surface in the object's Graft database. */
export class GraftDurableObjectState implements BackofficeDurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: NodeDurableObjectStorage;

  readonly #database: ManagedNodeRuntimeObjectDatabase;
  readonly #pendingWaitUntil = new Set<Promise<unknown>>();
  readonly #pendingBlockConcurrency = new Set<Promise<unknown>>();
  #deliveringAlarmGeneration: number | null = null;
  #backgroundDrain: (() => Promise<void>) | null = null;

  constructor(id: DurableObjectId, database: ManagedNodeRuntimeObjectDatabase) {
    this.id = id;
    this.#database = database;
    this.storage = {
      get: this.#get.bind(this),
      put: this.#put.bind(this),
      delete: this.#delete.bind(this),
      list: this.#list.bind(this),
      getAlarm: this.#getAlarm.bind(this),
      setAlarm: this.#setAlarm.bind(this),
      deleteAlarm: this.#deleteAlarm.bind(this),
      sql: createNodeDurableObjectSqlStorage(database),
    };
  }

  get alarmTimestamp(): number | null {
    return this.#readAlarm()?.timestamp ?? null;
  }

  get hasPendingWork(): boolean {
    return this.#pendingWaitUntil.size > 0 || this.#pendingBlockConcurrency.size > 0;
  }

  dueAlarm(now: number): BackofficeObjectAlarm | null {
    const alarm = this.#readAlarm();
    return alarm && alarm.timestamp <= now ? alarm : null;
  }

  async prepareForEvent(): Promise<void> {
    await this.drainBlocking();
  }

  async runEvent<TResult>(operation: () => TResult | Promise<TResult>): Promise<TResult> {
    await this.prepareForEvent();
    return await this.#runDurableEvent(operation);
  }

  ensureOutputDurable(requiredPosition: number): void {
    this.#database.ensureDurableStoragePosition(requiredPosition);
  }

  async deliverAlarm(
    expectedAlarm: BackofficeObjectAlarm,
    now: number,
    handler: () => Promise<void>,
  ): Promise<boolean> {
    if (
      this.#deliveringAlarmGeneration !== null ||
      this.dueAlarm(now)?.generation !== expectedAlarm.generation
    ) {
      return false;
    }
    this.#deliveringAlarmGeneration = expectedAlarm.generation;
    try {
      await handler();
      this.#database.write((database) => {
        database.run("DELETE FROM node_runtime_alarm WHERE generation = ?", [
          expectedAlarm.generation,
        ]);
      });
      return true;
    } finally {
      this.#deliveringAlarmGeneration = null;
    }
  }

  blockConcurrencyWhile<TResult>(callback: () => TResult | Promise<TResult>): Promise<TResult> {
    const promise = Promise.resolve().then(async () => await this.#runDurableEvent(callback));
    this.#pendingBlockConcurrency.add(promise);
    void promise.then(
      () => this.#pendingBlockConcurrency.delete(promise),
      () => this.#pendingBlockConcurrency.delete(promise),
    );
    return promise;
  }

  waitUntil(promise: Promise<unknown>): void {
    const tracked = Promise.resolve(promise);
    this.#pendingWaitUntil.add(tracked);
    void tracked.then(
      () => this.#pendingWaitUntil.delete(tracked),
      () => this.#pendingWaitUntil.delete(tracked),
    );
  }

  setBackgroundDrain(drain: (() => Promise<void>) | null): void {
    this.#backgroundDrain = drain;
  }

  async drainBackground(): Promise<void> {
    await this.#backgroundDrain?.();
  }

  async drainBlocking(): Promise<boolean> {
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
    if (Array.isArray(keyOrKeys)) {
      return this.#database.read((database) => {
        const result = new Map<string, TResult>();
        for (const key of keyOrKeys) {
          const row = database.get("SELECT value FROM node_runtime_values WHERE key = ?", [
            key,
          ]) as { value: Uint8Array } | null;
          result.set(key, row ? (deserialize(row.value) as TResult) : (undefined as TResult));
        }
        return result;
      });
    }
    return this.#database.read((database) => {
      const row = database.get("SELECT value FROM node_runtime_values WHERE key = ?", [
        keyOrKeys,
      ]) as { value: Uint8Array } | null;
      return row ? (deserialize(row.value) as TResult) : undefined;
    });
  }

  async #put<TResult>(keyOrEntries: string | Record<string, TResult>, value?: TResult) {
    const entries =
      typeof keyOrEntries === "string"
        ? new Map([[keyOrEntries, value]])
        : new Map(Object.entries(keyOrEntries));
    this.#database.write((database) => {
      for (const [key, entryValue] of entries) {
        database.run(
          `INSERT INTO node_runtime_values (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [key, serialize(entryValue)],
        );
      }
    });
  }

  async #delete(keyOrKeys: string | string[]): Promise<boolean> {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    return this.#database.write((database) => {
      let deleted = false;
      for (const key of keys) {
        deleted =
          database.run("DELETE FROM node_runtime_values WHERE key = ?", [key]).changes > 0 ||
          deleted;
      }
      return deleted;
    });
  }

  async #list<TResult = unknown>(
    options: GraftStorageListOptions = {},
  ): Promise<Map<string, TResult>> {
    return this.#database.read((database) => {
      const rows = database.all("SELECT key, value FROM node_runtime_values ORDER BY key", []) as {
        key: string;
        value: Uint8Array;
      }[];
      return new Map(
        rows
          .filter((row) => !options.prefix || row.key.startsWith(options.prefix))
          .map((row) => [row.key, deserialize(row.value) as TResult]),
      );
    });
  }

  async #getAlarm(): Promise<number | null> {
    const alarm = this.#readAlarm();
    if (alarm?.generation === this.#deliveringAlarmGeneration) {
      return null;
    }
    return alarm?.timestamp ?? null;
  }

  async #setAlarm(timestamp: number | Date): Promise<void> {
    const alarmTimestamp = timestamp instanceof Date ? timestamp.getTime() : Math.trunc(timestamp);
    this.#database.write((database) => {
      database.run(
        `INSERT INTO node_runtime_alarm (singleton, timestamp, generation) VALUES (1, ?, 1)
         ON CONFLICT(singleton) DO UPDATE SET
           timestamp = excluded.timestamp,
           generation = node_runtime_alarm.generation + 1`,
        [alarmTimestamp],
      );
    });
  }

  async #deleteAlarm(): Promise<void> {
    this.#database.write((database) => {
      database.run("DELETE FROM node_runtime_alarm WHERE singleton = 1", []);
    });
  }

  async #runDurableEvent<TResult>(operation: () => TResult | Promise<TResult>): Promise<TResult> {
    const outputBoundary = currentNodeObjectOutputBoundary();
    return await runNodeObjectEvent(operation, () => {
      const position = this.#database.committedStoragePosition;
      if (outputBoundary) {
        outputBoundary.observeStoragePosition(position);
      } else {
        this.#database.ensureDurableStoragePosition(position);
      }
    });
  }

  #readAlarm(): BackofficeObjectAlarm | null {
    return this.#database.read(
      (database) =>
        database.get(
          "SELECT timestamp, generation FROM node_runtime_alarm WHERE singleton = 1",
          [],
        ) as BackofficeObjectAlarm | null,
    );
  }
}
