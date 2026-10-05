import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

import { provisionGraftControlDatabase } from "@fragno-private/backoffice-node-runtime/graft-control-database";
import {
  createSqlitePragmaGraftDatabaseOperations,
  defineGraftDatabaseOperations,
} from "@fragno-private/backoffice-node-runtime/graft-database-operations";
import {
  createAuthorityBoundGraftNodeObjectRuntime,
  createAuthorityBoundGraftNodeObjectRuntimeWithDatabaseOperations,
} from "@fragno-private/backoffice-node-runtime/node-object-runtime";
import { createManualNodeRuntimeClock } from "@fragno-private/backoffice-node-runtime/node-runtime-clock";
import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";

import type { createGraftCounterObject } from "./graft-runtime.objects";

const command = process.argv[2];
const configPath = process.argv[3];
if (!command || !configPath) {
  throw new Error("GRAFT_RUNTIME_PROCESS_ARGUMENTS_MISSING");
}

if (command === "provision") {
  writeResult({ controlRemoteLogId: provisionGraftControlDatabase(configPath) });
} else {
  const controlRemoteLogId = process.argv[4];
  if (!controlRemoteLogId) {
    throw new Error("GRAFT_RUNTIME_PROCESS_CONTROL_LOG_MISSING");
  }
  const counter = defineNodeRuntimeObject<typeof createGraftCounterObject>(
    new URL("./graft-runtime.objects.ts", import.meta.url),
    "createGraftCounterObject",
  );
  const pushCounter = ["push-counts", "output-gate-push-counts"].includes(command)
    ? new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    : null;
  // Recovery reads run beyond the writer's lease, including writers poisoned before claim release.
  const clock = createManualNodeRuntimeClock(command === "read" ? 60_001 : 0);
  const options = {
    storage: { configPath, controlRemoteLogId },
    clock: clock.source,
    objects: { COUNTER: counter },
    objectProvisioning: { kind: "lazy" } as const,
    objectEviction: { kind: "disabled" } as const,
    nodeIdentity: {
      nodeId: randomUUID(),
      processGeneration: randomUUID(),
      privateAddress: "ws://127.0.0.1:1/node-object-peer",
      applicationOrigin: "http://127.0.0.1:1",
      compatibilityVersion: 1,
    },
    leasePolicy: {
      leaseDurationMs: 60_000,
      renewalIntervalMs: 10_000,
      renewalRetryIntervalMs: 1_000,
      selfFenceSafetyMarginMs: 5_000,
      maximumClockSkewMs: 0,
    },
    peerRpc: {
      authenticationSecret: "graft-runtime-process-authentication-secret",
      authenticationWindowMs: 5_000,
    },
  };
  const runtime = pushCounter
    ? createAuthorityBoundGraftNodeObjectRuntimeWithDatabaseOperations({
        ...options,
        databaseOperations: {
          control: createSqlitePragmaGraftDatabaseOperations(),
          provisioning: createSqlitePragmaGraftDatabaseOperations(),
          worker: defineGraftDatabaseOperations(
            new URL("./graft-database-operations.ts", import.meta.url),
            "createCountingGraftDatabaseOperations",
            { pushCounter: pushCounter.buffer },
          ),
        },
      })
    : createAuthorityBoundGraftNodeObjectRuntime(options);
  try {
    using object = runtime.objects.COUNTER.get("one");
    if (command === "write") {
      await object.writeCompatibilityValue("remote state");
      const count = await object.increment(3);
      writeResult({ count, state: await object.read() });
    } else if (command === "read") {
      writeResult({ state: await object.read() });
    } else if (command === "push-counts") {
      if (!pushCounter) {
        throw new Error("GRAFT_RUNTIME_PROCESS_PUSH_COUNTER_MISSING");
      }
      await object.read();
      Atomics.store(pushCounter, 0, 0);
      const singleRpcCount = await object.incrementMany([1, 1, 1]);
      const singleRpcPushes = Atomics.load(pushCounter, 0);

      Atomics.store(pushCounter, 0, 0);
      await object.increment(1);
      await object.increment(1);
      const multipleRpcCount = await object.increment(1);
      const multipleRpcPushes = Atomics.load(pushCounter, 0);
      writeResult({ singleRpcCount, singleRpcPushes, multipleRpcCount, multipleRpcPushes });
    } else if (command === "output-gate-push-counts") {
      if (!pushCounter) {
        throw new Error("GRAFT_RUNTIME_PROCESS_PUSH_COUNTER_MISSING");
      }
      await object.read();
      Atomics.store(pushCounter, 0, 0);
      let pushesBeforeOutput = -1;
      const scopedCount = await runtime.runWithOutputGate(async () => {
        using scopedObject = runtime.objects.COUNTER.get("one");
        await scopedObject.increment(1);
        await scopedObject.increment(1);
        const count = await scopedObject.increment(1);
        pushesBeforeOutput = Atomics.load(pushCounter, 0);
        return count;
      });
      const pushesAfterOutput = Atomics.load(pushCounter, 0);

      Atomics.store(pushCounter, 0, 0);
      const firstRequestCommitted = Promise.withResolvers<void>();
      const releaseFirstRequest = Promise.withResolvers<void>();
      const firstRequest = runtime.runWithOutputGate(async () => {
        using scopedObject = runtime.objects.COUNTER.get("one");
        const count = await scopedObject.increment(1);
        firstRequestCommitted.resolve();
        await releaseFirstRequest.promise;
        return count;
      });
      await firstRequestCommitted.promise;
      const secondRequestState = await runtime.runWithOutputGate(async () => {
        using scopedObject = runtime.objects.COUNTER.get("one");
        return await scopedObject.read();
      });
      const pushesAfterSecondRequest = Atomics.load(pushCounter, 0);
      releaseFirstRequest.resolve();
      const firstRequestCount = await firstRequest;
      const pushesAfterFirstRequest = Atomics.load(pushCounter, 0);

      writeResult({
        scopedCount,
        pushesBeforeOutput,
        pushesAfterOutput,
        secondRequestState,
        firstRequestCount,
        pushesAfterSecondRequest,
        pushesAfterFirstRequest,
      });
    } else if (command === "write-then-throw") {
      const error = await captureError(async () => {
        await runtime.runWithOutputGate(async () => {
          using scopedObject = runtime.objects.COUNTER.get("one");
          return scopedObject.incrementThenThrow(2);
        });
      });
      writeResult({ error });
    } else if (command === "write-failure") {
      const remoteDirectory = process.argv[5];
      if (!remoteDirectory) {
        throw new Error("GRAFT_RUNTIME_PROCESS_REMOTE_DIRECTORY_MISSING");
      }
      await object.increment(0);
      const unavailableDirectory = `${remoteDirectory}-unavailable`;
      let writeError: string | null = null;
      try {
        writeError = await captureError(async () => {
          await runtime.runWithOutputGate(async () => {
            using scopedObject = runtime.objects.COUNTER.get("one");
            using capability = await scopedObject.operationCapability();
            // Resolve ownership before the outage so this tests the object output gate, not routing.
            await rename(remoteDirectory, unavailableDirectory);
            await writeFile(remoteDirectory, "remote storage unavailable");
            await capability.increment(1);
          });
        });
      } finally {
        await rm(remoteDirectory, { force: true });
        await rename(unavailableDirectory, remoteDirectory);
      }
      using freshObject = runtime.objects.COUNTER.get("one");
      const readError = await captureError(() => freshObject.read());
      writeResult({ writeError, readError });
    } else {
      throw new Error(`GRAFT_RUNTIME_PROCESS_COMMAND_UNKNOWN:${command}`);
    }
  } finally {
    await runtime.cleanup();
  }
}

async function captureError(operation: () => unknown): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function writeResult(result: unknown): void {
  process.stdout.write(`GRAFT_RUNTIME_RESULT:${JSON.stringify(result)}\n`);
}
