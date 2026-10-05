import {
  createSqlitePragmaGraftDatabaseOperations,
  type GraftDatabaseOperations,
} from "@fragno-private/backoffice-node-runtime/graft-database-operations";

/** Records object-worker push attempts while delegating every operation to the real Graft pragmas. */
export function createCountingGraftDatabaseOperations(input: unknown): GraftDatabaseOperations {
  if (
    typeof input !== "object" ||
    input === null ||
    !("pushCounter" in input) ||
    !(input.pushCounter instanceof SharedArrayBuffer) ||
    input.pushCounter.byteLength < Int32Array.BYTES_PER_ELEMENT
  ) {
    throw new Error("COUNTING_GRAFT_DATABASE_OPERATIONS_INPUT_INVALID");
  }
  const pushCounter = new Int32Array(input.pushCounter);
  const operations = createSqlitePragmaGraftDatabaseOperations();
  return {
    clone(database, remoteLogId) {
      operations.clone(database, remoteLogId);
    },
    pull(database) {
      operations.pull(database);
    },
    push(database) {
      Atomics.add(pushCounter, 0, 1);
      operations.push(database);
    },
    readRemoteLogId(database) {
      return operations.readRemoteLogId(database);
    },
  };
}

/** Blocks one selected worker push until a scenario releases its shared atomic barrier. */
export function createBarrierGraftDatabaseOperations(input: unknown): GraftDatabaseOperations {
  if (
    typeof input !== "object" ||
    input === null ||
    !("pushCounter" in input) ||
    !(input.pushCounter instanceof SharedArrayBuffer) ||
    !("blockNextPush" in input) ||
    !(input.blockNextPush instanceof SharedArrayBuffer) ||
    !("blockedPush" in input) ||
    !(input.blockedPush instanceof SharedArrayBuffer) ||
    !("releaseBlockedPush" in input) ||
    !(input.releaseBlockedPush instanceof SharedArrayBuffer)
  ) {
    throw new Error("BARRIER_GRAFT_DATABASE_OPERATIONS_INPUT_INVALID");
  }
  const pushCounter = requireAtomicInt32(input.pushCounter, "pushCounter");
  const blockNextPush = requireAtomicInt32(input.blockNextPush, "blockNextPush");
  const blockedPush = requireAtomicInt32(input.blockedPush, "blockedPush");
  const releaseBlockedPush = requireAtomicInt32(input.releaseBlockedPush, "releaseBlockedPush");
  const operations = createSqlitePragmaGraftDatabaseOperations();
  return {
    clone(database, remoteLogId) {
      operations.clone(database, remoteLogId);
    },
    pull(database) {
      operations.pull(database);
    },
    push(database) {
      Atomics.add(pushCounter, 0, 1);
      const blockPhase = Atomics.exchange(blockNextPush, 0, 0);
      if (blockPhase === 1) {
        waitAtGraftPushBarrier(blockedPush, releaseBlockedPush);
      }
      operations.push(database);
      if (blockPhase === 2) {
        waitAtGraftPushBarrier(blockedPush, releaseBlockedPush);
      }
    },
    readRemoteLogId(database) {
      return operations.readRemoteLogId(database);
    },
  };
}

/** Records pushes and injects one controlled failure before or after the real Graft push. */
export function createControlledGraftDatabaseOperations(input: unknown): GraftDatabaseOperations {
  if (
    typeof input !== "object" ||
    input === null ||
    !("pushCounter" in input) ||
    !(input.pushCounter instanceof SharedArrayBuffer) ||
    input.pushCounter.byteLength < Int32Array.BYTES_PER_ELEMENT ||
    !("nextPushBehavior" in input) ||
    !(input.nextPushBehavior instanceof SharedArrayBuffer) ||
    input.nextPushBehavior.byteLength < Int32Array.BYTES_PER_ELEMENT
  ) {
    throw new Error("CONTROLLED_GRAFT_DATABASE_OPERATIONS_INPUT_INVALID");
  }
  const pushCounter = new Int32Array(input.pushCounter);
  const nextPushBehavior = new Int32Array(input.nextPushBehavior);
  const operations = createSqlitePragmaGraftDatabaseOperations();
  return {
    clone(database, remoteLogId) {
      operations.clone(database, remoteLogId);
    },
    pull(database) {
      operations.pull(database);
    },
    push(database) {
      Atomics.add(pushCounter, 0, 1);
      const behavior = Atomics.exchange(nextPushBehavior, 0, 0);
      if (behavior === 1) {
        throw new Error("EXPECTED_GRAFT_PUSH_FAILURE_BEFORE_REMOTE_COMMIT");
      }
      operations.push(database);
      if (behavior === 2) {
        throw new Error("EXPECTED_GRAFT_PUSH_RESPONSE_LOST_AFTER_REMOTE_COMMIT");
      }
    },
    readRemoteLogId(database) {
      return operations.readRemoteLogId(database);
    },
  };
}

function waitAtGraftPushBarrier(blockedPush: Int32Array, releaseBlockedPush: Int32Array): void {
  Atomics.store(blockedPush, 0, 1);
  Atomics.notify(blockedPush, 0);
  while (Atomics.load(releaseBlockedPush, 0) === 0) {
    Atomics.wait(releaseBlockedPush, 0, 0);
  }
  Atomics.store(releaseBlockedPush, 0, 0);
  Atomics.store(blockedPush, 0, 0);
}

function requireAtomicInt32(buffer: SharedArrayBuffer, name: string): Int32Array {
  if (buffer.byteLength < Int32Array.BYTES_PER_ELEMENT) {
    throw new Error(`GRAFT_DATABASE_OPERATIONS_ATOMIC_BUFFER_INVALID:${name}`);
  }
  return new Int32Array(buffer);
}
