import { AsyncLocalStorage } from "node:async_hooks";

export type BackofficeObjectAlarm = {
  timestamp: number;
  generation: number;
};

type LocalStorageListOptions = {
  prefix?: string;
};

export type BackofficeDurableObjectState = {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
  readonly alarmTimestamp: number | null;
  readonly hasPendingWork: boolean;
  dueAlarm(now: number): BackofficeObjectAlarm | null;
  deliverAlarm(
    expectedAlarm: BackofficeObjectAlarm,
    now: number,
    handler: () => Promise<void>,
  ): Promise<boolean>;
  prepareForEvent(): Promise<void>;
  blockConcurrencyWhile<T>(callback: () => T | Promise<T>): Promise<T>;
  waitUntil(promise: Promise<unknown>): void;
  setBackgroundDrain(drain: (() => Promise<void>) | null): void;
  drainBackground(): Promise<void>;
  drainBlocking(): Promise<boolean>;
  drainWaitUntil(): Promise<boolean>;
};

export type BackofficeObjectExecutionCoordinator = {
  run<T>(objectId: string, operation: () => Promise<T>): Promise<T>;
  waitForIdle(): Promise<void>;
};

/** Tracks concurrent object operations within one process without imposing cross-event ordering. */
export class ProcessLocalObjectExecutionCoordinator implements BackofficeObjectExecutionCoordinator {
  readonly #activeExecution = new AsyncLocalStorage<{ objectId: string; active: boolean }>();
  readonly #activeOperations = new Set<Promise<unknown>>();

  async run<T>(objectId: string, operation: () => Promise<T>): Promise<T> {
    const activeExecution = this.#activeExecution.getStore();
    if (activeExecution?.objectId === objectId && activeExecution.active) {
      return await operation();
    }

    const execution = { objectId, active: true };
    const operationPromise = this.#activeExecution.run(execution, operation);
    const trackedOperation = operationPromise.finally(() => {
      execution.active = false;
      this.#activeOperations.delete(trackedOperation);
    });
    this.#activeOperations.add(trackedOperation);
    return await trackedOperation;
  }

  async waitForIdle(): Promise<void> {
    while (this.#activeOperations.size > 0) {
      await Promise.allSettled(this.#activeOperations);
    }
  }
}

/** Implements transient Durable Object state for in-process tests. */
export class InMemoryDurableObjectState implements BackofficeDurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;

  readonly #values = new Map<string, unknown>();
  #alarm: BackofficeObjectAlarm | null = null;
  #alarmGeneration = 0;
  readonly #pendingWaitUntil = new Set<Promise<unknown>>();
  readonly #pendingBlockConcurrency = new Set<Promise<unknown>>();
  #backgroundDrain: (() => Promise<void>) | null = null;

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
    return this.#alarm?.timestamp ?? null;
  }

  get hasPendingWork(): boolean {
    return this.#pendingWaitUntil.size > 0 || this.#pendingBlockConcurrency.size > 0;
  }

  dueAlarm(now: number): BackofficeObjectAlarm | null {
    if (this.#alarm === null || this.#alarm.timestamp > now) {
      return null;
    }
    return { ...this.#alarm };
  }

  async prepareForEvent(): Promise<void> {
    await this.drainBlocking();
  }

  async deliverAlarm(
    expectedAlarm: BackofficeObjectAlarm,
    now: number,
    handler: () => Promise<void>,
  ): Promise<boolean> {
    const alarm = this.dueAlarm(now);
    if (alarm?.generation !== expectedAlarm.generation) {
      return false;
    }
    this.#alarm = null;
    try {
      await handler();
      return true;
    } catch (error) {
      if (this.#alarmGeneration === alarm.generation) {
        this.#alarm = alarm;
      }
      throw error;
    }
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
      return new Map(keyOrKeys.map((key) => [key, this.#values.get(key) as T]));
    }
    return this.#values.get(keyOrKeys) as T | undefined;
  }

  async #put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    const entries =
      typeof keyOrEntries === "string"
        ? new Map([[keyOrEntries, value]])
        : new Map(Object.entries(keyOrEntries));
    for (const [key, entryValue] of entries) {
      this.#values.set(key, entryValue);
    }
  }

  async #delete(keyOrKeys: string | string[]): Promise<boolean> {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    let deleted = false;
    for (const key of keys) {
      deleted = this.#values.delete(key) || deleted;
    }
    return deleted;
  }

  async #list<T = unknown>(options: LocalStorageListOptions = {}): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    const entries = [...this.#values.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
    for (const [key, value] of entries) {
      if (!options.prefix || key.startsWith(options.prefix)) {
        result.set(key, value as T);
      }
    }
    return result;
  }

  async #getAlarm(): Promise<number | null> {
    return this.#alarm?.timestamp ?? null;
  }

  async #setAlarm(timestamp: number | Date): Promise<void> {
    this.#alarmGeneration += 1;
    this.#alarm = {
      timestamp: timestamp instanceof Date ? timestamp.getTime() : Math.trunc(timestamp),
      generation: this.#alarmGeneration,
    };
  }

  async #deleteAlarm(): Promise<void> {
    this.#alarmGeneration += 1;
    this.#alarm = null;
  }
}

export type LocalDurableObjectFactory<TObject> = (input: {
  id: DurableObjectId;
  name: string;
  state: BackofficeDurableObjectState;
}) => TObject;

export type LocalDurableObjectInstance<TObject = unknown> = {
  id: DurableObjectId;
  name: string;
  state: BackofficeDurableObjectState;
  object: TObject;
  stub: TObject;
};

class LocalDurableObjectId {
  constructor(
    readonly namespace: string,
    readonly name: string,
  ) {}

  toString() {
    return `${this.namespace}:${this.name}`;
  }

  equals(other: unknown) {
    return other instanceof LocalDurableObjectId && other.toString() === this.toString();
  }
}

function isAsyncFunction(value: unknown): boolean {
  return typeof value === "function" && value.constructor.name === "AsyncFunction";
}

export class LocalDurableObjectNamespace<TObject> {
  readonly name: string;

  readonly #createObject: LocalDurableObjectFactory<TObject>;
  readonly #createState: (id: DurableObjectId) => BackofficeDurableObjectState;
  readonly #executionCoordinator: BackofficeObjectExecutionCoordinator;
  readonly #instances = new Map<string, LocalDurableObjectInstance<TObject>>();

  constructor(options: {
    name: string;
    createObject: LocalDurableObjectFactory<TObject>;
    createState: (id: DurableObjectId) => BackofficeDurableObjectState;
    executionCoordinator: BackofficeObjectExecutionCoordinator;
  }) {
    this.name = options.name;
    this.#createObject = options.createObject;
    this.#createState = options.createState;
    this.#executionCoordinator = options.executionCoordinator;
  }

  idFromName(name: string): DurableObjectId {
    return new LocalDurableObjectId(this.name, name) as unknown as DurableObjectId;
  }

  get(id: DurableObjectId): TObject {
    const key = String(id);
    return this.#instances.get(key)?.stub ?? this.#createInstance(id, key).stub;
  }

  async restorePersisted(id: DurableObjectId): Promise<void> {
    const instance = this.#instances.get(String(id)) ?? this.#createInstance(id, String(id));
    await instance.state.prepareForEvent();
  }

  async discoverPersisted(id: DurableObjectId): Promise<void> {
    await this.restorePersisted(id);
  }

  has(id: DurableObjectId): boolean {
    return this.#instances.has(String(id));
  }

  async restart(id: DurableObjectId): Promise<TObject> {
    const key = String(id);
    return await this.#executionCoordinator.run(key, async () => {
      const existing = this.#instances.get(key);
      if (existing) {
        await existing.state.drainWaitUntil();
      }
      const replacement = this.#createInstance(id, key, existing?.state ?? this.#createState(id));
      await replacement.state.drainBlocking();
      return replacement.stub;
    });
  }

  instances(): LocalDurableObjectInstance<TObject>[] {
    return [...this.#instances.values()];
  }

  async drainWaitUntil(): Promise<boolean> {
    const results = await Promise.all(
      this.instances().map(async ({ state }) => await state.drainWaitUntil()),
    );
    return results.some(Boolean);
  }

  async drainBackground(): Promise<void> {
    await Promise.all(
      this.instances().map(async (instance) => {
        await this.#executionCoordinator.run(instance.name, async () => {
          const activeInstance = this.#activeInstance(instance.name);
          await activeInstance.state.prepareForEvent();
          await activeInstance.state.drainBackground();
          await activeInstance.state.drainWaitUntil();
        });
      }),
    );
  }

  async deliverAlarm(
    instance: LocalDurableObjectInstance<TObject>,
    expectedAlarm: BackofficeObjectAlarm,
    now: number,
  ): Promise<boolean> {
    return await this.#executionCoordinator.run(instance.name, async () => {
      const activeInstance = this.#activeInstance(instance.name);
      await activeInstance.state.prepareForEvent();
      return await activeInstance.state.deliverAlarm(expectedAlarm, now, async () => {
        const alarmHandler = (activeInstance.object as { alarm?: () => Promise<void> }).alarm;
        if (alarmHandler) {
          await alarmHandler.call(activeInstance.object);
        }
      });
    });
  }

  #activeInstance(name: string): LocalDurableObjectInstance<TObject> {
    const instance = this.#instances.get(name);
    if (!instance) {
      throw new Error(`LOCAL_DURABLE_OBJECT_INSTANCE_MISSING:${name}`);
    }
    return instance;
  }

  #createInstance(
    id: DurableObjectId,
    name: string,
    state: BackofficeDurableObjectState = this.#createState(id),
  ): LocalDurableObjectInstance<TObject> {
    const object = this.#createObject({ id, name, state });
    const instance = {
      id,
      name,
      state,
      object,
      stub: this.#createStub(name, object),
    } satisfies LocalDurableObjectInstance<TObject>;
    this.#instances.set(name, instance);
    return instance;
  }

  #createStub(name: string, object: TObject): TObject {
    const cache = new Map<PropertyKey, unknown>();
    const target = object as Record<PropertyKey, unknown>;
    const executionCoordinator = this.#executionCoordinator;
    const activeInstance = this.#activeInstance.bind(this);

    return new Proxy(target, {
      get(target, property): unknown {
        const value = target[property];
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

        const wrapped = async (...args: unknown[]) =>
          await executionCoordinator.run(name, async () => {
            const instance = activeInstance(name);
            await instance.state.prepareForEvent();
            const method = (instance.object as Record<PropertyKey, unknown>)[property];
            if (typeof method !== "function") {
              throw new Error(`LOCAL_DURABLE_OBJECT_METHOD_MISSING:${name}:${String(property)}`);
            }
            const result = await (method as (...innerArgs: unknown[]) => Promise<unknown>).apply(
              instance.object,
              args,
            );
            return result;
          });
        cache.set(property, wrapped);
        return wrapped;
      },
    }) as TObject;
  }
}
