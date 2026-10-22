import { CODEMODE_LIMITS } from "../codemode-limits";

// Shared by WebSocket activations and private compiler RPC calls in the same Worker isolate.
let activeCompilerOperations = 0;
const waitingCompilerOperations: symbol[] = [];
const ADMISSION_POLL_MS = 25;

/** The isolate already has a full queue of compilations; the caller may try again later. */
export class CodemodeCompilerBusyError extends Error {
  constructor() {
    super("CODEMODE_COMPILER_BUSY");
    this.name = "CodemodeCompilerBusyError";
  }
}

/**
 * Compilation runs in this isolate's memory, so operations beyond the limit wait in arrival order,
 * up to a bounded queue. Waiters poll on their own timer rather than await a promise another
 * request resolves: workerd cancels a request whose only pending work belongs to another request
 * as hung. An aborted waiter leaves the queue without compiling.
 */
async function acquireCompilerAdmission(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (
    waitingCompilerOperations.length === 0 &&
    activeCompilerOperations < CODEMODE_LIMITS.maxBridgeCompilations
  ) {
    activeCompilerOperations += 1;
    return;
  }
  if (waitingCompilerOperations.length >= CODEMODE_LIMITS.maxQueuedBridgeCompilations) {
    throw new CodemodeCompilerBusyError();
  }
  const ticket = Symbol("compiler admission");
  waitingCompilerOperations.push(ticket);
  try {
    while (
      waitingCompilerOperations[0] !== ticket ||
      activeCompilerOperations >= CODEMODE_LIMITS.maxBridgeCompilations
    ) {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, ADMISSION_POLL_MS);
      });
      signal.throwIfAborted();
    }
    activeCompilerOperations += 1;
  } finally {
    waitingCompilerOperations.splice(waitingCompilerOperations.indexOf(ticket), 1);
  }
}

/** Holds compiler admission until actual settlement, even if the caller disconnects or times out. */
export async function runWithCodemodeCompilerAdmission<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  await acquireCompilerAdmission(signal);
  try {
    return await operation();
  } finally {
    activeCompilerOperations -= 1;
  }
}
