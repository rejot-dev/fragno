import { BufferedDatabasePump } from "../buffered-pump";
import type { DatabaseHandlerTx } from "../db-fragment-definition-builder";
import type { OutboxStreamOptions } from "../fragments/stream-outbox-entries";
import type { OutboxEntry } from "./outbox";
import type { OutboxStreamFrame } from "./outbox-stream";

const OUTBOX_OBSERVATION_POLL_INTERVAL_MS = 300;
const OUTBOX_LIVE_PAGE_SIZE = 50;
const OUTBOX_CATCH_UP_PAGE_BUDGET = 4;

type OutboxEntryStream = (options: OutboxStreamOptions) => AsyncIterable<OutboxEntry>;
type OutboxCatchUpBoundary =
  | { type: "pending"; targetVersionstamp: string | null }
  | { type: "written" };

type OutboxObserverState = {
  observerId: string;
  phase: "catching-up" | "live";
  catchUpBoundary: OutboxCatchUpBoundary;
  rotating: boolean;
  refreshPending: boolean;
  nextHeartbeatAt: number;
  afterVersionstamp: string | undefined;
  limit: number;
  writeFrame: (frame: string) => Promise<boolean>;
  recordPoll: () => void;
  recordEntryRead: () => void;
  recordError: () => void;
};

type OutboxCatchUpGroup = {
  key: string;
  afterVersionstamp: string | undefined;
  limit: number;
  observers: OutboxObserverState[];
};

type OutboxObservationDelivery =
  | {
      kind: "entry";
      observerIds: string[];
      entry: OutboxEntry;
      receivedEntryObserverIds: Set<string>;
    }
  | {
      kind: "heartbeat";
      observerIds: string[];
    }
  | { kind: "caught-up"; observerIds: string[] }
  | { kind: "rotate"; observerIds: string[] };

type OutboxObserverRegistration = {
  observerId: string;
  catchUpTargetVersionstamp: string | null;
  afterVersionstamp: string | undefined;
  limit: number;
  writeFrame: (frame: string) => Promise<boolean>;
  recordPoll: () => void;
  recordEntryRead: () => void;
  recordError: () => void;
};

type OutboxObserverHandle = {
  refreshNow: (handlerTx: DatabaseHandlerTx) => Promise<void>;
  runWhile: (options: { signal: AbortSignal; handlerTx: DatabaseHandlerTx }) => Promise<void>;
  rotate: (handlerTx: DatabaseHandlerTx) => Promise<void>;
  close: () => void;
  getFailure: () => Error | undefined;
};

/** Coordinates one shared outbox database poll for an adapter's active stream observers. */
export type OutboxObservationHub = {
  registerOutboxObserver: (registration: OutboxObserverRegistration) => OutboxObserverHandle;
  activeObserverCount: () => number;
  activeSchedulerLoopCount: () => number;
};

function oldestObserverVersionstamp(observers: readonly OutboxObserverState[]): string | undefined {
  let oldest = observers[0]?.afterVersionstamp;
  for (const observer of observers) {
    if (observer.afterVersionstamp === undefined) {
      return undefined;
    }
    if (oldest === undefined || observer.afterVersionstamp < oldest) {
      oldest = observer.afterVersionstamp;
    }
  }
  return oldest;
}

function groupCatchUpObservers(observers: readonly OutboxObserverState[]): OutboxCatchUpGroup[] {
  const groups = new Map<string, OutboxCatchUpGroup>();
  for (const observer of observers) {
    if (observer.phase !== "catching-up" || observer.rotating) {
      continue;
    }
    const key = `${observer.limit}:${observer.afterVersionstamp ?? ""}`;
    const group = groups.get(key);
    if (group) {
      group.observers.push(observer);
    } else {
      groups.set(key, {
        key,
        afterVersionstamp: observer.afterVersionstamp,
        limit: observer.limit,
        observers: [observer],
      });
    }
  }
  return [...groups.values()];
}

/** Shares bounded outbox observation work across every stream registered for an adapter. */
export function createOutboxObservationHub(
  streamOutboxEntries: OutboxEntryStream,
): OutboxObservationHub {
  const observers = new Map<string, OutboxObserverState>();
  let nextCatchUpGroupKey: string | undefined;

  function canJoinLiveTail(observer: OutboxObserverState): boolean {
    // Readiness covers a fixed historical target. Joining the shared live poll must never move
    // its cursor backwards, or an observer ready at an old target could pin healthy live streams.
    for (const current of observers.values()) {
      if (
        current.phase === "live" &&
        !current.rotating &&
        current.afterVersionstamp !== undefined &&
        (observer.afterVersionstamp === undefined ||
          observer.afterVersionstamp < current.afterVersionstamp)
      ) {
        return false;
      }
    }
    return true;
  }

  async function writeOutboxObserverFrame(observerId: string, frame: string): Promise<boolean> {
    const observer = observers.get(observerId);
    if (!observer) {
      return false;
    }
    try {
      if (await observer.writeFrame(frame)) {
        return true;
      }
    } catch (error) {
      observer.recordError();
      console.error("[outbox-observation] observer write failed", error);
    }
    if (observers.get(observerId) === observer) {
      observers.delete(observerId);
    }
    return false;
  }

  function selectCatchUpGroups(observerSnapshot: readonly OutboxObserverState[]) {
    const groups = groupCatchUpObservers(observerSnapshot);
    if (groups.length === 0) {
      nextCatchUpGroupKey = undefined;
      return [];
    }

    const requestedStartIndex = nextCatchUpGroupKey
      ? groups.findIndex((group) => group.key === nextCatchUpGroupKey)
      : 0;
    const startIndex = requestedStartIndex >= 0 ? requestedStartIndex : 0;
    const selectedCount = Math.min(OUTBOX_CATCH_UP_PAGE_BUDGET, groups.length);
    const selected = Array.from(
      { length: selectedCount },
      (_, offset) => groups[(startIndex + offset) % groups.length],
    );
    nextCatchUpGroupKey = groups[(startIndex + selectedCount) % groups.length].key;
    return selected;
  }

  async function* streamObserverEntries(
    observerSnapshot: readonly OutboxObserverState[],
    options: OutboxStreamOptions,
    receivedEntryObserverIds: Set<string>,
  ): AsyncGenerator<OutboxObservationDelivery> {
    const entryIterator = streamOutboxEntries(options)[Symbol.asyncIterator]();
    let entryCount = 0;
    for (const observer of observerSnapshot) {
      observer.refreshPending = false;
    }
    try {
      // Exhaust the bounded page even after observers close so cursor-backed drivers release their
      // connection before the serialized pump pass completes.
      while (true) {
        const result = await entryIterator.next();
        if (result.done) {
          for (const observer of observerSnapshot) {
            if (observers.get(observer.observerId) === observer && !observer.rotating) {
              observer.refreshPending = entryCount === options.limit;
            }
          }
          return;
        }

        entryCount += 1;
        const entry = result.value;
        const observerIds = observerSnapshot.flatMap((observer) => {
          if (
            observers.get(observer.observerId) !== observer ||
            observer.rotating ||
            (observer.afterVersionstamp !== undefined &&
              observer.afterVersionstamp >= entry.versionstamp)
          ) {
            return [];
          }
          return [observer.observerId];
        });
        if (observerIds.length > 0) {
          yield { kind: "entry", observerIds, entry, receivedEntryObserverIds };
        }
      }
    } finally {
      await entryIterator.return?.();
    }
  }

  async function* streamOutboxObservationDeliveries(
    observerSnapshot: readonly OutboxObserverState[],
  ): AsyncIterable<OutboxObservationDelivery> {
    const receivedEntryObserverIds = new Set<string>();
    yield {
      kind: "rotate",
      observerIds: observerSnapshot
        .filter((observer) => observer.rotating)
        .map((observer) => observer.observerId),
    };
    yield {
      kind: "caught-up",
      observerIds: observerSnapshot
        .filter((observer) => observer.catchUpBoundary.type === "pending")
        .map((observer) => observer.observerId),
    };
    const liveObservers = observerSnapshot.filter(
      (observer) =>
        observers.get(observer.observerId) === observer &&
        !observer.rotating &&
        observer.phase === "live",
    );
    if (liveObservers.length > 0) {
      for (const observer of liveObservers) {
        observer.recordPoll();
      }
      yield* streamObserverEntries(
        liveObservers,
        {
          afterVersionstamp: oldestObserverVersionstamp(liveObservers),
          limit: OUTBOX_LIVE_PAGE_SIZE,
        },
        receivedEntryObserverIds,
      );
    }

    for (const group of selectCatchUpGroups(observerSnapshot)) {
      const activeGroupObservers = group.observers.filter(
        (observer) =>
          observers.get(observer.observerId) === observer &&
          !observer.rotating &&
          observer.phase === "catching-up",
      );
      if (activeGroupObservers.length === 0) {
        continue;
      }
      for (const observer of activeGroupObservers) {
        observer.recordPoll();
      }
      yield* streamObserverEntries(
        activeGroupObservers,
        { afterVersionstamp: group.afterVersionstamp, limit: group.limit },
        receivedEntryObserverIds,
      );
      for (const observer of activeGroupObservers) {
        if (
          observers.get(observer.observerId) === observer &&
          observer.catchUpBoundary.type === "written" &&
          canJoinLiveTail(observer)
        ) {
          observer.phase = "live";
        }
      }
    }

    const heartbeatObserverIds = observerSnapshot.flatMap((observer) => {
      if (
        observers.get(observer.observerId) !== observer ||
        observer.rotating ||
        receivedEntryObserverIds.has(observer.observerId) ||
        Date.now() < observer.nextHeartbeatAt
      ) {
        return [];
      }
      return [observer.observerId];
    });
    if (heartbeatObserverIds.length > 0) {
      yield { kind: "heartbeat", observerIds: heartbeatObserverIds };
    }
    // Full pages and groups not yet serviced need another fair pass, not an idle poll delay.
    for (const observer of observers.values()) {
      if (observer.refreshPending && !observer.rotating) {
        pump.requestSchedulerRefresh();
        break;
      }
    }
  }

  const pump = new BufferedDatabasePump<never, never, OutboxObservationDelivery>({
    intervalMs: OUTBOX_OBSERVATION_POLL_INTERVAL_MS,
    onError: (error) => {
      for (const observer of observers.values()) {
        observer.recordError();
      }
      console.error("[outbox-observation] shared flush failed", error);
    },
    flush: async () => {
      const observerSnapshot = [...observers.values()];
      if (observerSnapshot.length === 0) {
        return {};
      }
      return { observedItems: streamOutboxObservationDeliveries(observerSnapshot) };
    },
  });

  async function writeCaughtUpFrame(observer: OutboxObserverState): Promise<void> {
    if (observer.catchUpBoundary.type !== "pending" || observer.rotating) {
      return;
    }
    const target = observer.catchUpBoundary.targetVersionstamp;
    if (
      target !== null &&
      (observer.afterVersionstamp === undefined || observer.afterVersionstamp < target)
    ) {
      return;
    }
    if (
      await writeOutboxObserverFrame(
        observer.observerId,
        `${JSON.stringify({ type: "caught-up", throughVersionstamp: target } satisfies OutboxStreamFrame)}\n`,
      )
    ) {
      observer.catchUpBoundary = { type: "written" };
      if (canJoinLiveTail(observer)) {
        observer.phase = "live";
      }
    }
  }

  pump.observe(async (delivery) => {
    if (delivery.kind === "rotate" || delivery.kind === "caught-up") {
      await Promise.all(
        delivery.observerIds.map(async (observerId) => {
          const observer = observers.get(observerId);
          if (!observer) {
            return;
          }
          if (delivery.kind === "caught-up") {
            await writeCaughtUpFrame(observer);
          } else {
            await writeOutboxObserverFrame(
              observerId,
              `${JSON.stringify({ type: "rotate", reason: "lease-expired" } satisfies OutboxStreamFrame)}\n`,
            );
            observers.delete(observerId);
          }
        }),
      );
      return;
    }
    if (delivery.kind === "heartbeat") {
      await Promise.all(
        delivery.observerIds.map(async (observerId) => {
          const observer = observers.get(observerId);
          if (observer && (await writeOutboxObserverFrame(observerId, '{"type":"heartbeat"}\n'))) {
            observer.nextHeartbeatAt = Date.now() + OUTBOX_OBSERVATION_POLL_INTERVAL_MS;
          }
        }),
      );
      return;
    }

    const frame = `${JSON.stringify({ type: "entry", entry: delivery.entry } satisfies OutboxStreamFrame)}\n`;
    await Promise.all(
      delivery.observerIds.map(async (observerId) => {
        const observer = observers.get(observerId);
        if (!observer) {
          return;
        }

        observer.recordEntryRead();
        if (await writeOutboxObserverFrame(observerId, frame)) {
          observer.afterVersionstamp = delivery.entry.versionstamp;
          observer.nextHeartbeatAt = Date.now() + OUTBOX_OBSERVATION_POLL_INTERVAL_MS;
          delivery.receivedEntryObserverIds.add(observerId);
          await writeCaughtUpFrame(observer);
        }
      }),
    );
  });

  return {
    registerOutboxObserver: (registration) => {
      const observer: OutboxObserverState = {
        ...registration,
        phase: "catching-up",
        catchUpBoundary: {
          type: "pending",
          targetVersionstamp: registration.catchUpTargetVersionstamp,
        },
        rotating: false,
        refreshPending: true,
        nextHeartbeatAt: 0,
        afterVersionstamp: registration.afterVersionstamp?.toLowerCase(),
      };
      if (observers.has(observer.observerId)) {
        throw new Error(`Outbox observer '${observer.observerId}' is already registered.`);
      }
      observers.set(observer.observerId, observer);

      let closed = false;
      return {
        refreshNow: (handlerTx) => pump.refreshObserved(handlerTx),
        runWhile: ({ signal, handlerTx }) => pump.runWhile({ kind: "observer", signal, handlerTx }),
        rotate: async (handlerTx) => {
          observer.rotating = true;
          await pump.refreshObserved(handlerTx);
        },
        close: () => {
          if (closed) {
            return;
          }
          closed = true;
          if (observers.get(observer.observerId) === observer) {
            observers.delete(observer.observerId);
          }
        },
        getFailure: () => pump.getFailure(),
      };
    },
    activeObserverCount: () => observers.size,
    activeSchedulerLoopCount: () => pump.activeSchedulerLoopCount(),
  };
}
