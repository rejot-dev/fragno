import { BufferedDatabasePump } from "../buffered-pump";
import type { DatabaseHandlerTx } from "../db-fragment-definition-builder";
import type { OutboxStreamOptions } from "../fragments/stream-outbox-entries";
import type { OutboxEntry } from "./outbox";

const OUTBOX_OBSERVATION_POLL_INTERVAL_MS = 300;
const OUTBOX_LIVE_PAGE_SIZE = 50;
const OUTBOX_CATCH_UP_PAGE_BUDGET = 4;

type OutboxEntryStream = (options: OutboxStreamOptions) => AsyncIterable<OutboxEntry>;
type OutboxObserverPhase = "catching-up" | "live";

type OutboxObserverState = {
  observerId: string;
  phase: OutboxObserverPhase;
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
    };

type OutboxObserverRegistration = {
  observerId: string;
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
    if (observer.phase !== "catching-up") {
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
  ): AsyncGenerator<OutboxObservationDelivery, number> {
    const entryIterator = streamOutboxEntries(options)[Symbol.asyncIterator]();
    let entryCount = 0;
    try {
      // Exhaust the bounded page even after observers close so cursor-backed drivers release their
      // connection before the serialized pump pass completes.
      while (true) {
        const result = await entryIterator.next();
        if (result.done) {
          return entryCount;
        }

        const entry = result.value;
        entryCount += 1;
        const observerIds = observerSnapshot.flatMap((observer) => {
          if (
            observers.get(observer.observerId) !== observer ||
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
    const liveObservers = observerSnapshot.filter((observer) => observer.phase === "live");
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
          observers.get(observer.observerId) === observer && observer.phase === "catching-up",
      );
      if (activeGroupObservers.length === 0) {
        continue;
      }
      for (const observer of activeGroupObservers) {
        observer.recordPoll();
      }
      const entryCount = yield* streamObserverEntries(
        activeGroupObservers,
        { afterVersionstamp: group.afterVersionstamp, limit: group.limit },
        receivedEntryObserverIds,
      );
      if (entryCount < group.limit) {
        // Pump passes are serialized, so the next live poll starts after this tail transition and
        // observes anything committed after the catch-up query.
        for (const observer of activeGroupObservers) {
          if (observers.get(observer.observerId) === observer && observer.phase === "catching-up") {
            observer.phase = "live";
          }
        }
      }
    }

    const heartbeatObserverIds = observerSnapshot.flatMap((observer) => {
      if (
        observers.get(observer.observerId) !== observer ||
        receivedEntryObserverIds.has(observer.observerId)
      ) {
        return [];
      }
      return [observer.observerId];
    });
    if (heartbeatObserverIds.length > 0) {
      yield { kind: "heartbeat", observerIds: heartbeatObserverIds };
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

  pump.observe(async (delivery) => {
    if (delivery.kind === "heartbeat") {
      await Promise.all(
        delivery.observerIds.map(async (observerId) => {
          await writeOutboxObserverFrame(observerId, "\n");
        }),
      );
      return;
    }

    const frame = `${JSON.stringify(delivery.entry)}\n`;
    await Promise.all(
      delivery.observerIds.map(async (observerId) => {
        const observer = observers.get(observerId);
        if (!observer) {
          return;
        }

        observer.recordEntryRead();
        if (await writeOutboxObserverFrame(observerId, frame)) {
          observer.afterVersionstamp = delivery.entry.versionstamp;
          delivery.receivedEntryObserverIds.add(observerId);
        }
      }),
    );
  });

  return {
    registerOutboxObserver: (registration) => {
      const observer: OutboxObserverState = {
        ...registration,
        phase: "catching-up",
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
