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
 *
 * Polling never starts from buffered state or observer registration. Actors
 * register explicit writer or observer scheduler leases through `runWhile()`.
 * The pump elects one lease at a time, prioritizes writers, and restricts
 * observer-owned passes to read-only refreshes.
 */

export class BufferedPumpScopeAlreadyOpenError extends Error {
  readonly scopeKey: string;

  constructor(scopeKey: string) {
    super("BUFFERED_PUMP_SCOPE_ALREADY_OPEN");
    this.name = "BufferedPumpScopeAlreadyOpenError";
    this.scopeKey = scopeKey;
  }
}

export class BufferedPumpSchedulerLeaseActiveError extends Error {
  readonly pumpKey: string;
  readonly activeLeaseCount: number;

  constructor(pumpKey: string, activeLeaseCount: number) {
    super("BUFFERED_PUMP_SCHEDULER_LEASE_ACTIVE");
    this.name = "BufferedPumpSchedulerLeaseActiveError";
    this.pumpKey = pumpKey;
    this.activeLeaseCount = activeLeaseCount;
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

type BufferedPumpObserver<TObserved> = {
  handler: (message: TObserved) => void | Promise<void>;
  cursors: Set<string>;
  deliveryTail: Promise<void>;
};

export type BufferedPumpSchedulerLeaseKind = "writer" | "observer";

type BufferedPumpSchedulerLease = {
  kind: BufferedPumpSchedulerLeaseKind;
  signal: AbortSignal;
  handlerTx: DatabaseHandlerTx;
  leadership: PromiseWithResolvers<void>;
};

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
  flushAndClose(handlerTx: DatabaseHandlerTx): Promise<void>;
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

type BufferedPumpLifecycle = {
  drain(): Promise<void>;
  flushNow(handlerTx: DatabaseHandlerTx): Promise<void>;
  runWhile(options: {
    kind: BufferedPumpSchedulerLeaseKind;
    signal: AbortSignal;
    handlerTx: DatabaseHandlerTx;
  }): Promise<void>;
};

export type BufferedPumpHandle<TPump extends BufferedPumpLifecycle> = {
  readonly pump: TPump;
  runWhile(options: {
    kind: BufferedPumpSchedulerLeaseKind;
    signal: AbortSignal;
    handlerTx: DatabaseHandlerTx;
  }): Promise<void>;
  close(): Promise<void>;
  flushAndClose(handlerTx: DatabaseHandlerTx): Promise<void>;
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
    const schedulerLeases = new Set<Promise<void>>();
    const close = async () => {
      if (closed) {
        return;
      }
      if (schedulerLeases.size > 0) {
        throw new BufferedPumpSchedulerLeaseActiveError(key, schedulerLeases.size);
      }
      closed = true;
      entry.handles -= 1;
      if (entry.handles === 0) {
        this.#entries.delete(key);
        await entry.pump.drain();
      }
    };

    return {
      pump: entry.pump,
      runWhile: (options) => {
        let schedulerLease: Promise<void>;
        schedulerLease = entry.pump.runWhile(options).finally(() => {
          schedulerLeases.delete(schedulerLease);
        });
        schedulerLeases.add(schedulerLease);
        return schedulerLease;
      },
      close,
      flushAndClose: async (handlerTx) => {
        await entry.pump.flushNow(handlerTx);
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
  readonly #flush: (
    context: BufferedFlushContext<TOutgoing, TScopeMeta>,
  ) => Promise<BufferedFlushResult<TObserved, TScopeDelivery>>;
  readonly #onError: (error: Error) => void;
  readonly #scopes = new Map<string, BufferedScopeState<TOutgoing, TScopeDelivery, TScopeMeta>>();
  readonly #observers = new Set<BufferedPumpObserver<TObserved>>();
  readonly #cursorForObservedItem: BufferedPumpCursorFor<TObserved> | undefined;
  readonly #resolveScopeMeta: BufferedResolveScopeMeta<TOpenScopeMeta, TScopeMeta> | undefined;
  readonly #debugLabel: (() => string) | undefined;
  readonly #scopeDeliveryCursors = new Map<string, Set<string>>();
  #lastSnapshot: TObserved[] = [];
  #hasFlushed = false;
  #lastError: Error | undefined;
  #pumpTail = Promise.resolve();
  readonly #writableFlushWaiters: Array<{
    minimumSequence: number;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  #writableFlushStartedSequence = 0;
  readonly #intervalMs: number;
  readonly #schedulerLeases: BufferedPumpSchedulerLease[] = [];
  #schedulerLeader: BufferedPumpSchedulerLease | undefined;

  constructor(options: {
    flush: (
      context: BufferedFlushContext<TOutgoing, TScopeMeta>,
    ) => Promise<BufferedFlushResult<TObserved, TScopeDelivery>>;
    intervalMs?: number;
    onError?: (error: Error) => void;
    cursorForObservedItem?: BufferedPumpCursorFor<TObserved>;
    resolveScopeMeta?: BufferedResolveScopeMeta<TOpenScopeMeta, TScopeMeta>;
    debugLabel?: () => string;
  }) {
    this.#flush = options.flush;
    this.#cursorForObservedItem = options.cursorForObservedItem;
    this.#resolveScopeMeta = options.resolveScopeMeta;
    this.#debugLabel = options.debugLabel;
    this.#onError =
      options.onError ??
      ((error) => {
        console.error("[buffered-pump] flush failed", error);
      });
    this.#intervalMs = options.intervalMs ?? DEFAULT_BUFFERED_PUMP_INTERVAL_MS;
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
      flushAndClose: async (handlerTx) => {
        await this.#pumpTail;
        await this.flushNow(handlerTx);
        state.closed = true;
        this.#scopes.delete(state.key);
        this.#scopeDeliveryCursors.delete(state.key);
      },
    };
  }

  async flushNow(handlerTx: DatabaseHandlerTx): Promise<void> {
    let writableFlushSequence = 0;
    const run = this.#pumpTail.then(async () => {
      writableFlushSequence = ++this.#writableFlushStartedSequence;
      await this.#runPumpOnce(handlerTx, true);
    });
    this.#pumpTail = run.catch(() => {});
    try {
      await run;
      this.#resolveWritableFlushWaiters(writableFlushSequence);
    } catch (error) {
      this.#resolveWritableFlushWaiters(writableFlushSequence, error);
      throw error;
    }
  }

  async refreshObserved(handlerTx: DatabaseHandlerTx): Promise<void> {
    const run = this.#pumpTail.then(() => this.#runPumpOnce(handlerTx, false));
    this.#pumpTail = run.catch(() => {});
    await run;
  }

  /** Wait for a writable flush that starts after this call, excluding an in-progress flush. */
  async waitForNextWritableFlush(): Promise<void> {
    const minimumSequence = this.#writableFlushStartedSequence + 1;
    await new Promise<void>((resolve, reject) => {
      this.#writableFlushWaiters.push({ minimumSequence, resolve, reject });
    });
  }

  async runWhile(options: {
    kind: BufferedPumpSchedulerLeaseKind;
    signal: AbortSignal;
    handlerTx: DatabaseHandlerTx;
  }): Promise<void> {
    const lease: BufferedPumpSchedulerLease = {
      kind: options.kind,
      signal: options.signal,
      handlerTx: options.handlerTx,
      leadership: Promise.withResolvers<void>(),
    };
    this.#schedulerLeases.push(lease);
    this.#electSchedulerLeader();

    try {
      while (!lease.signal.aborted) {
        if (!(await this.#waitForSchedulerLeadership(lease))) {
          return;
        }
        while (!lease.signal.aborted && this.#schedulerLeader === lease) {
          if (this.#preferredSchedulerLeader() !== lease) {
            this.#yieldSchedulerLeadership(lease);
            break;
          }
          if (!(await this.#waitForSchedulerTick(lease.signal))) {
            break;
          }
          if (this.#preferredSchedulerLeader() !== lease) {
            this.#yieldSchedulerLeadership(lease);
            break;
          }
          try {
            if (lease.kind === "writer") {
              await this.flushNow(lease.handlerTx);
            } else {
              // Observer traces are passive only while a local writer lease exists. Without one,
              // the elected observer owns fallback polling, including its recurring storage spans.
              await this.refreshObserved(lease.handlerTx);
            }
          } catch {
            // flushNow reports through onError and restores outgoing work. The owning
            // actor keeps polling so transient storage failures can recover.
          }
        }
      }
    } finally {
      const leaseIndex = this.#schedulerLeases.indexOf(lease);
      if (leaseIndex >= 0) {
        this.#schedulerLeases.splice(leaseIndex, 1);
      }
      if (this.#schedulerLeader === lease) {
        this.#schedulerLeader = undefined;
        this.#electSchedulerLeader();
      }
    }
  }

  async drain(): Promise<void> {
    await this.#pumpTail;
  }

  activeSchedulerLeaseCount(): number {
    return this.#schedulerLeases.length;
  }

  activeSchedulerLoopCount(): number {
    return this.#schedulerLeader ? 1 : 0;
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
    return this.#registerObserver(handler, options).unsubscribe;
  }

  async observeWithReplay(
    handler: (message: TObserved) => void | Promise<void>,
    options?: BufferedPumpObserveOptions<TObserved>,
  ): Promise<() => void> {
    const registered = this.#registerObserver(handler, options);
    try {
      await this.#deliverObservedToObserver(registered.observer, this.#lastSnapshot);
      return registered.unsubscribe;
    } catch (error) {
      registered.unsubscribe();
      throw error;
    }
  }

  async waitForObserved(
    predicate: (message: TObserved) => boolean | Promise<boolean>,
    options: BufferedPumpWaitForObservedOptions<TObserved> = {},
  ): Promise<TObserved> {
    let isSettled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let resolveResult!: (message: TObserved) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<TObserved>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const settle = (complete: () => void) => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      registered.unsubscribe();
      complete();
    };
    const registered = this.#registerObserver(
      async (message) => {
        try {
          if (!(await predicate(message))) {
            return;
          }
          settle(() => {
            resolveResult(message);
          });
        } catch (error) {
          settle(() => {
            rejectResult(normalizeError(error));
          });
        }
      },
      { after: options.after },
    );

    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        settle(() => {
          rejectResult(
            new BufferedPumpObserveTimeoutError(options.timeoutMs!, options.timeoutMessage),
          );
        });
      }, options.timeoutMs);
      timeout.unref?.();
    }

    try {
      await this.#deliverObservedToObserver(registered.observer, this.#lastSnapshot);
    } catch (error) {
      settle(() => {
        rejectResult(normalizeError(error));
      });
    }
    return await result;
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

  async snapshotState(handlerTx: DatabaseHandlerTx): Promise<BufferedPumpSnapshot<TObserved>> {
    if (!this.#hasFlushed) {
      await this.refreshObserved(handlerTx);
    }
    return { items: this.#lastSnapshot.slice() };
  }

  async snapshot(handlerTx: DatabaseHandlerTx): Promise<TObserved[]> {
    return (await this.snapshotState(handlerTx)).items;
  }

  async #runPumpOnce(handlerTx: DatabaseHandlerTx, includeWritableScopes: boolean): Promise<void> {
    const drainedOutgoingByScope = new Map<
      string,
      Array<QueuedBufferedItem<TOutgoing, TOutgoing, TScopeMeta>>
    >();
    if (includeWritableScopes) {
      for (const [scopeKey, scope] of this.#scopes) {
        const drained = scope.queue.splice(0);
        if (drained.length > 0) {
          drainedOutgoingByScope.set(scopeKey, drained);
        }
      }
    }

    const batch = this.#materializeBatch(drainedOutgoingByScope);

    try {
      const result = await this.#flush({
        handlerTx,
        scopes: includeWritableScopes ? this.#scopeSnapshots() : new Map(),
        batch,
      });
      const observedItems = result.observedItems ?? [];
      if (includeWritableScopes) {
        await this.#deliverToScopes(result.scopeDeliveries ?? []);
      }
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
        await this.#deliverObservedToObserver(observer, [message]);
      }
    }
  }

  async #deliverObservedToObserver(
    observer: BufferedPumpObserver<TObserved>,
    messages: readonly TObserved[],
  ): Promise<void> {
    for (const message of messages) {
      if (this.#isAlreadyObserved(observer.cursors, message)) {
        continue;
      }
      const delivery = observer.deliveryTail.then(async () => {
        await observer.handler(message);
      });
      observer.deliveryTail = delivery.catch(() => {});
      await delivery;
    }
  }

  #registerObserver(
    handler: (message: TObserved) => void | Promise<void>,
    options?: BufferedPumpObserveOptions<TObserved>,
  ): { observer: BufferedPumpObserver<TObserved>; unsubscribe: () => void } {
    const observer: BufferedPumpObserver<TObserved> = {
      handler,
      cursors: this.#cursorsFor(options?.after ?? []),
      deliveryTail: Promise.resolve(),
    };
    this.#observers.add(observer);
    return {
      observer,
      unsubscribe: () => {
        this.#observers.delete(observer);
      },
    };
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

  #resolveWritableFlushWaiters(completedSequence: number, error?: unknown): void {
    const waiters = this.#writableFlushWaiters.splice(0);
    for (const waiter of waiters) {
      if (waiter.minimumSequence > completedSequence) {
        this.#writableFlushWaiters.push(waiter);
      } else if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve();
      }
    }
  }

  #preferredSchedulerLeader(): BufferedPumpSchedulerLease | undefined {
    return (
      this.#schedulerLeases.find((lease) => lease.kind === "writer" && !lease.signal.aborted) ??
      this.#schedulerLeases.find((lease) => !lease.signal.aborted)
    );
  }

  #electSchedulerLeader(): void {
    if (this.#schedulerLeader) {
      return;
    }
    const nextLeader = this.#preferredSchedulerLeader();
    if (!nextLeader) {
      return;
    }
    this.#schedulerLeader = nextLeader;
    nextLeader.leadership.resolve();
  }

  #yieldSchedulerLeadership(lease: BufferedPumpSchedulerLease): void {
    if (this.#schedulerLeader !== lease) {
      return;
    }
    lease.leadership = Promise.withResolvers<void>();
    this.#schedulerLeader = undefined;
    this.#electSchedulerLeader();
  }

  async #waitForSchedulerLeadership(lease: BufferedPumpSchedulerLease): Promise<boolean> {
    if (lease.signal.aborted) {
      return false;
    }
    if (this.#schedulerLeader === lease) {
      return true;
    }

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (isLeader: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        lease.signal.removeEventListener("abort", abort);
        resolve(isLeader);
      };
      const abort = () => {
        finish(false);
      };
      lease.signal.addEventListener("abort", abort, { once: true });
      lease.leadership.promise
        .then(() => {
          finish(!lease.signal.aborted);
        })
        .catch(() => {
          finish(false);
        });
    });
  }

  async #waitForSchedulerTick(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) {
      return false;
    }

    return await new Promise<boolean>((resolve) => {
      const finish = (shouldFlush: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve(shouldFlush);
      };
      const abort = () => {
        finish(false);
      };
      const timer = setTimeout(() => {
        finish(!signal.aborted);
      }, this.#intervalMs);
      timer.unref?.();
      signal.addEventListener("abort", abort, { once: true });
    });
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
