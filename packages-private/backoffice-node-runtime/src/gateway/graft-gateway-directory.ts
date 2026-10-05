import { Worker } from "node:worker_threads";

import type { GraftNodeLease } from "../graft/graft-control-store";
import type { GraftNodeRuntimeStorage } from "../graft/graft-runtime-storage";
import { initializeGraftSqlite } from "../graft/graft-sqlite";
import type { NodeRuntimeGatewayDirectory } from "./node-runtime-gateway";

/** Isolates blocking native Graft refreshes from HTTP streaming; stale or failed discovery fails closed. */
export function startGraftGatewayDirectory(
  storage: GraftNodeRuntimeStorage,
): NodeRuntimeGatewayDirectory {
  // Worker process.env cannot change libc getenv; register the process-wide VFS on the main thread.
  initializeGraftSqlite(storage.configPath);
  const worker = new Worker(new URL("./graft-gateway-directory-worker.js", import.meta.url), {
    workerData: storage,
  });
  let snapshot: { refreshedAtMs: number; workers: GraftNodeLease[] } | null = null;
  let closed = false;
  let closeOperation: Promise<void> | null = null;
  worker.on(
    "message",
    (
      message:
        | { kind: "snapshot"; refreshedAtMs: number; workers: GraftNodeLease[] }
        | { kind: "unavailable"; error: string },
    ) => {
      if (closed) {
        return;
      }
      if (message.kind === "snapshot") {
        snapshot = message;
      } else {
        snapshot = null;
        console.error("GRAFT_GATEWAY_DISCOVERY_FAILED", message.error);
      }
    },
  );
  worker.on("error", (error) => {
    snapshot = null;
    console.error("GRAFT_GATEWAY_DISCOVERY_WORKER_FAILED", error);
  });
  worker.on("exit", () => {
    snapshot = null;
  });
  return {
    readLiveWorkers(): GraftNodeLease[] {
      return snapshot !== null && Date.now() - snapshot.refreshedAtMs < 5_000
        ? snapshot.workers
        : [];
    },
    close(): Promise<void> {
      closed = true;
      snapshot = null;
      closeOperation ??= worker.terminate().then(() => undefined);
      return closeOperation;
    },
  };
}
