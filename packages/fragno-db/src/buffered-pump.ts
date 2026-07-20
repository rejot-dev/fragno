import type { DatabaseHandlerTx } from "./db-fragment-definition-builder";

/**
 * BufferedDatabasePump coordinates one DB-backed pump per logical key.
 *
 * It supports four flows:
 *
 * 1. Route-only polling/observing:
 *    A route registers an observer. The pump periodically runs the DB-backed
 *    flush function, emits returned `observedItems`, and keeps no in-memory
 *    inbound queue.
 *
 * 2. Scoped outbound writing:
 *    A runner opens a scope and enqueues outgoing items. On flush, the caller's
 *    flush function persists those scoped outgoing items to the DB and returns
 *    any observable DB projection as `observedItems`.
 *
 * 3. Direct inbound writing:
 *    Inbound messages are not enqueued into the pump. They are written directly
 *    to the DB by the owning service/route, with whatever target metadata the
 *    domain requires.
 *
 * 4. DB-derived scope delivery:
 *    On each flush, the caller reads inbound records from the DB, decides which
 *    active scopes should receive them, and returns `scopeDeliveries`. The pump
 *    only routes those deliveries to registered scope handlers.
 */

export class BufferedPumpScopeAlreadyOpenError extends Error {
  readonly scopeKey: string;

  constructor(scopeKey: string) {
    super("BUFFERED_PUMP_SCOPE_ALREADY_OPEN");
    this.name = "BufferedPumpScopeAlreadyOpenError";
    this.scopeKey = scopeKey;
  }
}

export class BufferedPumpObserveTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(
    timeoutMs: number,
    message = `Timed out waiting for observed pump item after ${timeoutMs}ms.`,
  ) {
    super(message);
    this.name = "BufferedPumpObserveTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

const DEFAULT_BUFFERED_PUMP_INTERVAL_MS = 100;

const normalizeError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

type QueuedBufferedItem<TItem, TOutgoing, TScopeMeta> =
  | { kind: "value"; value: TItem }
  | { kind: "factory"; factory: BufferedItemFactory<TItem, TOutgoing, TScopeMeta> };

export type BufferedItemFactory<TItem = unknown, TOutgoing = TItem, TScopeMeta = unknown> = (
  context: BufferedItemContext<TOutgoing, TScopeMeta>,
) => TItem | readonly TItem[] | undefined;

export type BufferedItemContext<TOutgoing = unknown, TScopeMeta = unknown> = {
  scopes: ReadonlyMap<string, BufferedScopeSnapshot<TScopeMeta>>;
  scope?: BufferedScopeSnapshot<TScopeMeta>;
  outgoingByScope: ReadonlyMap<string, readonly TOutgoing[]>;
  outgoingFor(scopeKey: string): readonly TOutgoing[];
};

export type BufferedScopeSnapshot<TScopeMeta = unknown> = {
  key: string;
  meta: TScopeMeta;
  closed: boolean;
};

export type BufferedFlushContext<TOutgoing = unknown, TScopeMeta = unknown> = {
  handlerTx: DatabaseHandlerTx;
  scopes: ReadonlyMap<string, BufferedScopeSnapshot<TScopeMeta>>;
  batch: {
    outgoingByScope: ReadonlyMap<string, readonly TOutgoing[]>;
  };
};

export type BufferedScopeDelivery<TScopeDelivery = unknown> = {
  scopeKey: string;
  message: TScopeDelivery;
  cursor?: string;
};

export type BufferedFlushResult<TObserved = unknown, TScopeDelivery = unknown> = {
  scopeDeliveries?: Array<BufferedScopeDelivery<TScopeDelivery>>;
  observedItems?: TObserved[];
  snapshot?: TObserved[];
};

export type BufferedPumpCursorFor<TItem> = (item: TItem) => string | undefined;

export type BufferedPumpObserveOptions<TItem> = {
  after?: readonly TItem[];
};

export type BufferedPumpWaitForObservedOptions<TItem> = BufferedPumpObserveOptions<TItem> & {
  timeoutMs?: number;
  timeoutMessage?: string;
};

export type BufferedPumpSnapshot<TItem> = {
  readonly items: TItem[];
};

export type BufferedOpenScopeContext<TOpenScopeMeta = unknown, TScopeMeta = TOpenScopeMeta> = {
  key: string;
  meta: TOpenScopeMeta | undefined;
  scopes: ReadonlyMap<string, BufferedScopeSnapshot<TScopeMeta>>;
  hasScope(key: string): boolean;
  getScopeMeta(key: string): TScopeMeta | undefined;
};

export type BufferedResolveScopeMeta<TOpenScopeMeta = unknown, TScopeMeta = TOpenScopeMeta> = (
  context: BufferedOpenScopeContext<TOpenScopeMeta, TScopeMeta>,
) => TScopeMeta;

export type BufferedPumpScope<
  TOutgoing = unknown,
  TScopeDelivery = unknown,
  TScopeMeta = unknown,
> = {
  readonly key: string;
  readonly meta: TScopeMeta;
  enqueueOutgoing(item: TOutgoing | BufferedItemFactory<TOutgoing, TOutgoing, TScopeMeta>): void;
  onDelivery(handler: (message: TScopeDelivery) => void | Promise<void>): () => void;
  flushAndClose(): Promise<void>;
};

class BufferedScopeState<TOutgoing, TScopeDelivery, TScopeMeta> {
  readonly key: string;
  readonly meta: TScopeMeta;
  readonly handlers = new Set<(message: TScopeDelivery) => void | Promise<void>>();
  queue: Array<QueuedBufferedItem<TOutgoing, TOutgoing, TScopeMeta>> = [];
  closed = false;

  constructor(key: string, meta: TScopeMeta) {
    this.key = key;
    this.meta = meta;
  }

  snapshot(): BufferedScopeSnapshot<TScopeMeta> {
    return { key: this.key, meta: this.meta, closed: this.closed };
  }
}

class SerializedIntervalLoop {
  readonly #intervalMs: number;
  readonly #onTick: () => Promise<void>;
  readonly #afterTick: () => void;
  #abortController: AbortController | undefined;
  readonly #waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

  constructor(options: { intervalMs: number; onTick: () => Promise<void>; afterTick: () => void }) {
    this.#intervalMs = options.intervalMs;
    this.#onTick = options.onTick;
    this.#afterTick = options.afterTick;
  }

  start(): void {
    if (this.isRunning()) {
      return;
    }

    const abortController = new AbortController();
    this.#abortController = abortController;
    void this.#run(abortController.signal).finally(() => {
      if (this.#abortController === abortController) {
        this.#abortController = undefined;
      }
    });
  }

  stop(): void {
    this.#abortController?.abort();
    this.#resolveWaiters();
  }

  isRunning(): boolean {
    return !!this.#abortController && !this.#abortController.signal.aborted;
  }

  async waitForNextTick(): Promise<void> {
    this.start();
    await new Promise<void>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  async #run(signal: AbortSignal): Promise<void> {
    for await (const _ of this.#ticks(signal)) {
      let tickError: unknown;
      try {
        await this.#onTick();
      } catch (error) {
        tickError = error;
      } finally {
        this.#resolveWaiters(tickError);
        this.#afterTick();
      }
    }
  }

  async *#ticks(signal: AbortSignal): AsyncGenerator<void> {
    while (!signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.#intervalMs);
        timer.unref?.();
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      if (!signal.aborted) {
        yield;
      }
    }
  }

  #resolveWaiters(error?: unknown): void {
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) {
      if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve();
      }
    }
  }
}

type BufferedPumpLifecycle = {
  stop(): void;
  flushNow(): Promise<void>;
  waitForNextFlush(): Promise<void>;
};

export type BufferedPumpHandle<TPump extends BufferedPumpLifecycle> = {
  readonly pump: TPump;
  close(): Promise<void>;
  flushAndClose(): Promise<void>;
  waitForNextFlushAndClose(): Promise<void>;
};

export class BufferedPumpRegistry<TPump extends BufferedPumpLifecycle> {
  readonly #entries = new Map<string, { pump: TPump; handles: number }>();

  getOrCreate(key: string, create: () => TPump): BufferedPumpHandle<TPump> {
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { pump: create(), handles: 0 };
      this.#entries.set(key, entry);
    }
    entry.handles += 1;

    let closed = false;
    const close = async () => {
      if (closed) {
        return;
      }
      closed = true;
      entry.handles -= 1;
      if (entry.handles === 0) {
        entry.pump.stop();
        this.#entries.delete(key);
      }
    };

    return {
      pump: entry.pump,
      close,
      flushAndClose: async () => {
        await entry.pump.flushNow();
        await close();
      },
      waitForNextFlushAndClose: async () => {
        await entry.pump.waitForNextFlush();
        await close();
      },
    };
  }

  get(key: string): TPump | undefined {
    return this.#entries.get(key)?.pump;
  }

  values(): TPump[] {
    return [...this.#entries.values()].map((entry) => entry.pump);
  }
}

export class BufferedDatabasePump<
  TOutgoing = unknown,
  TScopeMeta = unknown,
  TObserved = TOutgoing,
  TScopeDelivery = unknown,
  TOpenScopeMeta = TScopeMeta,
> {
  #handlerTx: DatabaseHandlerTx;
  readonly #flush: (
    context: BufferedFlushContext<TOutgoing, TScopeMeta>,
  ) => Promise<BufferedFlushResult<TObserved, TScopeDelivery>>;
  readonly #onError: (error: Error) => void;
  readonly #scopes = new Map<string, BufferedScopeState<TOutgoing, TScopeDelivery, TScopeMeta>>();
  readonly #observers = new Set<{
    handler: (message: TObserved) => void | Promise<void>;
    cursors: Set<string>;
  }>();
  readonly #cursorForObservedItem: BufferedPumpCursorFor<TObserved> | undefined;
  readonly #resolveScopeMeta: BufferedResolveScopeMeta<TOpenScopeMeta, TScopeMeta> | undefined;
  readonly #debugLabel: (() => string) | undefined;
  readonly #scopeDeliveryCursors = new Map<string, Set<string>>();
  #lastSnapshot: TObserved[] = [];
  #hasFlushed = false;
  #lastError: Error | undefined;
  #pumpTail = Promise.resolve();
  readonly #loop: SerializedIntervalLoop;

  constructor(options: {
    handlerTx: DatabaseHandlerTx;
    flush: (
      context: BufferedFlushContext<TOutgoing, TScopeMeta>,
    ) => Promise<BufferedFlushResult<TObserved, TScopeDelivery>>;
    intervalMs?: number;
    onError?: (error: Error) => void;
    cursorForObservedItem?: BufferedPumpCursorFor<TObserved>;
    resolveScopeMeta?: BufferedResolveScopeMeta<TOpenScopeMeta, TScopeMeta>;
    debugLabel?: () => string;
  }) {
    this.#handlerTx = options.handlerTx;
    this.#flush = options.flush;
    this.#cursorForObservedItem = options.cursorForObservedItem;
    this.#resolveScopeMeta = options.resolveScopeMeta;
    this.#debugLabel = options.debugLabel;
    this.#onError =
      options.onError ??
      ((error) => {
        console.error("[buffered-pump] flush failed", error);
      });
    this.#loop = new SerializedIntervalLoop({
      intervalMs: options.intervalMs ?? DEFAULT_BUFFERED_PUMP_INTERVAL_MS,
      onTick: () => this.flushNow(),
      afterTick: () => {
        this.#stopIfIdle();
      },
    });
  }

  setHandlerTx(handlerTx: DatabaseHandlerTx): void {
    this.#handlerTx = handlerTx;
  }

  openScope(
    key: string,
    meta?: TOpenScopeMeta,
  ): BufferedPumpScope<TOutgoing, TScopeDelivery, TScopeMeta> {
    if (this.#scopes.has(key)) {
      throw new BufferedPumpScopeAlreadyOpenError(key);
    }

    const scopeMeta = this.#resolveScopeMeta
      ? this.#resolveScopeMeta({
          key,
          meta,
          scopes: this.#scopeSnapshots(),
          hasScope: (scopeKey) => this.hasScope(scopeKey),
          getScopeMeta: (scopeKey) => this.getScopeMeta(scopeKey),
        })
      : (meta as unknown as TScopeMeta);
    const state = new BufferedScopeState<TOutgoing, TScopeDelivery, TScopeMeta>(key, scopeMeta);
    this.#scopes.set(key, state);
    this.start();

    return {
      get key() {
        return state.key;
      },
      get meta() {
        return state.meta;
      },
      enqueueOutgoing: (item) => {
        if (state.closed) {
          return;
        }
        state.queue.push(this.#queuedItem(item));
        this.start();
      },
      onDelivery: (handler) => {
        if (state.closed) {
          return () => {};
        }
        state.handlers.add(handler);
        return () => {
          state.handlers.delete(handler);
        };
      },
      flushAndClose: async () => {
        await this.#pumpTail;
        await this.flushNow();
        state.closed = true;
        this.#scopes.delete(state.key);
        this.#scopeDeliveryCursors.delete(state.key);
        this.#stopIfIdle();
      },
    };
  }

  async flushNow(): Promise<void> {
    const run = this.#pumpTail.then(() => this.#runPumpOnce());
    this.#pumpTail = run.catch(() => {});
    await run;
  }

  async waitForNextFlush(): Promise<void> {
    await this.#loop.waitForNextTick();
  }

  start(): void {
    this.#loop.start();
  }

  stop(): void {
    this.#loop.stop();
  }

  isRunning(): boolean {
    return this.#loop.isRunning();
  }

  hasScope(key: string): boolean {
    return this.#scopes.has(key);
  }

  getScopeMeta(key: string): TScopeMeta | undefined {
    return this.#scopes.get(key)?.meta;
  }

  scopeCount(): number {
    return this.#scopes.size;
  }

  getFailure(): Error | undefined {
    return this.#lastError;
  }

  debugLabel(): string {
    return this.#debugLabel?.() ?? "buffered-pump";
  }

  observe(
    handler: (message: TObserved) => void | Promise<void>,
    options?: BufferedPumpObserveOptions<TObserved>,
  ): () => void {
    const observer = {
      handler,
      cursors: this.#cursorsFor(options?.after ?? []),
    };
    this.#observers.add(observer);
    this.start();
    return () => {
      this.#observers.delete(observer);
      this.#stopIfIdle();
    };
  }

  waitForObserved(
    predicate: (message: TObserved) => boolean | Promise<boolean>,
    options: BufferedPumpWaitForObservedOptions<TObserved> = {},
  ): Promise<TObserved> {
    return new Promise<TObserved>((resolve, reject) => {
      let isSettled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = this.observe(
        (message) => {
          void (async () => {
            try {
              if (!(await predicate(message))) {
                return;
              }
              settle(() => {
                resolve(message);
              });
            } catch (error) {
              settle(() => {
                reject(normalizeError(error));
              });
            }
          })();
        },
        { after: options.after },
      );

      const settle = (complete: () => void) => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        unsubscribe();
        complete();
      };

      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          settle(() => {
            reject(new BufferedPumpObserveTimeoutError(options.timeoutMs!, options.timeoutMessage));
          });
        }, options.timeoutMs);
      }
    });
  }

  async publishObserved(messages: readonly TObserved[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    const messagesToPublish = this.#hasFlushed
      ? this.#unobservedMessages(this.#cursorsFor(this.#lastSnapshot), messages)
      : messages;
    if (messagesToPublish.length === 0) {
      return;
    }
    if (this.#hasFlushed) {
      this.#lastSnapshot = [...this.#lastSnapshot, ...messagesToPublish];
    }
    await this.#deliverObserved(messagesToPublish);
  }

  async snapshotState(): Promise<BufferedPumpSnapshot<TObserved>> {
    if (!this.#hasFlushed) {
      await this.flushNow();
    }
    return { items: this.#lastSnapshot.slice() };
  }

  async snapshot(): Promise<TObserved[]> {
    return (await this.snapshotState()).items;
  }

  async #runPumpOnce(): Promise<void> {
    const drainedOutgoingByScope = new Map<
      string,
      Array<QueuedBufferedItem<TOutgoing, TOutgoing, TScopeMeta>>
    >();
    for (const [scopeKey, scope] of this.#scopes) {
      const drained = scope.queue.splice(0);
      if (drained.length > 0) {
        drainedOutgoingByScope.set(scopeKey, drained);
      }
    }

    const batch = this.#materializeBatch(drainedOutgoingByScope);

    try {
      const result = await this.#flush({
        handlerTx: this.#handlerTx,
        scopes: this.#scopeSnapshots(),
        batch,
      });
      const observedItems = result.observedItems ?? [];
      await this.#deliverToScopes(result.scopeDeliveries ?? []);
      this.#lastSnapshot = (result.snapshot ?? observedItems).slice();
      this.#hasFlushed = true;
      this.#lastError = undefined;
      await this.#deliverObserved(observedItems);
    } catch (error) {
      const normalizedError = normalizeError(error);
      this.#lastError = normalizedError;
      this.#restoreDrained(drainedOutgoingByScope);
      this.#onError(normalizedError);
      throw normalizedError;
    }
  }

  #materializeBatch(
    outgoingQueueByScope: ReadonlyMap<
      string,
      Array<QueuedBufferedItem<TOutgoing, TOutgoing, TScopeMeta>>
    >,
  ): BufferedFlushContext<TOutgoing, TScopeMeta>["batch"] {
    const outgoingByScope = new Map<string, TOutgoing[]>();

    for (const [scopeKey, queue] of outgoingQueueByScope) {
      const outgoing = outgoingByScope.get(scopeKey) ?? [];
      outgoingByScope.set(scopeKey, outgoing);
      const scope = this.#scopes.get(scopeKey)?.snapshot();
      for (const item of queue) {
        this.#appendMaterialized(outgoing, this.#materializeItem(item, scope, outgoingByScope));
      }
    }

    return { outgoingByScope };
  }

  #materializeItem<TItem>(
    item: QueuedBufferedItem<TItem, TOutgoing, TScopeMeta>,
    scope: BufferedScopeSnapshot<TScopeMeta> | undefined,
    outgoingByScope: ReadonlyMap<string, readonly TOutgoing[]>,
  ): TItem | readonly TItem[] | undefined {
    if (item.kind === "value") {
      return item.value;
    }
    return item.factory({
      scopes: this.#scopeSnapshots(),
      scope,
      outgoingByScope,
      outgoingFor: (scopeKey) => outgoingByScope.get(scopeKey) ?? [],
    });
  }

  #scopeSnapshots(): ReadonlyMap<string, BufferedScopeSnapshot<TScopeMeta>> {
    return new Map([...this.#scopes].map(([key, scope]) => [key, scope.snapshot()]));
  }

  #restoreDrained(
    outgoingByScope: ReadonlyMap<
      string,
      Array<QueuedBufferedItem<TOutgoing, TOutgoing, TScopeMeta>>
    >,
  ): void {
    for (const [scopeKey, outgoing] of outgoingByScope) {
      const scope = this.#scopes.get(scopeKey);
      if (scope && !scope.closed) {
        scope.queue.unshift(...outgoing);
      }
    }
  }

  async #deliverToScopes(deliveries: Array<BufferedScopeDelivery<TScopeDelivery>>): Promise<void> {
    for (const delivery of deliveries) {
      const scope = this.#scopes.get(delivery.scopeKey);
      if (!scope || scope.closed || this.#isAlreadyDeliveredToScope(delivery)) {
        continue;
      }
      await Promise.all(
        [...scope.handlers].map(async (handler) => {
          await handler(delivery.message);
        }),
      );
    }
  }

  #isAlreadyDeliveredToScope(delivery: BufferedScopeDelivery<TScopeDelivery>): boolean {
    if (!delivery.cursor) {
      return false;
    }
    const cursors = this.#scopeDeliveryCursors.get(delivery.scopeKey) ?? new Set<string>();
    this.#scopeDeliveryCursors.set(delivery.scopeKey, cursors);
    if (cursors.has(delivery.cursor)) {
      return true;
    }
    cursors.add(delivery.cursor);
    return false;
  }

  async #deliverObserved(messages: readonly TObserved[]): Promise<void> {
    for (const message of messages) {
      for (const observer of this.#observers) {
        if (this.#isAlreadyObserved(observer.cursors, message)) {
          continue;
        }
        await observer.handler(message);
      }
    }
  }

  #isAlreadyObserved(cursors: Set<string>, message: TObserved): boolean {
    const cursor = this.#cursorForObservedItem?.(message);
    if (!cursor) {
      return false;
    }
    if (cursors.has(cursor)) {
      return true;
    }
    cursors.add(cursor);
    return false;
  }

  #unobservedMessages(cursors: Set<string>, messages: readonly TObserved[]): TObserved[] {
    return messages.filter((message) => !this.#isAlreadyObserved(cursors, message));
  }

  #cursorsFor(items: readonly TObserved[]): Set<string> {
    const cursors = new Set<string>();
    for (const item of items) {
      const cursor = this.#cursorForObservedItem?.(item);
      if (cursor) {
        cursors.add(cursor);
      }
    }
    return cursors;
  }

  #hasPendingWork(): boolean {
    return [...this.#scopes.values()].some((scope) => scope.queue.length > 0);
  }

  #stopIfIdle(): void {
    if (!this.#hasPendingWork() && this.#scopes.size === 0 && this.#observers.size === 0) {
      this.stop();
    }
  }

  #queuedItem<TItem>(
    item: TItem | BufferedItemFactory<TItem, TOutgoing, TScopeMeta>,
  ): QueuedBufferedItem<TItem, TOutgoing, TScopeMeta> {
    if (typeof item === "function") {
      return {
        kind: "factory",
        factory: item as BufferedItemFactory<TItem, TOutgoing, TScopeMeta>,
      };
    }
    return this.#queuedValue(item);
  }

  #queuedValue<TItem>(value: TItem): QueuedBufferedItem<TItem, TOutgoing, TScopeMeta> {
    return { kind: "value", value };
  }

  #appendMaterialized<TItem>(target: TItem[], value: TItem | readonly TItem[] | undefined): void {
    if (value === undefined) {
      return;
    }
    if (Array.isArray(value)) {
      target.push(...value);
      return;
    }
    target.push(value as TItem);
  }
}
