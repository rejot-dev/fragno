import { rename, rm, writeFile } from "node:fs/promises";

import { defineGraftDatabaseOperations } from "@fragno-private/backoffice-node-runtime/graft-database-operations";
import { provisionGraftControlDatabase } from "@fragno-private/backoffice-node-runtime/graft-object-directory";
import {
  createGraftNodeObjectRuntime,
  createGraftNodeObjectRuntimeWithDatabaseOperations,
} from "@fragno-private/backoffice-node-runtime/node-object-runtime";
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
  const runtime = pushCounter
    ? createGraftNodeObjectRuntimeWithDatabaseOperations({
        storage: { configPath, controlRemoteLogId },
        clock: { kind: "system" },
        objects: { COUNTER: counter },
        databaseOperations: defineGraftDatabaseOperations(
          new URL("./graft-database-operations.ts", import.meta.url),
          "createCountingGraftDatabaseOperations",
          { pushCounter: pushCounter.buffer },
        ),
      })
    : createGraftNodeObjectRuntime({
        storage: { configPath, controlRemoteLogId },
        clock: { kind: "system" },
        objects: { COUNTER: counter },
      });
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
      await rename(remoteDirectory, unavailableDirectory);
      await writeFile(remoteDirectory, "remote storage unavailable");
      try {
        const writeError = await captureError(async () => {
          await runtime.runWithOutputGate(async () => {
            using scopedObject = runtime.objects.COUNTER.get("one");
            using capability = await scopedObject.operationCapability();
            await capability.increment(1);
          });
        });
        const readError = await captureError(() => object.read());
        writeResult({ writeError, readError });
      } finally {
        await rm(remoteDirectory, { force: true });
        await rename(unavailableDirectory, remoteDirectory);
      }
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
