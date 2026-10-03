import {
  GraftControlStore,
  type GraftNodeLease,
} from "@fragno-private/backoffice-node-runtime/graft-control-store";
import { defineGraftDatabaseOperations } from "@fragno-private/backoffice-node-runtime/graft-database-operations";
import { GraftObjectDirectory } from "@fragno-private/backoffice-node-runtime/graft-object-directory";
import { createAuthorityBoundGraftNodeObjectRuntimeWithDatabaseOperations } from "@fragno-private/backoffice-node-runtime/node-object-runtime";
import { createManualNodeRuntimeClock } from "@fragno-private/backoffice-node-runtime/node-runtime-clock";
import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";

import type { createGraftCounterObject } from "./graft-runtime.objects";

const processMode = process.argv[2];
const configPath = process.argv[3];
const controlRemoteLogId = process.argv[4];
if (!processMode || !configPath || !controlRemoteLogId) {
  throw new Error("GRAFT_AUTHORITY_RUNTIME_PROCESS_ARGUMENTS_MISSING");
}

if (processMode === "provision-object") {
  const directory = new GraftObjectDirectory({ configPath, controlRemoteLogId });
  try {
    writeResult({ remoteLogId: directory.resolveObjectRemoteLogId("COUNTER:one") });
  } finally {
    directory.close();
  }
} else if (processMode === "serve") {
  const serializedLease = process.argv[5];
  const serializedInitialTime = process.argv[6];
  if (!serializedLease || !serializedInitialTime) {
    throw new Error("GRAFT_AUTHORITY_RUNTIME_SERVE_ARGUMENTS_MISSING");
  }
  const nodeLease = JSON.parse(serializedLease) as GraftNodeLease;
  const initialTimeEpochMs = Number(serializedInitialTime);
  const clock = createManualNodeRuntimeClock(initialTimeEpochMs);
  const pushCounter = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const blockNextPush = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const blockedPush = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const releaseBlockedPush = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const runtime = createAuthorityBoundGraftNodeObjectRuntimeWithDatabaseOperations({
    storage: { configPath, controlRemoteLogId },
    clock: clock.source,
    nodeLease,
    objects: {
      COUNTER: defineNodeRuntimeObject<typeof createGraftCounterObject>(
        new URL("./graft-runtime.objects.ts", import.meta.url),
        "createGraftCounterObject",
      ),
    },
    databaseOperations: defineGraftDatabaseOperations(
      new URL("./graft-database-operations.ts", import.meta.url),
      "createBarrierGraftDatabaseOperations",
      { pushCounter, blockNextPush, blockedPush, releaseBlockedPush },
    ),
  });
  const object = runtime.objects.COUNTER.get("one");
  let closing = false;

  try {
    const state = await object.read();
    sendEvent("ready", {
      state,
      ownership: readObjectOwnership(configPath, controlRemoteLogId),
      pushCount: Atomics.load(new Int32Array(pushCounter), 0),
    });
  } catch (error) {
    sendEvent("startup-error", { error: errorMessage(error) });
    throw error;
  }

  process.on("message", (message: unknown) => {
    void handleProcessCommand(message);
  });

  async function handleProcessCommand(message: unknown): Promise<void> {
    if (closing) {
      return;
    }
    const command = parseProcessCommand(message);
    try {
      switch (command.operation) {
        case "block-next-push":
          Atomics.store(new Int32Array(blockNextPush), 0, 1);
          sendSuccess(command.requestId, null);
          return;
        case "increment": {
          if (Atomics.load(new Int32Array(blockNextPush), 0) === 1) {
            void waitForBlockedPush(new Int32Array(blockedPush)).then(() => {
              sendEvent("push-blocked", {
                pushCount: Atomics.load(new Int32Array(pushCounter), 0),
              });
            });
          }
          const value = await object.increment(command.delta);
          sendSuccess(command.requestId, value);
          return;
        }
        case "advance-time":
          clock.advanceBy(command.milliseconds);
          sendSuccess(command.requestId, clock.nowEpochMs());
          return;
        case "release-push":
          Atomics.store(new Int32Array(releaseBlockedPush), 0, 1);
          Atomics.notify(new Int32Array(releaseBlockedPush), 0);
          sendSuccess(command.requestId, null);
          return;
        case "read":
          sendSuccess(command.requestId, await object.read());
          return;
        case "ownership":
          sendSuccess(command.requestId, readObjectOwnership(configPath, controlRemoteLogId));
          return;
        case "cleanup":
          closing = true;
          object[Symbol.dispose]();
          await runtime.cleanup();
          sendSuccess(command.requestId, null);
          setImmediate(() => process.exit(0));
          return;
      }
    } catch (error) {
      sendFailure(command.requestId, errorMessage(error));
    }
  }
} else {
  throw new Error(`GRAFT_AUTHORITY_RUNTIME_PROCESS_MODE_UNKNOWN:${processMode}`);
}

type AuthorityRuntimeProcessCommand =
  | { requestId: number; operation: "block-next-push" }
  | { requestId: number; operation: "increment"; delta: number }
  | { requestId: number; operation: "advance-time"; milliseconds: number }
  | { requestId: number; operation: "release-push" }
  | { requestId: number; operation: "read" }
  | { requestId: number; operation: "ownership" }
  | { requestId: number; operation: "cleanup" };

function parseProcessCommand(message: unknown): AuthorityRuntimeProcessCommand {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    throw new Error("GRAFT_AUTHORITY_RUNTIME_COMMAND_INVALID");
  }
  return message as AuthorityRuntimeProcessCommand;
}

function readObjectOwnership(config: string, controlLogId: string): unknown {
  const store = new GraftControlStore({ configPath: config, controlRemoteLogId: controlLogId });
  try {
    return store.readObjectOwnership("COUNTER:one");
  } finally {
    store.close();
  }
}

async function waitForBlockedPush(blockedPush: Int32Array): Promise<void> {
  while (Atomics.load(blockedPush, 0) !== 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function sendSuccess(requestId: number, value: unknown): void {
  process.send?.({ kind: "response", requestId, outcome: "success", value });
}

function sendFailure(requestId: number, error: string): void {
  process.send?.({ kind: "response", requestId, outcome: "failure", error });
}

function sendEvent(event: string, value: unknown): void {
  process.send?.({ kind: "event", event, value });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeResult(result: unknown): void {
  process.stdout.write(`GRAFT_AUTHORITY_RUNTIME_RESULT:${JSON.stringify(result)}\n`);
}
