import { provisionGraftControlDatabase } from "@fragno-private/backoffice-node-runtime/graft-control-database";
import type {
  GraftClaimObjectInput,
  GraftControlCommand,
  GraftMarkObjectReadyInput,
  GraftRegisterNodeInput,
  GraftRegisterObjectDatabaseInput,
  GraftReleaseObjectInput,
  GraftRenewNodeLeaseInput,
} from "@fragno-private/backoffice-node-runtime/graft-control-store";
import { GraftControlStore } from "@fragno-private/backoffice-node-runtime/graft-control-store";
import {
  createSqlitePragmaGraftDatabaseOperations,
  type GraftDatabaseOperations,
} from "@fragno-private/backoffice-node-runtime/graft-database-operations";

import { createControlledGraftDatabaseOperations } from "./graft-database-operations.ts";

const processCommand = process.argv[2];
const configPath = process.argv[3];
if (!processCommand || !configPath) {
  throw new Error("GRAFT_CONTROL_STORE_PROCESS_ARGUMENTS_MISSING");
}

if (processCommand === "provision") {
  writeResult({ controlRemoteLogId: provisionGraftControlDatabase(configPath) });
} else if (processCommand === "execute") {
  const controlRemoteLogId = process.argv[4];
  const serializedInvocation = process.argv[5];
  if (!controlRemoteLogId || !serializedInvocation) {
    throw new Error("GRAFT_CONTROL_STORE_PROCESS_EXECUTION_ARGUMENTS_MISSING");
  }
  const invocation = parseInvocation(serializedInvocation);
  const store = new GraftControlStore(
    { configPath, controlRemoteLogId },
    createProcessDatabaseOperations(invocation.pushBehavior),
  );
  try {
    writeResult(executeInvocation(store, invocation));
  } finally {
    store.close();
  }
} else {
  throw new Error(`GRAFT_CONTROL_STORE_PROCESS_COMMAND_UNKNOWN:${processCommand}`);
}

type ControlStoreProcessInvocation =
  | {
      operation: "register-node";
      pushBehavior: ProcessPushBehavior;
      command: GraftControlCommand<GraftRegisterNodeInput>;
    }
  | {
      operation: "renew-node-lease";
      pushBehavior: ProcessPushBehavior;
      command: GraftControlCommand<GraftRenewNodeLeaseInput>;
    }
  | {
      operation: "register-object-database";
      pushBehavior: ProcessPushBehavior;
      command: GraftControlCommand<GraftRegisterObjectDatabaseInput>;
    }
  | {
      operation: "claim-object";
      pushBehavior: ProcessPushBehavior;
      command: GraftControlCommand<GraftClaimObjectInput>;
    }
  | {
      operation: "mark-object-ready";
      pushBehavior: ProcessPushBehavior;
      command: GraftControlCommand<GraftMarkObjectReadyInput>;
    }
  | {
      operation: "release-object";
      pushBehavior: ProcessPushBehavior;
      command: GraftControlCommand<GraftReleaseObjectInput>;
    }
  | {
      operation: "read-object-ownership";
      pushBehavior: "normal";
      objectId: string;
    }
  | {
      operation: "read-node-lease";
      pushBehavior: "normal";
      nodeId: string;
    };

type ProcessPushBehavior = "normal" | "fail-before-remote-commit" | "lose-response-after-commit";

function executeInvocation(
  store: GraftControlStore,
  invocation: ControlStoreProcessInvocation,
): unknown {
  switch (invocation.operation) {
    case "register-node":
      return store.registerNode(invocation.command);
    case "renew-node-lease":
      return store.renewNodeLease(invocation.command);
    case "register-object-database":
      return store.registerObjectDatabase(invocation.command);
    case "claim-object":
      return store.claimObject(invocation.command);
    case "mark-object-ready":
      return store.markObjectReady(invocation.command);
    case "release-object":
      return store.releaseObject(invocation.command);
    case "read-object-ownership":
      return store.readObjectOwnership(invocation.objectId);
    case "read-node-lease":
      return store.readNodeLease(invocation.nodeId);
  }
  throw new Error("GRAFT_CONTROL_STORE_PROCESS_OPERATION_UNREACHABLE");
}

function createProcessDatabaseOperations(
  pushBehavior: ProcessPushBehavior,
): GraftDatabaseOperations {
  if (pushBehavior === "normal") {
    return createSqlitePragmaGraftDatabaseOperations();
  }
  const pushCounter = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const nextPushBehavior = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  Atomics.store(
    new Int32Array(nextPushBehavior),
    0,
    pushBehavior === "fail-before-remote-commit" ? 1 : 2,
  );
  return createControlledGraftDatabaseOperations({ pushCounter, nextPushBehavior });
}

function parseInvocation(serialized: string): ControlStoreProcessInvocation {
  const value = JSON.parse(serialized) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GRAFT_CONTROL_STORE_PROCESS_INVOCATION_INVALID");
  }
  return value as ControlStoreProcessInvocation;
}

function writeResult(result: unknown): void {
  process.stdout.write(`GRAFT_CONTROL_STORE_RESULT:${JSON.stringify(result)}\n`);
}
