import { getEnvironmentData, setEnvironmentData, threadId } from "node:worker_threads";

const environmentKey = "fragno:graft-control-store-lock";
const inheritedBuffer = getEnvironmentData(environmentKey) as SharedArrayBuffer | undefined;
const controlStoreLock = new Int32Array(
  inheritedBuffer ?? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);
setEnvironmentData(environmentKey, controlStoreLock.buffer);

/** Serializes control-log refresh/commit within the process-wide Graft cache, not between nodes. */
export function runWithGraftControlStoreLock<TResult>(operation: () => TResult): TResult {
  const owner = threadId + 1;
  // Store commands refresh their own view while holding this same synchronous lock.
  if (Atomics.load(controlStoreLock, 0) === owner) {
    return operation();
  }
  while (true) {
    const holder = Atomics.compareExchange(controlStoreLock, 0, 0, owner);
    if (holder === 0) {
      break;
    }
    // A killed worker may not run finally; bound the wait so its exit event can release the lock.
    if (Atomics.wait(controlStoreLock, 0, holder, 5_000) === "timed-out") {
      throw new Error("GRAFT_CONTROL_STORE_LOCK_TIMEOUT");
    }
  }
  try {
    // Graft 0.2.1 can panic when another local clone advances a remote log during push preparation.
    // Object-log pushes never hold this lock, so a blocked object push cannot stall node renewal.
    return operation();
  } finally {
    releaseGraftControlStoreLock(threadId);
  }
}

/** Releases only a terminated worker's lock; call after its exit, never when requesting termination. */
export function releaseGraftControlStoreLock(workerThreadId: number): void {
  if (Atomics.compareExchange(controlStoreLock, 0, workerThreadId + 1, 0) === workerThreadId + 1) {
    Atomics.notify(controlStoreLock, 0);
  }
}
