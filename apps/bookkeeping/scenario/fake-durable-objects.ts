import Database from "better-sqlite3";

type SqlValue = ArrayBuffer | string | number | null;
type Row = Record<string, SqlValue>;

/** Converts what Durable Object SQLite accepts into what better-sqlite3 binds. */
function toSqliteValue(value: unknown): unknown {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  return value;
}

function fromSqliteRow(row: Record<string, unknown>): Row {
  const converted: Row = {};
  for (const [column, value] of Object.entries(row)) {
    converted[column] = Buffer.isBuffer(value) ? new Uint8Array(value).buffer : (value as SqlValue);
  }
  return converted;
}

/** The part of a Durable Object SQLite cursor Bookkeeping and Fragno's dialect read. */
class FakeSqlCursor<T extends Row> {
  readonly #rows: T[];
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;

  constructor(rows: T[], columnNames: string[], rowsWritten: number) {
    this.#rows = rows;
    this.columnNames = columnNames;
    this.rowsRead = rows.length;
    this.rowsWritten = rowsWritten;
  }

  toArray(): T[] {
    return [...this.#rows];
  }

  one(): T {
    if (this.#rows.length !== 1) {
      throw new Error(`Expected exactly one row, got ${this.#rows.length}.`);
    }
    return this.#rows[0];
  }

  *raw<U extends SqlValue[]>(): IterableIterator<U> {
    for (const row of this.#rows) {
      yield this.columnNames.map((column) => row[column]) as U;
    }
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.#rows[Symbol.iterator]();
  }
}

/**
 * A Durable Object's state on in-memory SQLite: `storage.sql`, synchronous KV, transactions,
 * alarms, and `blockConcurrencyWhile`. Objects run their Cloudflare code unchanged.
 */
export class FakeDurableObjectState {
  readonly id: { name: string; toString(): string; equals(other: { name?: string }): boolean };
  readonly database = new Database(":memory:");
  readonly #kv = new Map<string, unknown>();
  #alarm: number | null = null;
  #savepoints = 0;
  // Asynchronous transactions run one at a time, as Durable Object storage runs them.
  #transactions: Promise<unknown> = Promise.resolve();
  readonly #pending = new Set<Promise<unknown>>();
  ready: Promise<void> = Promise.resolve();

  constructor(name: string) {
    // Fragno computes "now" in SQL; it must read the scenario's clock, as the code around it does.
    this.database.function("julianday", { deterministic: false }, (value: unknown) => {
      if (value !== "now") {
        throw new Error(
          `The fake Durable Object only supports julianday('now'), not ${String(value)}.`,
        );
      }
      // Half a millisecond keeps Fragno's cast back to milliseconds from truncating a float error.
      return (Date.now() + 0.5) / 86_400_000 + 2_440_587.5;
    });
    this.id = {
      name,
      toString: () => name,
      equals: (other) => other.name === name,
    };
  }

  readonly storage = {
    sql: {
      exec: <T extends Row>(query: string, ...bindings: unknown[]): FakeSqlCursor<T> =>
        this.#exec<T>(query, bindings),
    },
    kv: {
      get: (key: string): unknown => this.#kv.get(key),
      put: (key: string, value: unknown): void => {
        this.#kv.set(key, structuredClone(value));
      },
      delete: (key: string): boolean => this.#kv.delete(key),
    },
    transactionSync: <T>(closure: () => T): T => this.#savepoint(closure),
    transaction: <T>(closure: (transaction: { rollback(): void }) => Promise<T>): Promise<T> => {
      const running = this.#transactions.then(() => this.#transaction(closure));
      this.#transactions = running.catch(() => undefined);
      return running;
    },
    getAlarm: async (): Promise<number | null> => this.#alarm,
    setAlarm: async (scheduledTime: number | Date): Promise<void> => {
      this.#alarm = typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime();
    },
    deleteAlarm: async (): Promise<void> => {
      this.#alarm = null;
    },
  };

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const running = callback();
    this.ready = running.then(() => undefined);
    return running;
  }

  waitUntil(promise: Promise<unknown>): void {
    const tracked = promise.finally(() => {
      this.#pending.delete(tracked);
    });
    this.#pending.add(tracked);
  }

  /** The alarm's time, if it is due at `now`; firing it is the runtime's job. */
  dueAlarm(now: number): number | null {
    return this.#alarm !== null && this.#alarm <= now ? this.#alarm : null;
  }

  clearAlarm(): void {
    this.#alarm = null;
  }

  async settle(): Promise<void> {
    await Promise.all(this.#pending);
  }

  #exec<T extends Row>(query: string, bindings: unknown[]): FakeSqlCursor<T> {
    let statement: Database.Statement;
    try {
      statement = this.database.prepare(query);
    } catch (error) {
      // Durable Object SQLite runs a script of several statements when it has no bindings.
      if (
        bindings.length === 0 &&
        error instanceof Error &&
        error.message.includes("more than one statement")
      ) {
        this.database.exec(query);
        return new FakeSqlCursor<T>([], [], 0);
      }
      throw error;
    }
    const values = bindings.map(toSqliteValue);
    if (!statement.reader) {
      const { changes } = statement.run(...values);
      return new FakeSqlCursor<T>([], [], changes);
    }
    const rows = (statement.all(...values) as Record<string, unknown>[]).map(fromSqliteRow) as T[];
    const changes = statement.readonly
      ? 0
      : (this.database.prepare("SELECT changes() AS changes").get() as { changes: number }).changes;
    return new FakeSqlCursor<T>(
      rows,
      statement.columns().map(({ name }) => name),
      changes,
    );
  }

  async #transaction<T>(closure: (transaction: { rollback(): void }) => Promise<T>): Promise<T> {
    const name = this.#beginSavepoint();
    let rolledBack = false;
    try {
      const result = await closure({
        rollback: () => {
          rolledBack = true;
        },
      });
      if (rolledBack) {
        this.#rollbackSavepoint(name);
      } else {
        this.database.exec(`RELEASE ${name}`);
      }
      return result;
    } catch (error) {
      this.#rollbackSavepoint(name);
      throw error;
    }
  }

  #beginSavepoint(): string {
    const name = `fake_do_${++this.#savepoints}`;
    this.database.exec(`SAVEPOINT ${name}`);
    return name;
  }

  #rollbackSavepoint(name: string): void {
    this.database.exec(`ROLLBACK TO ${name}`);
    this.database.exec(`RELEASE ${name}`);
  }

  #savepoint<T>(closure: () => T): T {
    const name = this.#beginSavepoint();
    try {
      const result = closure();
      this.database.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.#rollbackSavepoint(name);
      throw error;
    }
  }
}

/** What crosses Durable Object RPC: a thrown error keeps only its name and message. */
function rpcError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }
  const crossed = new Error(error.message);
  crossed.name = error.name;
  return crossed;
}

type DurableObjectClass<TObject, TEnv> = new (state: never, env: TEnv) => TObject;

/**
 * One binding's objects, each created on first use by name. Calls wait for the object's
 * `blockConcurrencyWhile`, and arguments and results are copied as RPC copies them, so code that
 * relies on sharing objects or on error classes fails here as it would in Cloudflare.
 */
export class FakeDurableObjectNamespace<TObject extends object, TEnv> {
  readonly #objectClass: DurableObjectClass<TObject, TEnv>;
  readonly #env: TEnv;
  readonly #objects = new Map<string, { state: FakeDurableObjectState; object: TObject }>();

  constructor(objectClass: DurableObjectClass<TObject, TEnv>, env: TEnv) {
    this.#objectClass = objectClass;
    this.#env = env;
  }

  getByName(name: string): TObject {
    let entry = this.#objects.get(name);
    if (!entry) {
      const state = new FakeDurableObjectState(name);
      entry = { state, object: new this.#objectClass(state as never, this.#env) };
      this.#objects.set(name, entry);
    }
    return this.#stub(entry);
  }

  /** Every object created so far, for the runtime to fire alarms and await background work. */
  entries(): { state: FakeDurableObjectState; object: TObject }[] {
    return [...this.#objects.values()];
  }

  close(): void {
    for (const { state } of this.#objects.values()) {
      state.database.close();
    }
  }

  #stub({ state, object }: { state: FakeDurableObjectState; object: TObject }): TObject {
    return new Proxy(object, {
      get(target, property) {
        // RPC reaches an object's methods by name, whatever its class declares.
        const value = (target as Record<PropertyKey, unknown>)[property];
        if (typeof value !== "function") {
          return value;
        }
        return async (...args: unknown[]) => {
          await state.ready;
          // Requests and responses stream across RPC; everything else is copied.
          const isFetch = property === "fetch";
          try {
            const result: unknown = await value.apply(
              target,
              isFetch ? args : args.map((arg) => structuredClone(arg)),
            );
            return isFetch ? result : structuredClone(result);
          } catch (error) {
            throw rpcError(error);
          }
        };
      },
    });
  }
}
