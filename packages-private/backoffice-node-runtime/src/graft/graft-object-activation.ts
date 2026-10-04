import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  readNodeRuntimeEpochMilliseconds,
  readNodeRuntimeMonotonicMilliseconds,
  type NodeRuntimeClock,
} from "../runtime/node-runtime-clock";
import {
  GraftControlStore,
  type GraftNodeLease,
  type GraftObjectOwnership,
} from "./graft-control-store";
import type { GraftDatabaseOperations } from "./graft-database-operations";
import type { GraftNodeAuthorityWindow } from "./graft-node-authority";
import {
  graftObjectAuthorityEpochPrecedes,
  readGraftObjectAuthority,
  sameGraftObjectAuthority,
  writeGraftObjectAuthority,
  type GraftObjectActivationAuthority,
  type GraftObjectAuthority,
} from "./graft-object-authority";
import type { GraftNodeRuntimeStorage } from "./graft-runtime-storage";
import { openClonedGraftDatabase } from "./graft-sqlite";

const DEFAULT_GRAFT_OBJECT_FENCE_ATTEMPTS = 4;

/** Holds a fenced object clone until worker initialization can publish the claim as ready. */
export type PreparedGraftObjectActivation = {
  database: DatabaseSync;
  authority: GraftObjectActivationAuthority;
  markReady(): void;
  abort(): void;
};

/** Claims, fences, and returns an object clone that is not externally ready until markReady. */
export function prepareGraftObjectActivation(options: {
  storage: GraftNodeRuntimeStorage;
  objectId: string;
  remoteLogId: string;
  nodeAuthority: GraftNodeAuthorityWindow;
  maximumClockSkewMs: number;
  clock: NodeRuntimeClock;
  objectOperations: GraftDatabaseOperations;
  maxFenceAttempts: number;
}): PreparedGraftObjectActivation {
  validateFenceAttemptCount(options.maxFenceAttempts);
  const controlStore = new GraftControlStore(options.storage);
  let database: DatabaseSync | null = null;
  let completed = false;
  try {
    const assertLocalAuthority = () => {
      if (
        readNodeRuntimeMonotonicMilliseconds(options.clock) >=
        options.nodeAuthority.selfFenceAtMonotonicMs
      ) {
        throw new Error("NODE_RUNTIME_OBJECT_AUTHORITY_EXPIRED");
      }
    };
    assertLocalAuthority();
    const nowEpochMs = readNodeRuntimeEpochMilliseconds(options.clock);
    const confirmedLease = requireConfirmedNodeLease(
      controlStore,
      options.nodeAuthority,
      nowEpochMs,
    );
    const observedOwnership = controlStore.readObjectOwnership(options.objectId);
    if (!observedOwnership || observedOwnership.remoteLogId !== options.remoteLogId) {
      throw new Error(`GRAFT_OBJECT_ACTIVATION_DIRECTORY_MISMATCH:${options.objectId}`);
    }
    const claimId = randomUUID();
    const claim = controlStore.claimObject({
      commandId: randomUUID(),
      commandCreatedAtMs: nowEpochMs,
      input: {
        objectId: options.objectId,
        observedEpoch: observedOwnership.epoch,
        nodeId: confirmedLease.nodeId,
        processGeneration: confirmedLease.processGeneration,
        claimId,
        attemptedAtMs: nowEpochMs,
        ownerLeaseExpiryCutoffMs: Math.max(0, nowEpochMs - options.maximumClockSkewMs),
      },
    });
    if (claim.outcome !== "claimed") {
      throw new Error(`GRAFT_OBJECT_ACTIVATION_CLAIM_REJECTED:${claim.outcome}`);
    }
    const authority: GraftObjectActivationAuthority = {
      objectId: options.objectId,
      epoch: claim.ownership.epoch,
      ownerNodeId: confirmedLease.nodeId,
      processGeneration: confirmedLease.processGeneration,
      claimId,
      nodeAuthority: options.nodeAuthority,
    };
    const assertControlAuthority = () => {
      assertLocalAuthority();
      const currentTime = readNodeRuntimeEpochMilliseconds(options.clock);
      requireConfirmedNodeLease(controlStore, options.nodeAuthority, currentTime);
      requireRestoringControlOwnership(controlStore, authority);
    };
    database = fenceGraftObjectDatabase({
      objectId: options.objectId,
      remoteLogId: options.remoteLogId,
      authority,
      operations: options.objectOperations,
      maxAttempts: options.maxFenceAttempts,
      assertControlAuthority,
    });
    assertControlAuthority();

    return {
      database,
      authority,
      markReady() {
        if (completed) {
          throw new Error("GRAFT_OBJECT_ACTIVATION_ALREADY_COMPLETED");
        }
        assertControlAuthority();
        const readyAtMs = readNodeRuntimeEpochMilliseconds(options.clock);
        const result = controlStore.markObjectReady({
          commandId: randomUUID(),
          commandCreatedAtMs: readyAtMs,
          input: {
            objectId: authority.objectId,
            epoch: authority.epoch,
            nodeId: authority.ownerNodeId,
            processGeneration: authority.processGeneration,
            claimId: authority.claimId,
            attemptedAtMs: readyAtMs,
          },
        });
        if (result.outcome !== "ready" || !matchesControlOwnership(result.ownership, authority)) {
          throw new Error(`GRAFT_OBJECT_ACTIVATION_READY_REJECTED:${result.outcome}`);
        }
        assertLocalAuthority();
        completed = true;
        controlStore.close();
      },
      abort() {
        if (completed) {
          return;
        }
        completed = true;
        controlStore.close();
      },
    };
  } catch (error) {
    database?.close();
    controlStore.close();
    throw error;
  }
}

function fenceGraftObjectDatabase(options: {
  objectId: string;
  remoteLogId: string;
  authority: GraftObjectAuthority;
  operations: GraftDatabaseOperations;
  maxAttempts: number;
  assertControlAuthority(): void;
}): DatabaseSync {
  let lastPushFailure: unknown = null;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const database = openClonedGraftDatabase(
      `object-fence-${randomUUID()}`,
      options.remoteLogId,
      options.operations,
    );
    let retainDatabase = false;
    try {
      assertGraftObjectIdentity(database, options.objectId);
      const existing = readGraftObjectAuthority(database);
      if (!existing) {
        throw new Error(`GRAFT_OBJECT_AUTHORITY_MISSING:${options.objectId}`);
      }
      if (sameGraftObjectAuthority(existing, options.authority)) {
        retainDatabase = true;
        return database;
      }
      if (!graftObjectAuthorityEpochPrecedes(existing.epoch, options.authority.epoch)) {
        throw new Error(`GRAFT_OBJECT_AUTHORITY_FENCED:${options.objectId}:${existing.epoch}`);
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        writeGraftObjectAuthority(database, options.authority);
        database.exec("COMMIT");
      } catch (error) {
        if (database.isTransaction) {
          database.exec("ROLLBACK");
        }
        throw error;
      }
      try {
        options.operations.push(database);
        retainDatabase = true;
        return database;
      } catch (cause) {
        lastPushFailure = cause;
      }
    } finally {
      if (!retainDatabase) {
        database.close();
      }
    }
    options.assertControlAuthority();
  }
  throw new Error("GRAFT_OBJECT_FENCE_DURABILITY_UNCERTAIN", { cause: lastPushFailure });
}

function requireConfirmedNodeLease(
  controlStore: GraftControlStore,
  expected: GraftNodeAuthorityWindow,
  nowEpochMs: number,
): GraftNodeLease {
  const actual = controlStore.readNodeLease(expected.nodeId);
  if (!actual) {
    throw new Error(`GRAFT_OBJECT_ACTIVATION_NODE_MISSING:${expected.nodeId}`);
  }
  if (actual.processGeneration !== expected.processGeneration) {
    throw new Error(`GRAFT_OBJECT_ACTIVATION_NODE_GENERATION_MISMATCH:${expected.nodeId}`);
  }
  if (actual.expiresAtMs <= nowEpochMs || actual.expiresAtMs < expected.leaseExpiresAtEpochMs) {
    throw new Error(`GRAFT_OBJECT_ACTIVATION_NODE_LEASE_EXPIRED:${expected.nodeId}`);
  }
  return actual;
}

function requireRestoringControlOwnership(
  controlStore: GraftControlStore,
  authority: GraftObjectAuthority,
): void {
  const ownership = controlStore.readObjectOwnership(authority.objectId);
  if (ownership?.state !== "restoring" || !matchesControlOwnership(ownership, authority)) {
    throw new Error(`GRAFT_OBJECT_ACTIVATION_CONTROL_AUTHORITY_LOST:${authority.objectId}`);
  }
}

function matchesControlOwnership(
  ownership: Exclude<GraftObjectOwnership, { state: "unowned" }>,
  authority: GraftObjectAuthority,
): boolean {
  return (
    ownership.objectId === authority.objectId &&
    ownership.epoch === authority.epoch &&
    ownership.ownerNodeId === authority.ownerNodeId &&
    ownership.claimId === authority.claimId
  );
}

function assertGraftObjectIdentity(database: DatabaseSync, objectId: string): void {
  const identity = database
    .prepare("SELECT object_id FROM node_runtime_object_identity WHERE singleton = 1")
    .get() as { object_id: string } | undefined;
  if (identity?.object_id !== objectId) {
    throw new Error(`GRAFT_OBJECT_IDENTITY_MISMATCH:${objectId}`);
  }
}

function validateFenceAttemptCount(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("GRAFT_OBJECT_FENCE_ATTEMPTS_INVALID");
  }
}

/** Default bounded retry count for object-log fencing after a competing append. */
export const DEFAULT_GRAFT_OBJECT_ACTIVATION_FENCE_ATTEMPTS = DEFAULT_GRAFT_OBJECT_FENCE_ATTEMPTS;
