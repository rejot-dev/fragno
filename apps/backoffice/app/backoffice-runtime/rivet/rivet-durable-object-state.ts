import { parse, stringify } from "devalue";
import type { SqliteDatabase } from "rivetkit/db";

import type { BackofficeDurableObjectState, BackofficeObjectAlarm } from "../local-durable-objects";
import { executeRivetSqlite } from "./rivet-sqlite";

/**
 * The tables the Durable Object migrator exports a Cloudflare object's storage API into: keys with
 * devalue-encoded values, and the object's Cloudflare ID and alarm.
 */
export const RIVET_DURABLE_OBJECT_TABLES = [
  `CREATE TABLE IF NOT EXISTS "__do_kv"(key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "__do_meta"(key TEXT PRIMARY KEY, value)`,
];

/** Retries a failed alarm after this delay, as Cloudflare retries alarms that throw. */
const ALARM_RETRY_DELAY_MS = 10_000;

/** The ID of an object hosted by a Rivet actor, named like the Durable Object it replaces. */
export class RivetDurableObjectId {
  readonly name: string;
  readonly #id: string;

  constructor(name: string, id: string) {
    this.name = name;
    this.#id = id;
  }

  toString() {
    return this.#id;
  }

  equals(other: { name?: string }) {
    return other.name === this.name;
  }
}

/** Durable Object state over an actor's SQLite; Rivet schedules its alarm. */
export class RivetDurableObjectState implements BackofficeDurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;

  readonly #database: SqliteDatabase;
  readonly #scheduleAlarm: (timestamp: number) => Promise<void>;
  readonly #keepAwake: (promise: Promise<unknown>) => void;
  #alarm: BackofficeObjectAlarm | null;
  #alarmGeneration = 0;
  readonly #pendingWaitUntil = new Set<Promise<unknown>>();
  readonly #pendingBlockConcurrency = new Set<Promise<unknown>>();
  #backgroundDrain: (() => Promise<void>) | null = null;

  /**
   * Opens the state of the object `name`. It keeps the ID Cloudflare gave it, so identities derived
   * from the ID, such as sandbox names, survive the move; objects that never ran there use the
   * actor's.
   */
  static async open(options: {
    database: SqliteDatabase;
    name: string;
    actorId: string;
    scheduleAlarm: (timestamp: number) => Promise<void>;
    keepAwake: (promise: Promise<unknown>) => void;
  }): Promise<RivetDurableObjectState> {
    const meta = new Map(
      (await executeRivetSqlite(options.database, `SELECT key, value FROM "__do_meta"`)).map(
        (row) => [row.key as string, row.value],
      ),
    );
    const cloudflareId = meta.get("id");
    const alarm = meta.get("alarm");
    return new RivetDurableObjectState(
      options,
      new RivetDurableObjectId(
        options.name,
        typeof cloudflareId === "string" ? cloudflareId : options.actorId,
      ),
      typeof alarm === "number" ? alarm : null,
    );
  }

  private constructor(
    options: {
      database: SqliteDatabase;
      scheduleAlarm: (timestamp: number) => Promise<void>;
      keepAwake: (promise: Promise<unknown>) => void;
    },
    id: RivetDurableObjectId,
    alarm: number | null,
  ) {
    this.id = id as unknown as DurableObjectId;
    this.#database = options.database;
    this.#scheduleAlarm = options.scheduleAlarm;
    this.#keepAwake = options.keepAwake;
    this.#alarm = alarm === null ? null : { timestamp: alarm, generation: 0 };
    this.storage = {
      get: this.#get.bind(this),
      put: this.#put.bind(this),
      delete: this.#delete.bind(this),
      list: this.#list.bind(this),
      getAlarm: async () => this.#alarm?.timestamp ?? null,
      setAlarm: async (timestamp: number | Date) => {
        await this.#writeAlarm(timestamp instanceof Date ? timestamp.getTime() : timestamp);
      },
      deleteAlarm: async () => {
        await this.#writeAlarm(null);
      },
    } as unknown as DurableObjectStorage;
  }

  get alarmTimestamp(): number | null {
    return this.#alarm?.timestamp ?? null;
  }

  get hasPendingWork(): boolean {
    return this.#pendingWaitUntil.size > 0 || this.#pendingBlockConcurrency.size > 0;
  }

  /** Asks Rivet to wake the actor for the stored alarm, such as one exported from Cloudflare. */
  async scheduleStoredAlarm(): Promise<void> {
    if (this.#alarm) {
      await this.#scheduleAlarm(this.#alarm.timestamp);
    }
  }

  dueAlarm(now: number): BackofficeObjectAlarm | null {
    return this.#alarm && this.#alarm.timestamp <= now ? { ...this.#alarm } : null;
  }

  /** Clears the alarm before its handler runs, as Cloudflare does, and retries it if it throws. */
  async deliverAlarm(
    expectedAlarm: BackofficeObjectAlarm,
    now: number,
    handler: () => Promise<void>,
  ): Promise<boolean> {
    if (this.dueAlarm(now)?.generation !== expectedAlarm.generation) {
      return false;
    }
    await this.#writeAlarm(null);
    const generation = this.#alarmGeneration;
    try {
      await handler();
      return true;
    } catch (error) {
      if (this.#alarmGeneration === generation) {
        await this.#writeAlarm(Date.now() + ALARM_RETRY_DELAY_MS);
      }
      throw error;
    }
  }

  async prepareForEvent(): Promise<void> {
    await this.drainBlocking();
  }

  blockConcurrencyWhile<T>(callback: () => T | Promise<T>): Promise<T> {
    const promise = Promise.resolve().then(callback);
    this.#track(this.#pendingBlockConcurrency, promise);
    return promise;
  }

  waitUntil(promise: Promise<unknown>): void {
    this.#track(this.#pendingWaitUntil, Promise.resolve(promise));
  }

  setBackgroundDrain(drain: (() => Promise<void>) | null): void {
    this.#backgroundDrain = drain;
  }

  async drainBackground(): Promise<void> {
    await this.#backgroundDrain?.();
  }

  async drainBlocking(): Promise<boolean> {
    return await drainSet(this.#pendingBlockConcurrency);
  }

  async drainWaitUntil(): Promise<boolean> {
    const drainedWaitUntil = await drainSet(this.#pendingWaitUntil);
    const drainedBlocking = await drainSet(this.#pendingBlockConcurrency);
    return drainedWaitUntil || drainedBlocking;
  }

  #track(promises: Set<Promise<unknown>>, promise: Promise<unknown>) {
    promises.add(promise);
    const settle = () => promises.delete(promise);
    void promise.then(settle, settle);
    // Rivet would otherwise put the actor to sleep under work a request left behind.
    this.#keepAwake(promise.catch(() => {}));
  }

  async #writeAlarm(timestamp: number | null): Promise<void> {
    this.#alarmGeneration += 1;
    this.#alarm =
      timestamp === null
        ? null
        : { timestamp: Math.trunc(timestamp), generation: this.#alarmGeneration };
    await executeRivetSqlite(
      this.#database,
      `INSERT OR REPLACE INTO "__do_meta"(key, value) VALUES ('alarm', ?)`,
      this.#alarm?.timestamp ?? null,
    );
    if (this.#alarm) {
      // Rivet keeps every schedule; the alarm action skips those this one replaced.
      await this.#scheduleAlarm(this.#alarm.timestamp);
    }
  }

  async #get<T>(keyOrKeys: string | string[]): Promise<T | Map<string, T> | undefined> {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    const rows = await executeRivetSqlite(
      this.#database,
      `SELECT key, value FROM "__do_kv" WHERE key IN (${keys.map(() => "?").join(", ")})`,
      ...keys,
    );
    const values = new Map(rows.map((row) => [row.key as string, parse(row.value as string) as T]));
    return Array.isArray(keyOrKeys) ? values : values.get(keyOrKeys);
  }

  async #put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    const entries =
      typeof keyOrEntries === "string" ? [[keyOrEntries, value]] : Object.entries(keyOrEntries);
    for (const [key, entryValue] of entries) {
      await executeRivetSqlite(
        this.#database,
        `INSERT OR REPLACE INTO "__do_kv"(key, value) VALUES (?, ?)`,
        key,
        stringify(entryValue),
      );
    }
  }

  async #delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    const deleted = await executeRivetSqlite(
      this.#database,
      `DELETE FROM "__do_kv" WHERE key IN (${keys.map(() => "?").join(", ")}) RETURNING key`,
      ...keys,
    );
    return Array.isArray(keyOrKeys) ? deleted.length : deleted.length > 0;
  }

  async #list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    const prefix = options.prefix ?? "";
    const rows = await executeRivetSqlite(
      this.#database,
      `SELECT key, value FROM "__do_kv" WHERE substr(key, 1, length(?)) = ? ORDER BY key`,
      prefix,
      prefix,
    );
    return new Map(rows.map((row) => [row.key as string, parse(row.value as string) as T]));
  }
}

async function drainSet(promises: Set<Promise<unknown>>): Promise<boolean> {
  const pending = [...promises];
  if (pending.length === 0) {
    return false;
  }
  await Promise.all(pending);
  return true;
}
