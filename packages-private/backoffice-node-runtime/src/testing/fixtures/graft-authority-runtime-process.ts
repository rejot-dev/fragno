import {
  GraftControlStore,
  type GraftNodeLease,
} from "@fragno-private/backoffice-node-runtime/graft-control-store";
import {
  createSqlitePragmaGraftDatabaseOperations,
  defineGraftDatabaseOperations,
} from "@fragno-private/backoffice-node-runtime/graft-database-operations";
import { provisionGraftObject } from "@fragno-private/backoffice-node-runtime/graft-object-provisioning";
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
  const storage = { configPath, controlRemoteLogId };
  const controlStore = new GraftControlStore(storage);
  try {
    writeResult(
      provisionGraftObject({
        objectId: "COUNTER:one",
        storage,
        controlStore,
        clock: { kind: "system" },
        databaseOperations: createSqlitePragmaGraftDatabaseOperations(),
      }),
    );
  } finally {
    controlStore.close();
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
    nodeIdentity: {
      nodeId: nodeLease.nodeId,
      processGeneration: nodeLease.processGeneration,
      privateAddress: nodeLease.privateAddress,
      applicationOrigin: nodeLease.applicationOrigin,
      compatibilityVersion: nodeLease.compatibilityVersion,
    },
    leasePolicy: {
      leaseDurationMs: nodeLease.expiresAtMs - initialTimeEpochMs,
      renewalIntervalMs: 100,
      renewalRetryIntervalMs: 10,
      selfFenceSafetyMarginMs: 0,
      maximumClockSkewMs: 0,
    },
    peerRpc: {
      authenticationSecret: "graft-authority-runtime-test-secret",
      authenticationWindowMs: 1_000,
    },
    objectProvisioning: { kind: "lazy" },
    objectEviction: { kind: "disabled" },
    objects: {
      COUNTER: defineNodeRuntimeObject<typeof createGraftCounterObject>(
        new URL("./graft-runtime.objects.ts", import.meta.url),
        "createGraftCounterObject",
      ),
    },
    databaseOperations: {
      control: createSqlitePragmaGraftDatabaseOperations(),
      provisioning: createSqlitePragmaGraftDatabaseOperations(),
      worker: defineGraftDatabaseOperations(
        new URL("./graft-database-operations.ts", import.meta.url),
        "createBarrierGraftDatabaseOperations",
        { pushCounter, blockNextPush, blockedPush, releaseBlockedPush },
      ),
    },
  });
  const object = runtime.objects.COUNTER.get("one");
  const capability = await object.operationCapability();
  let closing = false;

  function armPushBarrier(phase: 1 | 2): void {
    Atomics.store(new Int32Array(blockNextPush), 0, phase);
    void waitForBlockedPush(new Int32Array(blockedPush)).then(() => {
      sendEvent("push-blocked", {
        pushCount: Atomics.load(new Int32Array(pushCounter), 0),
      });
    });
  }

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
          armPushBarrier(1);
          sendSuccess(command.requestId, null);
          return;
        case "block-next-push-after-commit":
          armPushBarrier(2);
          sendSuccess(command.requestId, null);
          return;
        case "increment": {
          const value = await object.increment(command.delta);
          sendSuccess(command.requestId, value);
          return;
        }
        case "increment-object": {
          using namedObject = runtime.objects.COUNTER.get(command.name);
          sendSuccess(command.requestId, await namedObject.increment(command.delta));
          return;
        }
        case "advance-time":
          clock.advanceBy(command.milliseconds);
          sendSuccess(command.requestId, clock.nowEpochMs());
          return;
        case "advance-monotonic-time":
          clock.advanceMonotonicBy(command.milliseconds);
          sendSuccess(command.requestId, clock.nowMonotonicMs());
          return;
        case "set-wall-time":
          clock.setEpochMilliseconds(command.epochMilliseconds);
          sendSuccess(command.requestId, clock.nowEpochMs());
          return;
        case "tick-runtime":
          await runtime.tick();
          sendSuccess(command.requestId, runtime.readNodeAuthorityStatus());
          return;
        case "authority-status":
          sendSuccess(command.requestId, runtime.readNodeAuthorityStatus());
          return;
        case "in-memory":
          sendSuccess(command.requestId, await object.inMemoryValue());
          return;
        case "capability-increment":
          sendSuccess(command.requestId, await capability.increment(command.delta));
          return;
        case "fresh-read": {
          using fresh = runtime.objects.COUNTER.get("one");
          sendSuccess(command.requestId, await fresh.read());
          return;
        }
        case "expire-empty-output":
          sendSuccess(
            command.requestId,
            await runtime.runWithOutputGate(() => {
              clock.advanceMonotonicBy(command.milliseconds);
              return "must-not-escape";
            }),
          );
          return;
        case "release-push":
          Atomics.store(new Int32Array(releaseBlockedPush), 0, 1);
          Atomics.notify(new Int32Array(releaseBlockedPush), 0);
          sendSuccess(command.requestId, null);
          return;
        case "schedule-alarm":
          await object.scheduleAlarm(command.timestamp);
          sendSuccess(command.requestId, await object.readAlarmState());
          return;
        case "cancel-alarm":
          await object.cancelAlarm();
          sendSuccess(command.requestId, await object.readAlarmState());
          return;
        case "rearm-on-next-alarm":
          await object.rearmOnNextAlarm(command.timestamp);
          sendSuccess(command.requestId, null);
          return;
        case "fail-next-alarm":
          await object.failNextAlarm();
          sendSuccess(command.requestId, null);
          return;
        case "alarm-state":
          sendSuccess(command.requestId, await object.readAlarmState());
          return;
        case "read":
          sendSuccess(command.requestId, await object.read());
          return;
        case "ownership":
          sendSuccess(command.requestId, readObjectOwnership(configPath, controlRemoteLogId));
          return;
        case "cleanup":
          closing = true;
          capability[Symbol.dispose]();
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
  | { requestId: number; operation: "block-next-push-after-commit" }
  | { requestId: number; operation: "increment"; delta: number }
  | { requestId: number; operation: "increment-object"; name: string; delta: number }
  | { requestId: number; operation: "advance-time"; milliseconds: number }
  | { requestId: number; operation: "advance-monotonic-time"; milliseconds: number }
  | { requestId: number; operation: "set-wall-time"; epochMilliseconds: number }
  | { requestId: number; operation: "tick-runtime" }
  | { requestId: number; operation: "authority-status" }
  | { requestId: number; operation: "in-memory" }
  | { requestId: number; operation: "capability-increment"; delta: number }
  | { requestId: number; operation: "fresh-read" }
  | { requestId: number; operation: "expire-empty-output"; milliseconds: number }
  | { requestId: number; operation: "release-push" }
  | { requestId: number; operation: "schedule-alarm"; timestamp: number }
  | { requestId: number; operation: "cancel-alarm" }
  | { requestId: number; operation: "rearm-on-next-alarm"; timestamp: number }
  | { requestId: number; operation: "fail-next-alarm" }
  | { requestId: number; operation: "alarm-state" }
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
