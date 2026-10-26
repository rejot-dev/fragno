import { BufferedDatabasePump } from "../buffered-pump";
import type { DatabaseHandlerTx } from "../db-fragment-definition-builder";
import type {
  OutboxStreamFrame,
  OutboxStreamOptions,
  SerializedOutboxStreamEntry,
} from "./outbox-stream";

const OUTBOX_OBSERVATION_POLL_INTERVAL_MS = 300;
const OUTBOX_LIVE_PAGE_SIZE = 50;
const OUTBOX_CATCH_UP_PAGE_BUDGET = 4;
// How long a pass waits on one observer's write before it stops waiting and serves the others.
const OUTBOX_OBSERVER_WRITE_PATIENCE_MS = 250;

type OutboxEntryStream = (
  options: OutboxStreamOptions,
) => AsyncIterable<SerializedOutboxStreamEntry>;
type EncodedOutboxStreamFrame = {
  frameType: OutboxStreamFrame["type"];
  encodedBytes: Uint8Array;
  characterCount: number;
};
type OutboxCatchUpBoundary =
  | { type: "pending"; targetVersionstamp: string | null }
  | { type: "written" };

type OutboxObserverState = {
  observerId: string;
  phase: "catching-up" | "live";
  catchUpBoundary: OutboxCatchUpBoundary;
  rotating: boolean;
  /** A write is still waiting for the client to read; passes skip the observer until it drains. */
  blocked: boolean;
  /**
   * The blocked write has drained. The observer stays blocked until the next pass starts: a page in
   * progress may already have skipped entries past its cursor.
   */
  drained: boolean;
  refreshPending: boolean;
  nextHeartbeatAt: number;
  afterVersionstamp: string | undefined;
  limit: number;
  writeFrame: (frame: EncodedOutboxStreamFrame) => Promise<boolean>;
  recordPoll: () => void;
  recordEntryRead: () => void;
  recordError: () => void;
  recordBlockedWrite: () => void;
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
      entry: SerializedOutboxStreamEntry;
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
  writeFrame: (frame: EncodedOutboxStreamFrame) => Promise<boolean>;
  recordPoll: () => void;
  recordEntryRead: () => void;
  recordError: () => void;
  recordBlockedWrite: () => void;
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
    if (observer.phase !== "catching-up" || observer.rotating || observer.blocked) {
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
  const frameEncoder = new TextEncoder();
  let nextCatchUpGroupKey: string | undefined;

  function encodeOutboxStreamFrame(frame: OutboxStreamFrame): EncodedOutboxStreamFrame {
    const serializedFrame = `${JSON.stringify(frame)}\n`;
    return {
      frameType: frame.type,
      encodedBytes: frameEncoder.encode(serializedFrame),
      characterCount: serializedFrame.length,
    };
  }

  function encodeOutboxEntryFrame(entry: SerializedOutboxStreamEntry): EncodedOutboxStreamFrame {
    const serializedFrame = `{"type":"entry","entry":${entry.entryJson}}\n`;
    return {
      frameType: "entry",
      encodedBytes: frameEncoder.encode(serializedFrame),
      characterCount: serializedFrame.length,
    };
  }

  const heartbeatFrame = encodeOutboxStreamFrame({ type: "heartbeat" });
  const rotateFrame = encodeOutboxStreamFrame({ type: "rotate", reason: "lease-expired" });

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

  async function writeOutboxObserverFrame(
    observerId: string,
    frame: EncodedOutboxStreamFrame,
  ): Promise<boolean> {
    const observer = observers.get(observerId);
    if (!observer) {
      return false;
    }
    const removeObserver = () => {
      if (observers.get(observerId) === observer) {
        observers.delete(observerId);
      }
    };
    const write = (async () => {
      try {
        return await observer.writeFrame(frame);
      } catch (error) {
        observer.recordError();
        console.error("[outbox-observation] observer write failed", error);
        return false;
      }
    })();
    let patienceTimeout: ReturnType<typeof setTimeout> | undefined;
    const written = await Promise.race([
      write,
      new Promise<"blocked">((resolve) => {
        patienceTimeout = setTimeout(() => {
          resolve("blocked");
        }, OUTBOX_OBSERVER_WRITE_PATIENCE_MS);
        patienceTimeout.unref?.();
      }),
    ]);
    clearTimeout(patienceTimeout);
    if (written === "blocked") {
      // The frame is queued in order behind what the client has not read yet, so the observer's
      // cursor can move past it. One client that stops reading must not hold up the shared pass,
      // so it is skipped from here until a pass that starts after the frame drained, and the
      // response gives up on a client that never reads again.
      observer.blocked = true;
      observer.recordBlockedWrite();
      void write.then((drained) => {
        if (drained) {
          observer.drained = true;
          pump.requestSchedulerRefresh();
        } else {
          removeObserver();
        }
      });
      return true;
    }
    if (!written) {
      removeObserver();
    }
    return written;
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
            observer.blocked ||
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
        !observer.blocked &&
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
          !observer.blocked &&
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
        observer.blocked ||
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
    // Full pages and groups not yet serviced need another fair pass, not an idle poll delay. A
    // blocked observer asks for its pass once its write drains.
    for (const observer of observers.values()) {
      if (observer.refreshPending && !observer.rotating && !observer.blocked) {
        pump.requestSchedulerRefresh();
        break;
      }
    }
  }

  const pump = new BufferedDatabasePump<never, never, OutboxObservationDelivery>({
    polling: "interval",
    intervalMs: OUTBOX_OBSERVATION_POLL_INTERVAL_MS,
    onError: (error) => {
      for (const observer of observers.values()) {
        observer.recordError();
      }
      console.error("[outbox-observation] shared flush failed", error);
    },
    flush: async () => {
      // Passes run one at a time, so no page is in progress here.
      for (const observer of observers.values()) {
        if (observer.drained) {
          observer.blocked = false;
          observer.drained = false;
        }
      }
      const observerSnapshot = [...observers.values()];
      if (observerSnapshot.length === 0) {
        return {};
      }
      return { observedItems: streamOutboxObservationDeliveries(observerSnapshot) };
    },
  });

  async function writeCaughtUpFrame(observer: OutboxObserverState): Promise<void> {
    if (observer.catchUpBoundary.type !== "pending" || observer.rotating || observer.blocked) {
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
        encodeOutboxStreamFrame({ type: "caught-up", throughVersionstamp: target }),
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
            await writeOutboxObserverFrame(observerId, rotateFrame);
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
          if (observer && (await writeOutboxObserverFrame(observerId, heartbeatFrame))) {
            observer.nextHeartbeatAt = Date.now() + OUTBOX_OBSERVATION_POLL_INTERVAL_MS;
          }
        }),
      );
      return;
    }

    // Writable streams do not transfer or mutate chunks, so compatible observers can safely share
    // one immutable UTF-8 frame instead of allocating one encoded copy per response.
    const frame = encodeOutboxEntryFrame(delivery.entry);
    await Promise.all(
      delivery.observerIds.map(async (observerId) => {
        const observer = observers.get(observerId);
        if (!observer || observer.blocked) {
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
        blocked: false,
        drained: false,
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
