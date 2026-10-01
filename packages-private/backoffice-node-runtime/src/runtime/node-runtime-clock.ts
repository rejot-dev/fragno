/** Worker clocks either read system time or an atomically shared manual epoch in milliseconds. */
export type NodeRuntimeClock =
  | { kind: "system" }
  | { kind: "manual"; epochMilliseconds: SharedArrayBuffer };

/** Reads the same clock in the routing thread and every object worker. */
export function readNodeRuntimeClock(clock: NodeRuntimeClock): number {
  return clock.kind === "system"
    ? Date.now()
    : Number(Atomics.load(new BigInt64Array(clock.epochMilliseconds), 0));
}

/** Creates a manual clock whose advances are visible to workers without an RPC round trip. */
export function createManualNodeRuntimeClock(initialTimeEpochMs: number) {
  if (!Number.isSafeInteger(initialTimeEpochMs) || initialTimeEpochMs < 0) {
    throw new Error(
      "NODE_RUNTIME_CLOCK_INVALID_TIME: expected nonnegative integer epoch milliseconds.",
    );
  }
  const epoch = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
  Atomics.store(epoch, 0, BigInt(initialTimeEpochMs));
  const source: NodeRuntimeClock = { kind: "manual", epochMilliseconds: epoch.buffer };
  return {
    source,
    nowEpochMs: () => readNodeRuntimeClock(source),
    advanceBy(ms: number) {
      const next = readNodeRuntimeClock(source) + ms;
      if (!Number.isSafeInteger(ms) || ms < 0 || !Number.isSafeInteger(next)) {
        throw new Error(
          "NODE_RUNTIME_CLOCK_INVALID_ADVANCE: expected nonnegative integer milliseconds.",
        );
      }
      Atomics.store(epoch, 0, BigInt(next));
    },
  };
}
