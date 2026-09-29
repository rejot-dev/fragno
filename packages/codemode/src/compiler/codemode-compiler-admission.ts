import { CODEMODE_LIMITS } from "../codemode-limits";

// Shared by WebSocket activations and private compiler RPC calls in the same Worker isolate.
let activeCompilerOperations = 0;

/** Holds compiler admission until actual settlement, even if the caller disconnects or times out. */
export async function runWithCodemodeCompilerAdmission<T>(operation: () => Promise<T>): Promise<T> {
  if (activeCompilerOperations >= CODEMODE_LIMITS.maxBridgeCompilations) {
    throw new Error("CODEMODE_COMPILATION_LIMIT_EXCEEDED");
  }
  activeCompilerOperations += 1;
  try {
    return await operation();
  } finally {
    activeCompilerOperations -= 1;
  }
}
