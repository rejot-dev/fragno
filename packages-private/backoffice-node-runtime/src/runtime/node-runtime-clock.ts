/** Shares wall time and monotonic elapsed time between routing and object workers. */
export type NodeRuntimeClock =
  | { kind: "system" }
  | {
      kind: "manual";
      epochMilliseconds: SharedArrayBuffer;
      monotonicMilliseconds: SharedArrayBuffer;
    };

/** Reads wall time for persisted leases, application time, and alarm scheduling. */
export function readNodeRuntimeEpochMilliseconds(clock: NodeRuntimeClock): number {
  return clock.kind === "system"
    ? Date.now()
    : Number(Atomics.load(new BigInt64Array(clock.epochMilliseconds), 0));
}

/** Reads process-comparable monotonic time for local authority deadlines. */
export function readNodeRuntimeMonotonicMilliseconds(clock: NodeRuntimeClock): number {
  return clock.kind === "system"
    ? Number(process.hrtime.bigint() / 1_000_000n)
    : Number(Atomics.load(new BigInt64Array(clock.monotonicMilliseconds), 0));
}

/** Creates independently adjustable wall and monotonic clocks visible without worker RPC. */
export function createManualNodeRuntimeClock(initialTimeEpochMs: number) {
  requireClockMilliseconds(initialTimeEpochMs);
  const epoch = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
  const monotonic = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
  Atomics.store(epoch, 0, BigInt(initialTimeEpochMs));
  const source: NodeRuntimeClock = {
    kind: "manual",
    epochMilliseconds: epoch.buffer,
    monotonicMilliseconds: monotonic.buffer,
  };
  return {
    source,
    nowEpochMs: () => readNodeRuntimeEpochMilliseconds(source),
    nowMonotonicMs: () => readNodeRuntimeMonotonicMilliseconds(source),
    advanceBy(milliseconds: number) {
      requireClockMilliseconds(milliseconds);
      const nextEpoch = readNodeRuntimeEpochMilliseconds(source) + milliseconds;
      const nextMonotonic = readNodeRuntimeMonotonicMilliseconds(source) + milliseconds;
      requireClockMilliseconds(nextEpoch);
      requireClockMilliseconds(nextMonotonic);
      Atomics.store(epoch, 0, BigInt(nextEpoch));
      Atomics.store(monotonic, 0, BigInt(nextMonotonic));
    },
    setEpochMilliseconds(epochMilliseconds: number) {
      requireClockMilliseconds(epochMilliseconds);
      Atomics.store(epoch, 0, BigInt(epochMilliseconds));
    },
    advanceMonotonicBy(milliseconds: number) {
      requireClockMilliseconds(milliseconds);
      const next = readNodeRuntimeMonotonicMilliseconds(source) + milliseconds;
      requireClockMilliseconds(next);
      Atomics.store(monotonic, 0, BigInt(next));
    },
  };
}

function requireClockMilliseconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      "NODE_RUNTIME_CLOCK_INVALID_TIME: expected nonnegative safe integer milliseconds.",
    );
  }
}
