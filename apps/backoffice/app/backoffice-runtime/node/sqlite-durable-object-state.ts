import type { BackofficeDurableObjectState, BackofficeObjectAlarm } from "../local-durable-objects";
import { SqliteObjectCoordination } from "./sqlite-object-coordination";
import { SqliteBackofficeObjectStorage } from "./sqlite-object-storage";

type SqliteStorageListOptions = {
  prefix?: string;
};

/** Implements Durable Object state directly against authoritative SQLite storage. */
export class SqliteDurableObjectState implements BackofficeDurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;

  readonly #objectId: string;
  readonly #persistence: SqliteBackofficeObjectStorage;
  readonly #coordination: SqliteObjectCoordination;
  #refreshRuntime: (() => Promise<void>) | null = null;
  #refreshing: Promise<void> | null = null;
  #deliveringAlarmGeneration: number | null = null;
  readonly #pendingWaitUntil = new Set<Promise<unknown>>();
  readonly #pendingBlockConcurrency = new Set<Promise<unknown>>();
  #backgroundDrain: (() => Promise<void>) | null = null;

  constructor(
    id: DurableObjectId,
    persistence: SqliteBackofficeObjectStorage,
    coordination: SqliteObjectCoordination,
  ) {
    this.id = id;
    this.#objectId = String(id);
    this.#persistence = persistence;
    this.#coordination = coordination;
    this.#persistence.registerObject(this.#objectId);
    this.storage = {
      get: this.#get.bind(this),
      put: this.#put.bind(this),
      delete: this.#delete.bind(this),
      list: this.#list.bind(this),
      getAlarm: this.#getAlarm.bind(this),
      setAlarm: this.#setAlarm.bind(this),
      deleteAlarm: this.#deleteAlarm.bind(this),
    } as unknown as DurableObjectStorage;
  }

  get alarmTimestamp(): number | null {
    return this.#persistence.alarm(this.#objectId)?.timestamp ?? null;
  }

  get hasPendingWork(): boolean {
    return this.#pendingWaitUntil.size > 0 || this.#pendingBlockConcurrency.size > 0;
  }

  dueAlarm(now: number): BackofficeObjectAlarm | null {
    const alarm = this.#persistence.alarm(this.#objectId);
    return alarm && alarm.timestamp <= now ? alarm : null;
  }

  registerRuntimeRefresh(refresh: () => Promise<void>): void {
    this.#refreshRuntime = refresh;
  }

  async prepareForEvent(): Promise<void> {
    await this.drainBlocking();
    await this.#coordination.waitForInitialization(this.#objectId);
    if (!this.#refreshRuntime) {
      return;
    }
    this.#refreshing ??= this.#refreshRuntime().finally(() => {
      this.#refreshing = null;
    });
    await this.#refreshing;
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
    return await this.#coordination.deliverAlarm(this.#objectId, expectedAlarm, async () => {
      this.#deliveringAlarmGeneration = expectedAlarm.generation;
      try {
        await handler();
      } finally {
        this.#deliveringAlarmGeneration = null;
      }
    });
  }

  blockConcurrencyWhile<T>(callback: () => T | Promise<T>): Promise<T> {
    const promise = this.#coordination.initialize(this.#objectId, async () => {
      return await callback();
    });
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

  async #get<T = unknown>(keyOrKeys: string | string[]): Promise<T | Map<string, T> | undefined> {
    if (Array.isArray(keyOrKeys)) {
      return this.#persistence.getMany<T>(this.#objectId, keyOrKeys);
    }
    return this.#persistence.get(this.#objectId, keyOrKeys) as T | undefined;
  }

  async #put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    const entries =
      typeof keyOrEntries === "string"
        ? new Map([[keyOrEntries, value]])
        : new Map(Object.entries(keyOrEntries));
    this.#persistence.put(
      this.#objectId,
      this.#coordination.claimsForMutation(this.#objectId),
      entries,
    );
  }

  async #delete(keyOrKeys: string | string[]): Promise<boolean> {
    return this.#persistence.delete(
      this.#objectId,
      this.#coordination.claimsForMutation(this.#objectId),
      Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys],
    );
  }

  async #list<T = unknown>(options: SqliteStorageListOptions = {}): Promise<Map<string, T>> {
    return this.#persistence.list<T>(this.#objectId, options.prefix ?? null);
  }

  async #getAlarm(): Promise<number | null> {
    const alarm = this.#persistence.alarm(this.#objectId);
    if (alarm?.generation === this.#deliveringAlarmGeneration) {
      return null;
    }
    return alarm?.timestamp ?? null;
  }

  async #setAlarm(timestamp: number | Date): Promise<void> {
    const alarmTimestamp = timestamp instanceof Date ? timestamp.getTime() : Math.trunc(timestamp);
    this.#persistence.setAlarm(
      this.#objectId,
      this.#coordination.claimsForMutation(this.#objectId),
      alarmTimestamp,
    );
  }

  async #deleteAlarm(): Promise<void> {
    this.#persistence.setAlarm(
      this.#objectId,
      this.#coordination.claimsForMutation(this.#objectId),
      null,
    );
  }
}
