import { parentPort, workerData } from "node:worker_threads";

import type { GraftNodeRuntimeStorage } from "../graft/graft-runtime-storage";
import { GraftWorkerDirectory } from "../graft/graft-worker-directory";

const port = parentPort;
if (port === null) {
  throw new Error("GRAFT_GATEWAY_DIRECTORY_WORKER_PORT_MISSING");
}
const storage = workerData as GraftNodeRuntimeStorage;
const directory = new GraftWorkerDirectory(storage);

function publishGatewayWorkerSnapshot(): void {
  try {
    const workers = directory.readLiveWorkers(Date.now() + 1_000);
    port!.postMessage({ kind: "snapshot", refreshedAtMs: Date.now(), workers });
  } catch (error) {
    port!.postMessage({
      kind: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
publishGatewayWorkerSnapshot();
setInterval(publishGatewayWorkerSnapshot, 1_000);
