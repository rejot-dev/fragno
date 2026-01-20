type AlarmStorage = {
  setAlarm?: (timestamp: number | Date) => Promise<void>;
  getAlarm?: () => Promise<number | null>;
  deleteAlarm?: () => Promise<void>;
};

type DurableObjectSqlStorageValue = ArrayBuffer | string | number | null;

declare abstract class DurableObjectSqlStorageCursor<
  T extends Record<string, DurableObjectSqlStorageValue>,
> {
  next():
    | {
        done?: false;
        value: T;
      }
    | {
        done: true;
        value?: never;
      };
  toArray(): T[];
  one(): T;
  raw<U extends DurableObjectSqlStorageValue[]>(): IterableIterator<U>;
  columnNames: string[];
  get rowsRead(): number;
  get rowsWritten(): number;
  [Symbol.iterator](): IterableIterator<T>;
}

declare abstract class DurableObjectSqlStorageStatement {}

type DurableObjectSqlStorage = {
  exec<T extends Record<string, ArrayBuffer | string | number | null>>(
    query: string,
    // oxlint-disable-next-line no-explicit-any
    ...bindings: any[]
  ): DurableObjectSqlStorageCursor<T>;
  Cursor: typeof DurableObjectSqlStorageCursor;
  Statement: typeof DurableObjectSqlStorageStatement;
};

export type DurableObjectStorage = AlarmStorage & {
  transaction<T>(closure: (txn: { rollback(): void }) => Promise<T>): Promise<T>;
  readonly sql: DurableObjectSqlStorage;
};

export type DispatcherDurableObjectState = {
  readonly id: {
    toString(): string;
    equals(other: { toString(): string }): boolean;
    name?: string;
  };
  readonly storage: DurableObjectStorage;
  blockConcurrencyWhile?: (callback: () => Promise<void>) => void;
};

export type DispatcherDurableObjectHandler = {
  fetch: (request: Request) => Promise<Response>;
  alarm?: () => Promise<void>;
};

export type DispatcherDurableObjectFactory<TEnv = unknown> = (
  state: DispatcherDurableObjectState,
  env: TEnv,
) => DispatcherDurableObjectHandler;

export type DispatcherDurableObjectRuntimeOptions<TTickOptions, TTickResult> = {
  state: DispatcherDurableObjectState;
  tick: (options: TTickOptions) => Promise<TTickResult> | TTickResult;
  tickOptions: TTickOptions;
  queuedResult: TTickResult;
  getNextWakeAt?: () => Promise<Date | null>;
  onTickError?: (error: unknown) => void;
};

export class DispatcherDurableObjectRuntime<TTickOptions, TTickResult> {
  #state: DispatcherDurableObjectState;
  #tick: (options: TTickOptions) => Promise<TTickResult> | TTickResult;
  #tickOptions: TTickOptions;
  #queuedResult: TTickResult;
  #tickInFlight = false;
  #tickQueued = false;
  #getNextWakeAt?: () => Promise<Date | null>;
  #onTickError?: (error: unknown) => void;

  constructor(options: DispatcherDurableObjectRuntimeOptions<TTickOptions, TTickResult>) {
    this.#state = options.state;
    this.#tick = options.tick;
    this.#tickOptions = options.tickOptions;
    this.#queuedResult = options.queuedResult;
    this.#getNextWakeAt = options.getNextWakeAt;
    this.#onTickError = options.onTickError;
  }

  wake(tickOptions?: TTickOptions) {
    return this.#queueTick(tickOptions);
  }

  async alarm(): Promise<void> {
    await this.#queueTick();
  }

  async #queueTick(tickOptions?: TTickOptions): Promise<TTickResult> {
    if (this.#tickInFlight) {
      this.#tickQueued = true;
      return this.#queuedResult;
    }

    this.#tickInFlight = true;
    let result: TTickResult = this.#queuedResult;

    try {
      const effectiveOptions = tickOptions ?? this.#tickOptions;
      result = await this.#tick(effectiveOptions);
    } catch (error) {
      this.#onTickError?.(error);
      result = this.#queuedResult;
    } finally {
      await this.#scheduleNextAlarm();
      this.#tickInFlight = false;
    }

    if (this.#tickQueued) {
      this.#tickQueued = false;
      void this.#queueTick(tickOptions);
    }

    return result;
  }

  async #scheduleNextAlarm() {
    if (!this.#state.storage.setAlarm || !this.#getNextWakeAt) {
      return;
    }

    const nextWakeAt = await this.#getNextWakeAt();

    if (!nextWakeAt) {
      if (this.#state.storage.deleteAlarm) {
        await this.#state.storage.deleteAlarm();
      }
      return;
    }

    const timestamp = Math.max(nextWakeAt.getTime(), Date.now());
    await this.#state.storage.setAlarm(timestamp);
  }
}
