type InMemoryStorageListOptions = {
  prefix?: string;
};

const toAlarmTimestamp = (value: number | Date) =>
  value instanceof Date ? value.getTime() : Math.trunc(value);

class InMemoryDurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;

  #storage = new Map<string, unknown>();
  #alarm: number | null = null;
  #pendingWaitUntil = new Set<Promise<unknown>>();
  #pendingBlockConcurrency = new Set<Promise<unknown>>();

  constructor(id: DurableObjectId) {
    this.id = id;
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
    return this.#alarm;
  }

  get hasPendingWork(): boolean {
    return this.#pendingWaitUntil.size > 0 || this.#pendingBlockConcurrency.size > 0;
  }

  consumeDueAlarm(now = Date.now()): boolean {
    if (this.#alarm === null || this.#alarm > now) {
      return false;
    }

    this.#alarm = null;
    return true;
  }

  blockConcurrencyWhile<T>(callback: () => T | Promise<T>): Promise<T> {
    const promise = Promise.resolve().then(callback);
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
      return new Map(keyOrKeys.map((key) => [key, this.#storage.get(key) as T]));
    }

    return this.#storage.get(keyOrKeys) as T | undefined;
  }

  async #put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.#storage.set(keyOrEntries, value);
      return;
    }

    for (const [key, entryValue] of Object.entries(keyOrEntries)) {
      this.#storage.set(key, entryValue);
    }
  }

  async #delete(keyOrKeys: string | string[]): Promise<boolean> {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    let deleted = false;
    for (const key of keys) {
      deleted = this.#storage.delete(key) || deleted;
    }
    return deleted;
  }

  async #list<T = unknown>(options: InMemoryStorageListOptions = {}): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    const entries = [...this.#storage.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );

    for (const [key, value] of entries) {
      if (options.prefix && !key.startsWith(options.prefix)) {
        continue;
      }
      result.set(key, value as T);
    }

    return result;
  }

  async #getAlarm(): Promise<number | null> {
    return this.#alarm;
  }

  async #setAlarm(timestamp: number | Date): Promise<void> {
    this.#alarm = toAlarmTimestamp(timestamp);
  }

  async #deleteAlarm(): Promise<void> {
    this.#alarm = null;
  }
}

export type InMemoryDurableObjectFactory<TObject> = (input: {
  id: DurableObjectId;
  name: string;
  state: InMemoryDurableObjectState;
}) => TObject;

export type InMemoryDurableObjectInstance<TObject = unknown> = {
  id: DurableObjectId;
  name: string;
  state: InMemoryDurableObjectState;
  object: TObject;
  stub: TObject;
};

class InMemoryDurableObjectId {
  constructor(
    readonly namespace: string,
    readonly name: string,
  ) {}

  toString() {
    return `${this.namespace}:${this.name}`;
  }

  equals(other: unknown) {
    return other instanceof InMemoryDurableObjectId && other.toString() === this.toString();
  }
}

const isAsyncFunction = (value: unknown) =>
  typeof value === "function" && value.constructor.name === "AsyncFunction";

export class InMemoryDurableObjectNamespace<TObject> {
  readonly name: string;

  #createObject: InMemoryDurableObjectFactory<TObject>;
  #instances = new Map<string, InMemoryDurableObjectInstance<TObject>>();

  constructor(options: { name: string; createObject: InMemoryDurableObjectFactory<TObject> }) {
    this.name = options.name;
    this.#createObject = options.createObject;
  }

  idFromName(name: string): DurableObjectId {
    return new InMemoryDurableObjectId(this.name, name) as unknown as DurableObjectId;
  }

  get(id: DurableObjectId): TObject {
    const key = String(id);
    const existing = this.#instances.get(key);
    if (existing) {
      return existing.stub;
    }

    const state = new InMemoryDurableObjectState(id);
    const object = this.#createObject({
      id,
      name: key,
      state,
    });
    const stub = this.#createStub(object, state);
    const instance = {
      id,
      name: key,
      state,
      object,
      stub,
    } satisfies InMemoryDurableObjectInstance<TObject>;
    this.#instances.set(key, instance);
    return stub;
  }

  has(id: DurableObjectId): boolean {
    return this.#instances.has(String(id));
  }

  instances(): InMemoryDurableObjectInstance<TObject>[] {
    return [...this.#instances.values()];
  }

  async drainWaitUntil(): Promise<boolean> {
    const results = await Promise.all(
      this.instances().map(async ({ state }) => await state.drainWaitUntil()),
    );
    return results.some(Boolean);
  }

  dueAlarmInstances(now = Date.now()): InMemoryDurableObjectInstance<TObject>[] {
    return this.instances().filter(
      ({ state }) => state.alarmTimestamp !== null && state.alarmTimestamp <= now,
    );
  }

  #createStub(object: TObject, state: InMemoryDurableObjectState): TObject {
    const cache = new Map<PropertyKey, unknown>();

    return new Proxy(object as object, {
      get(target, property, _receiver): unknown {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") {
          return value;
        }

        if (cache.has(property)) {
          return cache.get(property);
        }

        if (!isAsyncFunction(value)) {
          const bound = value.bind(target);
          cache.set(property, bound);
          return bound;
        }

        const wrapped = async (...args: unknown[]) => {
          await state.drainBlocking();
          return await (value as (...innerArgs: unknown[]) => Promise<unknown>).apply(target, args);
        };
        cache.set(property, wrapped);
        return wrapped;
      },
    }) as TObject;
  }
}
