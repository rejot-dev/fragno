import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { GraftControlReadReplica } from "./graft-control-read-replica";
import { requireGraftControlFormat } from "./graft-control-schema";
import { runWithGraftControlStoreLock } from "./graft-control-store-lock";
import {
  createSqlitePragmaGraftDatabaseOperations,
  type GraftDatabaseOperations,
} from "./graft-database-operations";
import type { GraftNodeRuntimeStorage } from "./graft-runtime-storage";
import { initializeGraftSqlite, openClonedGraftDatabase } from "./graft-sqlite";

const MAX_OBJECT_EPOCH = 9_223_372_036_854_775_807n;
const DEFAULT_CONTROL_COMMAND_ATTEMPTS = 4;

/** Identifies one idempotent control command and when its durable receipt was created. */
export type GraftControlCommand<TInput> = {
  commandId: string;
  commandCreatedAtMs: number;
  input: TInput;
};

/** Describes one process incarnation's renewable authority record. */
export type GraftNodeLease = {
  nodeId: string;
  processGeneration: string;
  privateAddress: string;
  applicationOrigin: string;
  compatibilityVersion: number;
  expiresAtMs: number;
  renewalId: string;
};

/** Identifies the canonical durable log selected for one object identity. */
export type GraftObjectLocation = {
  objectId: string;
  remoteLogId: string;
};

/** Describes the durable owner and fencing epoch for one object database. */
export type GraftObjectOwnership =
  | {
      state: "unowned";
      objectId: string;
      remoteLogId: string;
      epoch: string;
    }
  | {
      state: "restoring";
      objectId: string;
      remoteLogId: string;
      epoch: string;
      ownerNodeId: string;
      claimId: string;
    }
  | {
      state: "ready";
      objectId: string;
      remoteLogId: string;
      epoch: string;
      ownerNodeId: string;
      claimId: string;
    };

/** Resolves ownership and its current node lease from one authoritative control snapshot. */
export type GraftObjectRoutingState =
  | {
      kind: "unowned";
      ownership: GraftObjectOwnership & { state: "unowned" };
    }
  | {
      kind: "owned-without-node-lease";
      ownership: GraftObjectOwnership & { state: "restoring" | "ready" };
    }
  | {
      kind: "owned-with-node-lease";
      ownership: GraftObjectOwnership & { state: "restoring" | "ready" };
      ownerLease: GraftNodeLease;
    };

/** Explains why a node cannot authorize an ownership command. */
export type GraftNodeAuthorityFailure =
  | { reason: "node-missing" }
  | { reason: "process-generation-mismatch"; lease: GraftNodeLease }
  | { reason: "lease-expired"; lease: GraftNodeLease };

/** Registers a new process incarnation and its initial lease. */
export type GraftRegisterNodeInput = { lease: GraftNodeLease };

/** Reports whether a process incarnation obtained its requested node identity. */
export type GraftRegisterNodeResult =
  | { outcome: "registered"; lease: GraftNodeLease }
  | { outcome: "node-id-unavailable"; lease: GraftNodeLease };

/** Extends a continuously valid node lease using its last confirmed renewal identity. */
export type GraftRenewNodeLeaseInput = {
  nodeId: string;
  processGeneration: string;
  expectedRenewalId: string;
  nextRenewalId: string;
  attemptedAtMs: number;
  expiresAtMs: number;
};

/** Reports whether a node lease was renewed without an authority gap. */
export type GraftRenewNodeLeaseResult =
  | { outcome: "renewed"; lease: GraftNodeLease }
  | { outcome: "node-missing" }
  | { outcome: "process-generation-mismatch"; lease: GraftNodeLease }
  | { outcome: "renewal-id-mismatch"; lease: GraftNodeLease }
  | { outcome: "lease-expired"; lease: GraftNodeLease }
  | { outcome: "expiry-not-advanced"; lease: GraftNodeLease };

/** Registers one provisioned object database under its stable object identity. */
export type GraftRegisterObjectDatabaseInput = {
  objectId: string;
  remoteLogId: string;
};

/** Reports the durable mapping selected for an object identity. */
export type GraftRegisterObjectDatabaseResult =
  | { outcome: "registered"; ownership: GraftObjectOwnership }
  | { outcome: "existing"; ownership: GraftObjectOwnership };

/** Claims an observed object epoch for one process incarnation. */
export type GraftClaimObjectInput = {
  objectId: string;
  observedEpoch: string;
  nodeId: string;
  processGeneration: string;
  claimId: string;
  attemptedAtMs: number;
  /** Subtract the declared inter-node clock skew from the claimant's wall time. */
  ownerLeaseExpiryCutoffMs: number;
};

/** Reports whether an object entered restoring under a fresh fencing epoch. */
export type GraftClaimObjectResult =
  | { outcome: "claimed"; ownership: GraftObjectOwnership & { state: "restoring" } }
  | { outcome: "object-missing" }
  | { outcome: "node-authority-rejected"; failure: GraftNodeAuthorityFailure }
  | { outcome: "ownership-changed"; ownership: GraftObjectOwnership }
  | { outcome: "current-owner-live"; ownership: GraftObjectOwnership };

/** Publishes readiness for the exact restoring claim that completed object fencing. */
export type GraftMarkObjectReadyInput = {
  objectId: string;
  epoch: string;
  nodeId: string;
  processGeneration: string;
  claimId: string;
  attemptedAtMs: number;
};

/** Reports whether the exact restoring claim became ready. */
export type GraftMarkObjectReadyResult =
  | { outcome: "ready"; ownership: GraftObjectOwnership & { state: "ready" } }
  | { outcome: "object-missing" }
  | { outcome: "node-authority-rejected"; failure: GraftNodeAuthorityFailure }
  | { outcome: "ownership-changed"; ownership: GraftObjectOwnership };

/** Releases the exact owned epoch without resetting its fencing counter. */
export type GraftReleaseObjectInput = {
  objectId: string;
  epoch: string;
  nodeId: string;
  processGeneration: string;
  claimId: string;
  attemptedAtMs: number;
};

/** Reports whether the exact owned epoch became unowned. */
export type GraftReleaseObjectResult =
  | { outcome: "released"; ownership: GraftObjectOwnership & { state: "unowned" } }
  | { outcome: "object-missing" }
  | { outcome: "node-authority-rejected"; failure: GraftNodeAuthorityFailure }
  | { outcome: "ownership-changed"; ownership: GraftObjectOwnership };

/** Identifies the exact owned object authority issuing one alarm coordination command. */
export type GraftObjectAlarmAuthorityInput = {
  objectId: string;
  epoch: string;
  nodeId: string;
  processGeneration: string;
  claimId: string;
  attemptedAtMs: number;
};

/** Marks one object alarm as requiring repair from its authoritative object database. */
export type GraftBeginObjectAlarmChangeInput = GraftObjectAlarmAuthorityInput & {
  reconciliationId: string;
};

/** Reports whether an exact object owner installed its alarm reconciliation marker. */
export type GraftBeginObjectAlarmChangeResult =
  | { outcome: "begun"; reconciliationId: string }
  | { outcome: "object-missing" }
  | { outcome: "node-authority-rejected"; failure: GraftNodeAuthorityFailure }
  | { outcome: "ownership-changed"; ownership: GraftObjectOwnership };

/** Describes the authoritative object alarm state published after an object-log push. */
export type GraftObjectAlarmPublication =
  | { kind: "none" }
  | { kind: "scheduled"; installationId: string; dueAtMs: number };

/** Publishes object alarm state while consuming one exact reconciliation marker. */
export type GraftCompleteObjectAlarmChangeInput = GraftObjectAlarmAuthorityInput & {
  reconciliationId: string;
  alarm: GraftObjectAlarmPublication;
};

/** Reports whether an alarm publication consumed the expected reconciliation marker. */
export type GraftCompleteObjectAlarmChangeResult =
  | { outcome: "completed"; alarm: GraftObjectAlarmPublication }
  | { outcome: "work-changed" }
  | { outcome: "object-missing" }
  | { outcome: "node-authority-rejected"; failure: GraftNodeAuthorityFailure }
  | { outcome: "ownership-changed"; ownership: GraftObjectOwnership };

/** Represents durable alarm discovery or repair work for one object. */
export type GraftObjectAlarmWork =
  | {
      kind: "reconcile";
      objectId: string;
      reconciliationId: string;
      createdAtMs: number;
    }
  | {
      kind: "scheduled";
      objectId: string;
      installationId: string;
      dueAtMs: number;
      createdAtMs: number;
    };

/** Selects one bounded page of alarm work this process may service or claim. */
export type GraftServiceableObjectAlarmWorkInput = {
  nodeId: string;
  processGeneration: string;
  dueAtOrBeforeMs: number;
  ownerLeaseExpiryCutoffMs: number;
  afterObjectId: string;
  limit: number;
};

type ControlCommandReceipt<TResult> = {
  commandName: string;
  commandInputJson: string;
  result: TResult;
};

type ObjectOwnershipRow = {
  object_id: string;
  remote_log_id: string;
  epoch: string;
  lifecycle: string;
  owner_node_id: string;
  claim_id: string;
};

type NodeLeaseRow = {
  node_id: string;
  process_generation: string;
  private_address: string;
  application_origin: string;
  compatibility_version: number;
  expires_at_ms: number;
  renewal_id: string;
};

type ObjectAlarmWorkRow = {
  object_id: string;
  kind: string;
  reconciliation_id: string;
  installation_id: string;
  due_at_ms: number;
  created_at_ms: number;
};

/** Owns clean read snapshots and isolated receipt-backed commands for one Graft control log. */
export class GraftControlStore {
  readonly #storage: GraftNodeRuntimeStorage;
  readonly #operations: GraftDatabaseOperations;
  readonly #maxCommandAttempts: number;
  readonly #readReplica: GraftControlReadReplica;
  #commandDatabase: DatabaseSync | null = null;
  #closed = false;

  constructor(
    storage: GraftNodeRuntimeStorage,
    operations: GraftDatabaseOperations = createSqlitePragmaGraftDatabaseOperations(),
    maxCommandAttempts = DEFAULT_CONTROL_COMMAND_ATTEMPTS,
  ) {
    validateNonEmptyString(storage.controlRemoteLogId, "controlRemoteLogId");
    validatePositiveSafeInteger(maxCommandAttempts, "maxCommandAttempts");
    initializeGraftSqlite(storage.configPath);
    this.#storage = storage;
    this.#operations = operations;
    this.#maxCommandAttempts = maxCommandAttempts;
    this.#readReplica = new GraftControlReadReplica(storage, operations);
  }

  registerNode(command: GraftControlCommand<GraftRegisterNodeInput>): GraftRegisterNodeResult {
    validateControlCommand(command);
    const lease = normalizeNodeLease(command.input.lease);
    if (lease.expiresAtMs <= command.commandCreatedAtMs) {
      throw new Error("GRAFT_CONTROL_NODE_LEASE_EXPIRY_INVALID");
    }
    const input: GraftRegisterNodeInput = { lease };
    return this.#executeCommand(
      "register-node",
      command.commandId,
      command.commandCreatedAtMs,
      input,
      (database) => {
        const existing = readNodeLease(database, lease.nodeId);
        if (existing) {
          return { outcome: "node-id-unavailable", lease: existing };
        }
        database
          .prepare(
            `INSERT INTO node_runtime_node_lease
              (node_id, process_generation, private_address, application_origin,
               compatibility_version, expires_at_ms, renewal_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            lease.nodeId,
            lease.processGeneration,
            lease.privateAddress,
            lease.applicationOrigin,
            lease.compatibilityVersion,
            lease.expiresAtMs,
            lease.renewalId,
          );
        return { outcome: "registered", lease };
      },
    );
  }

  renewNodeLease(
    command: GraftControlCommand<GraftRenewNodeLeaseInput>,
  ): GraftRenewNodeLeaseResult {
    validateControlCommand(command);
    const input = normalizeRenewNodeLeaseInput(command.input);
    if (input.expiresAtMs <= input.attemptedAtMs) {
      throw new Error("GRAFT_CONTROL_NODE_LEASE_EXPIRY_INVALID");
    }
    return this.#executeCommand(
      "renew-node-lease",
      command.commandId,
      command.commandCreatedAtMs,
      input,
      (database) => {
        const existing = readNodeLease(database, input.nodeId);
        if (!existing) {
          return { outcome: "node-missing" };
        }
        if (existing.processGeneration !== input.processGeneration) {
          return { outcome: "process-generation-mismatch", lease: existing };
        }
        if (existing.renewalId !== input.expectedRenewalId) {
          return { outcome: "renewal-id-mismatch", lease: existing };
        }
        if (existing.expiresAtMs <= input.attemptedAtMs) {
          return { outcome: "lease-expired", lease: existing };
        }
        if (input.expiresAtMs <= existing.expiresAtMs) {
          return { outcome: "expiry-not-advanced", lease: existing };
        }
        const renewed: GraftNodeLease = {
          ...existing,
          expiresAtMs: input.expiresAtMs,
          renewalId: input.nextRenewalId,
        };
        database
          .prepare(
            `UPDATE node_runtime_node_lease
             SET expires_at_ms = ?, renewal_id = ?
             WHERE node_id = ?`,
          )
          .run(renewed.expiresAtMs, renewed.renewalId, renewed.nodeId);
        return { outcome: "renewed", lease: renewed };
      },
    );
  }

  registerObjectDatabase(
    command: GraftControlCommand<GraftRegisterObjectDatabaseInput>,
  ): GraftRegisterObjectDatabaseResult {
    validateControlCommand(command);
    const input = normalizeRegisterObjectDatabaseInput(command.input);
    return this.#executeCommand(
      "register-object-database",
      command.commandId,
      command.commandCreatedAtMs,
      input,
      (database) => {
        const existing = readObjectOwnership(database, input.objectId);
        if (existing) {
          return { outcome: "existing", ownership: existing };
        }
        database
          .prepare(
            "INSERT INTO node_runtime_object_directory (object_id, remote_log_id) VALUES (?, ?)",
          )
          .run(input.objectId, input.remoteLogId);
        database
          .prepare(
            `INSERT INTO node_runtime_object_ownership
              (object_id, epoch, lifecycle, owner_node_id, claim_id)
             VALUES (?, '0', 'unowned', '', '')`,
          )
          .run(input.objectId);
        return {
          outcome: "registered",
          ownership: {
            state: "unowned",
            objectId: input.objectId,
            remoteLogId: input.remoteLogId,
            epoch: "0",
          },
        };
      },
    );
  }

  claimObject(command: GraftControlCommand<GraftClaimObjectInput>): GraftClaimObjectResult {
    validateControlCommand(command);
    const input = normalizeClaimObjectInput(command.input);
    return this.#executeCommand(
      "claim-object",
      command.commandId,
      command.commandCreatedAtMs,
      input,
      (database) => {
        const authorityFailure = readNodeAuthorityFailure(
          database,
          input.nodeId,
          input.processGeneration,
          input.attemptedAtMs,
        );
        if (authorityFailure) {
          return { outcome: "node-authority-rejected", failure: authorityFailure };
        }
        const existing = readObjectOwnership(database, input.objectId);
        if (!existing) {
          return { outcome: "object-missing" };
        }
        if (existing.epoch !== input.observedEpoch) {
          return { outcome: "ownership-changed", ownership: existing };
        }
        if (existing.state !== "unowned") {
          const ownerLease = readNodeLease(database, existing.ownerNodeId);
          if (ownerLease && ownerLease.expiresAtMs > input.ownerLeaseExpiryCutoffMs) {
            return { outcome: "current-owner-live", ownership: existing };
          }
        }

        const claimed: GraftObjectOwnership & { state: "restoring" } = {
          state: "restoring",
          objectId: existing.objectId,
          remoteLogId: existing.remoteLogId,
          epoch: incrementObjectEpoch(existing.epoch),
          ownerNodeId: input.nodeId,
          claimId: input.claimId,
        };
        writeObjectOwnership(database, claimed);
        return { outcome: "claimed", ownership: claimed };
      },
    );
  }

  markObjectReady(
    command: GraftControlCommand<GraftMarkObjectReadyInput>,
  ): GraftMarkObjectReadyResult {
    validateControlCommand(command);
    const input = normalizeOwnedObjectCommandInput(command.input);
    return this.#executeCommand(
      "mark-object-ready",
      command.commandId,
      command.commandCreatedAtMs,
      input,
      (database) => {
        const authorityFailure = readNodeAuthorityFailure(
          database,
          input.nodeId,
          input.processGeneration,
          input.attemptedAtMs,
        );
        if (authorityFailure) {
          return { outcome: "node-authority-rejected", failure: authorityFailure };
        }
        const existing = readObjectOwnership(database, input.objectId);
        if (!existing) {
          return { outcome: "object-missing" };
        }
        if (!matchesOwnedObjectCommand(existing, input)) {
          return { outcome: "ownership-changed", ownership: existing };
        }
        if (existing.state === "ready") {
          return { outcome: "ready", ownership: existing };
        }
        const ready: GraftObjectOwnership & { state: "ready" } = {
          ...existing,
          state: "ready",
        };
        writeObjectOwnership(database, ready);
        return { outcome: "ready", ownership: ready };
      },
    );
  }

  releaseObject(command: GraftControlCommand<GraftReleaseObjectInput>): GraftReleaseObjectResult {
    validateControlCommand(command);
    const input = normalizeOwnedObjectCommandInput(command.input);
    return this.#executeCommand(
      "release-object",
      command.commandId,
      command.commandCreatedAtMs,
      input,
      (database) => {
        const authorityFailure = readNodeAuthorityFailure(
          database,
          input.nodeId,
          input.processGeneration,
          input.attemptedAtMs,
        );
        if (authorityFailure) {
          return { outcome: "node-authority-rejected", failure: authorityFailure };
        }
        const existing = readObjectOwnership(database, input.objectId);
        if (!existing) {
          return { outcome: "object-missing" };
        }
        if (!matchesOwnedObjectCommand(existing, input)) {
          return { outcome: "ownership-changed", ownership: existing };
        }
        const released: GraftObjectOwnership & { state: "unowned" } = {
          state: "unowned",
          objectId: existing.objectId,
          remoteLogId: existing.remoteLogId,
          epoch: existing.epoch,
        };
        writeObjectOwnership(database, released);
        return { outcome: "released", ownership: released };
      },
    );
  }

  beginObjectAlarmChange(
    command: GraftControlCommand<GraftBeginObjectAlarmChangeInput>,
  ): GraftBeginObjectAlarmChangeResult {
    validateControlCommand(command);
    const input = normalizeBeginObjectAlarmChangeInput(command.input);
    return this.#executeCommand(
      "begin-object-alarm-change",
      command.commandId,
      command.commandCreatedAtMs,
      input,
      (database) => {
        const authorityFailure = readNodeAuthorityFailure(
          database,
          input.nodeId,
          input.processGeneration,
          input.attemptedAtMs,
        );
        if (authorityFailure) {
          return { outcome: "node-authority-rejected", failure: authorityFailure };
        }
        const ownership = readObjectOwnership(database, input.objectId);
        if (!ownership) {
          return { outcome: "object-missing" };
        }
        if (!matchesObjectAlarmAuthority(ownership, input)) {
          return { outcome: "ownership-changed", ownership };
        }
        database
          .prepare(
            `INSERT INTO node_runtime_object_alarm_work
              (object_id, kind, reconciliation_id, installation_id, due_at_ms, created_at_ms)
             VALUES (?, 'reconcile', ?, '', 0, ?)
             ON CONFLICT(object_id) DO UPDATE SET
               kind = excluded.kind,
               reconciliation_id = excluded.reconciliation_id,
               installation_id = excluded.installation_id,
               due_at_ms = excluded.due_at_ms,
               created_at_ms = excluded.created_at_ms`,
          )
          .run(input.objectId, input.reconciliationId, command.commandCreatedAtMs);
        return { outcome: "begun", reconciliationId: input.reconciliationId };
      },
    );
  }

  completeObjectAlarmChange(
    command: GraftControlCommand<GraftCompleteObjectAlarmChangeInput>,
  ): GraftCompleteObjectAlarmChangeResult {
    validateControlCommand(command);
    const input = normalizeCompleteObjectAlarmChangeInput(command.input);
    return this.#executeCommand(
      "complete-object-alarm-change",
      command.commandId,
      command.commandCreatedAtMs,
      input,
      (database) => {
        const authorityFailure = readNodeAuthorityFailure(
          database,
          input.nodeId,
          input.processGeneration,
          input.attemptedAtMs,
        );
        if (authorityFailure) {
          return { outcome: "node-authority-rejected", failure: authorityFailure };
        }
        const ownership = readObjectOwnership(database, input.objectId);
        if (!ownership) {
          return { outcome: "object-missing" };
        }
        if (!matchesObjectAlarmAuthority(ownership, input)) {
          return { outcome: "ownership-changed", ownership };
        }
        const work = readObjectAlarmWork(database, input.objectId);
        if (work?.kind !== "reconcile" || work.reconciliationId !== input.reconciliationId) {
          return { outcome: "work-changed" };
        }
        if (input.alarm.kind === "none") {
          database
            .prepare("DELETE FROM node_runtime_object_alarm_work WHERE object_id = ?")
            .run(input.objectId);
        } else {
          database
            .prepare(
              `UPDATE node_runtime_object_alarm_work
               SET kind = 'scheduled', reconciliation_id = '', installation_id = ?,
                   due_at_ms = ?, created_at_ms = ?
               WHERE object_id = ?`,
            )
            .run(
              input.alarm.installationId,
              input.alarm.dueAtMs,
              command.commandCreatedAtMs,
              input.objectId,
            );
        }
        return { outcome: "completed", alarm: input.alarm };
      },
    );
  }

  readObjectAlarmWork(objectId: string): GraftObjectAlarmWork | null {
    validateNonEmptyString(objectId, "objectId");
    return this.#readReplica.readSnapshot((database) => readObjectAlarmWork(database, objectId));
  }

  readServiceableObjectAlarmWork(
    input: GraftServiceableObjectAlarmWorkInput,
  ): GraftObjectAlarmWork[] {
    const normalized = normalizeServiceableObjectAlarmWorkInput(input);
    return this.#readReplica.readSnapshot((database) => {
      const rows = database
        .prepare(
          `SELECT work.object_id, work.kind, work.reconciliation_id, work.installation_id,
                work.due_at_ms, work.created_at_ms
         FROM node_runtime_object_alarm_work AS work
         JOIN node_runtime_object_ownership AS ownership USING (object_id)
         LEFT JOIN node_runtime_node_lease AS owner_lease
           ON owner_lease.node_id = ownership.owner_node_id
         WHERE work.object_id > ?
           AND (work.kind = 'reconcile' OR work.due_at_ms <= ?)
           AND (
             ownership.lifecycle = 'unowned'
             OR (
               ownership.owner_node_id = ?
               AND owner_lease.process_generation = ?
             )
             OR owner_lease.node_id IS NULL
             OR owner_lease.expires_at_ms <= ?
           )
         ORDER BY work.object_id
         LIMIT ?`,
        )
        .all(
          normalized.afterObjectId,
          normalized.dueAtOrBeforeMs,
          normalized.nodeId,
          normalized.processGeneration,
          normalized.ownerLeaseExpiryCutoffMs,
          normalized.limit,
        ) as ObjectAlarmWorkRow[];
      return rows.map(castObjectAlarmWorkRow);
    });
  }

  readNodeLease(nodeId: string): GraftNodeLease | null {
    validateNonEmptyString(nodeId, "nodeId");
    return this.#readReplica.readSnapshot((database) => readNodeLease(database, nodeId));
  }

  readObjectLocation(objectId: string): GraftObjectLocation | null {
    validateNonEmptyString(objectId, "objectId");
    return this.#readReplica.readSnapshot((database) => readObjectLocation(database, objectId));
  }

  readObjectLocations(): GraftObjectLocation[] {
    return this.#readReplica.readSnapshot(readObjectLocations);
  }

  readObjectOwnership(objectId: string): GraftObjectOwnership | null {
    validateNonEmptyString(objectId, "objectId");
    return this.#readReplica.readSnapshot((database) => readObjectOwnership(database, objectId));
  }

  readObjectRoutingState(objectId: string): GraftObjectRoutingState | null {
    validateNonEmptyString(objectId, "objectId");
    return this.#readReplica.readSnapshot((database) => {
      const ownership = readObjectOwnership(database, objectId);
      if (!ownership) {
        return null;
      }
      if (ownership.state === "unowned") {
        return { kind: "unowned", ownership };
      }
      const ownerLease = readNodeLease(database, ownership.ownerNodeId);
      if (!ownerLease) {
        return { kind: "owned-without-node-lease", ownership };
      }
      return { kind: "owned-with-node-lease", ownership, ownerLease };
    });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#readReplica.close();
    this.#discardCommandDatabase();
  }

  #executeCommand<TResult>(
    commandName: string,
    commandId: string,
    commandCreatedAtMs: number,
    input: unknown,
    decide: (database: DatabaseSync) => TResult,
  ): TResult {
    return runWithGraftControlStoreLock(() => {
      const commandInputJson = JSON.stringify(input);
      let lastPushFailure: unknown = null;

      for (let attempt = 1; attempt <= this.#maxCommandAttempts; attempt += 1) {
        let database: DatabaseSync;
        try {
          database = this.#replaceCommandDatabaseFromRemote();
        } catch (cause) {
          if (lastPushFailure === null) {
            throw cause;
          }
          lastPushFailure = cause;
          continue;
        }

        const existingReceipt = readControlCommandReceipt<TResult>(database, commandId);
        if (existingReceipt) {
          return requireMatchingControlCommandReceipt(
            existingReceipt,
            commandName,
            commandInputJson,
            commandId,
          );
        }

        const result = runControlCommandTransaction(
          database,
          commandId,
          commandName,
          commandInputJson,
          commandCreatedAtMs,
          decide,
        );
        try {
          this.#operations.push(database);
          return result;
        } catch (cause) {
          lastPushFailure = cause;
          this.#discardCommandDatabase();
        }
      }

      try {
        const database = this.#replaceCommandDatabaseFromRemote();
        const receipt = readControlCommandReceipt<TResult>(database, commandId);
        if (receipt) {
          return requireMatchingControlCommandReceipt(
            receipt,
            commandName,
            commandInputJson,
            commandId,
          );
        }
      } catch (cause) {
        lastPushFailure = cause;
      }

      throw new Error("GRAFT_CONTROL_COMMAND_DURABILITY_UNCERTAIN", {
        cause: lastPushFailure,
      });
    });
  }

  #replaceCommandDatabaseFromRemote(): DatabaseSync {
    return runWithGraftControlStoreLock(() => {
      this.#requireOpen();
      this.#discardCommandDatabase();
      const database = openClonedGraftDatabase(
        `control-command-${randomUUID()}`,
        this.#storage.controlRemoteLogId,
        this.#operations,
      );
      try {
        requireGraftControlFormat(database);
        this.#commandDatabase = database;
        return database;
      } catch (error) {
        database.close();
        throw error;
      }
    });
  }

  #discardCommandDatabase(): void {
    this.#commandDatabase?.close();
    this.#commandDatabase = null;
  }

  #requireOpen(): void {
    if (this.#closed) {
      throw new Error("GRAFT_CONTROL_STORE_CLOSED");
    }
  }
}

function runControlCommandTransaction<TResult>(
  database: DatabaseSync,
  commandId: string,
  commandName: string,
  commandInputJson: string,
  commandCreatedAtMs: number,
  decide: (database: DatabaseSync) => TResult,
): TResult {
  database.exec("BEGIN IMMEDIATE");
  try {
    const existingReceipt = readControlCommandReceipt<TResult>(database, commandId);
    if (existingReceipt) {
      const result = requireMatchingControlCommandReceipt(
        existingReceipt,
        commandName,
        commandInputJson,
        commandId,
      );
      database.exec("COMMIT");
      return result;
    }
    const result = decide(database);
    database
      .prepare(
        `INSERT INTO node_runtime_control_command_receipt
          (command_id, command_name, command_input_json, result_json, created_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(commandId, commandName, commandInputJson, JSON.stringify(result), commandCreatedAtMs);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
}

function readControlCommandReceipt<TResult>(
  database: DatabaseSync,
  commandId: string,
): ControlCommandReceipt<TResult> | null {
  const row = database
    .prepare(
      `SELECT command_name, command_input_json, result_json
       FROM node_runtime_control_command_receipt
       WHERE command_id = ?`,
    )
    .get(commandId) as
    | { command_name: string; command_input_json: string; result_json: string }
    | undefined;
  if (!row) {
    return null;
  }
  return {
    commandName: row.command_name,
    commandInputJson: row.command_input_json,
    result: JSON.parse(row.result_json) as TResult,
  };
}

function requireMatchingControlCommandReceipt<TResult>(
  receipt: ControlCommandReceipt<TResult>,
  commandName: string,
  commandInputJson: string,
  commandId: string,
): TResult {
  if (receipt.commandName !== commandName || receipt.commandInputJson !== commandInputJson) {
    throw new Error(`GRAFT_CONTROL_COMMAND_ID_REUSED:${commandId}`);
  }
  return receipt.result;
}

function readNodeLease(database: DatabaseSync, nodeId: string): GraftNodeLease | null {
  const row = database
    .prepare(
      `SELECT node_id, process_generation, private_address, application_origin,
              compatibility_version, expires_at_ms, renewal_id
       FROM node_runtime_node_lease
       WHERE node_id = ?`,
    )
    .get(nodeId) as NodeLeaseRow | undefined;
  return row ? castNodeLeaseRow(row) : null;
}

function readNodeAuthorityFailure(
  database: DatabaseSync,
  nodeId: string,
  processGeneration: string,
  attemptedAtMs: number,
): GraftNodeAuthorityFailure | null {
  const lease = readNodeLease(database, nodeId);
  if (!lease) {
    return { reason: "node-missing" };
  }
  if (lease.processGeneration !== processGeneration) {
    return { reason: "process-generation-mismatch", lease };
  }
  if (lease.expiresAtMs <= attemptedAtMs) {
    return { reason: "lease-expired", lease };
  }
  return null;
}

function readObjectLocation(database: DatabaseSync, objectId: string): GraftObjectLocation | null {
  const row = database
    .prepare(
      `SELECT directory.object_id, directory.remote_log_id
       FROM node_runtime_object_directory AS directory
       JOIN node_runtime_object_ownership AS ownership USING (object_id)
       WHERE directory.object_id = ?`,
    )
    .get(objectId) as { object_id: string; remote_log_id: string } | undefined;
  return row ? { objectId: row.object_id, remoteLogId: row.remote_log_id } : null;
}

function readObjectLocations(database: DatabaseSync): GraftObjectLocation[] {
  const rows = database
    .prepare(
      `SELECT directory.object_id, directory.remote_log_id
       FROM node_runtime_object_directory AS directory
       JOIN node_runtime_object_ownership AS ownership USING (object_id)
       ORDER BY directory.object_id`,
    )
    .all() as { object_id: string; remote_log_id: string }[];
  return rows.map((row) => ({ objectId: row.object_id, remoteLogId: row.remote_log_id }));
}

function readObjectOwnership(
  database: DatabaseSync,
  objectId: string,
): GraftObjectOwnership | null {
  const row = database
    .prepare(
      `SELECT directory.object_id, directory.remote_log_id, ownership.epoch,
              ownership.lifecycle, ownership.owner_node_id, ownership.claim_id
       FROM node_runtime_object_directory AS directory
       JOIN node_runtime_object_ownership AS ownership USING (object_id)
       WHERE directory.object_id = ?`,
    )
    .get(objectId) as ObjectOwnershipRow | undefined;
  return row ? castObjectOwnershipRow(row) : null;
}

function readObjectAlarmWork(
  database: DatabaseSync,
  objectId: string,
): GraftObjectAlarmWork | null {
  const row = database
    .prepare(
      `SELECT object_id, kind, reconciliation_id, installation_id, due_at_ms, created_at_ms
       FROM node_runtime_object_alarm_work
       WHERE object_id = ?`,
    )
    .get(objectId) as ObjectAlarmWorkRow | undefined;
  return row ? castObjectAlarmWorkRow(row) : null;
}

function writeObjectOwnership(database: DatabaseSync, ownership: GraftObjectOwnership): void {
  if (ownership.state === "unowned") {
    database
      .prepare(
        `UPDATE node_runtime_object_ownership
         SET epoch = ?, lifecycle = 'unowned', owner_node_id = '', claim_id = ''
         WHERE object_id = ?`,
      )
      .run(ownership.epoch, ownership.objectId);
    return;
  }
  database
    .prepare(
      `UPDATE node_runtime_object_ownership
       SET epoch = ?, lifecycle = ?, owner_node_id = ?, claim_id = ?
       WHERE object_id = ?`,
    )
    .run(
      ownership.epoch,
      ownership.state,
      ownership.ownerNodeId,
      ownership.claimId,
      ownership.objectId,
    );
}

function castNodeLeaseRow(row: NodeLeaseRow): GraftNodeLease {
  return normalizeNodeLease({
    nodeId: row.node_id,
    processGeneration: row.process_generation,
    privateAddress: row.private_address,
    applicationOrigin: row.application_origin,
    compatibilityVersion: row.compatibility_version,
    expiresAtMs: row.expires_at_ms,
    renewalId: row.renewal_id,
  });
}

function castObjectAlarmWorkRow(row: ObjectAlarmWorkRow): GraftObjectAlarmWork {
  const createdAtMs = validateNonNegativeSafeInteger(row.created_at_ms, "createdAtMs");
  if (
    row.kind === "reconcile" &&
    row.reconciliation_id.length > 0 &&
    row.installation_id === "" &&
    row.due_at_ms === 0
  ) {
    return {
      kind: "reconcile",
      objectId: row.object_id,
      reconciliationId: row.reconciliation_id,
      createdAtMs,
    };
  }
  if (row.kind === "scheduled" && row.reconciliation_id === "" && row.installation_id.length > 0) {
    return {
      kind: "scheduled",
      objectId: row.object_id,
      installationId: row.installation_id,
      dueAtMs: validateNonNegativeSafeInteger(row.due_at_ms, "dueAtMs"),
      createdAtMs,
    };
  }
  throw new Error(`GRAFT_CONTROL_OBJECT_ALARM_WORK_INVALID:${row.object_id}`);
}

function castObjectOwnershipRow(row: ObjectOwnershipRow): GraftObjectOwnership {
  const epoch = normalizeObjectEpoch(row.epoch);
  if (row.lifecycle === "unowned" && row.owner_node_id === "" && row.claim_id === "") {
    return {
      state: "unowned",
      objectId: row.object_id,
      remoteLogId: row.remote_log_id,
      epoch,
    };
  }
  if (
    (row.lifecycle === "restoring" || row.lifecycle === "ready") &&
    row.owner_node_id !== "" &&
    row.claim_id !== ""
  ) {
    return {
      state: row.lifecycle,
      objectId: row.object_id,
      remoteLogId: row.remote_log_id,
      epoch,
      ownerNodeId: row.owner_node_id,
      claimId: row.claim_id,
    };
  }
  throw new Error(`GRAFT_CONTROL_OBJECT_OWNERSHIP_INVALID:${row.object_id}`);
}

function matchesOwnedObjectCommand(
  ownership: GraftObjectOwnership,
  input: GraftMarkObjectReadyInput | GraftReleaseObjectInput,
): ownership is Exclude<GraftObjectOwnership, { state: "unowned" }> {
  return (
    ownership.state !== "unowned" &&
    ownership.epoch === input.epoch &&
    ownership.ownerNodeId === input.nodeId &&
    ownership.claimId === input.claimId
  );
}

function matchesObjectAlarmAuthority(
  ownership: GraftObjectOwnership,
  input: GraftObjectAlarmAuthorityInput,
): ownership is Exclude<GraftObjectOwnership, { state: "unowned" }> {
  return (
    ownership.state !== "unowned" &&
    ownership.epoch === input.epoch &&
    ownership.ownerNodeId === input.nodeId &&
    ownership.claimId === input.claimId
  );
}

function incrementObjectEpoch(epoch: string): string {
  const parsed = BigInt(normalizeObjectEpoch(epoch));
  if (parsed >= MAX_OBJECT_EPOCH) {
    throw new Error("GRAFT_CONTROL_OBJECT_EPOCH_EXHAUSTED");
  }
  return (parsed + 1n).toString();
}

function normalizeNodeLease(lease: GraftNodeLease): GraftNodeLease {
  return {
    nodeId: validateNonEmptyString(lease.nodeId, "nodeId"),
    processGeneration: validateNonEmptyString(lease.processGeneration, "processGeneration"),
    privateAddress: validateNonEmptyString(lease.privateAddress, "privateAddress"),
    applicationOrigin: normalizeNodeApplicationOrigin(lease.applicationOrigin),
    compatibilityVersion: validatePositiveSafeInteger(
      lease.compatibilityVersion,
      "compatibilityVersion",
    ),
    expiresAtMs: validateNonNegativeSafeInteger(lease.expiresAtMs, "expiresAtMs"),
    renewalId: validateNonEmptyString(lease.renewalId, "renewalId"),
  };
}

function normalizeRenewNodeLeaseInput(input: GraftRenewNodeLeaseInput): GraftRenewNodeLeaseInput {
  if (input.expectedRenewalId === input.nextRenewalId) {
    throw new Error("GRAFT_CONTROL_NODE_RENEWAL_ID_NOT_ADVANCED");
  }
  return {
    nodeId: validateNonEmptyString(input.nodeId, "nodeId"),
    processGeneration: validateNonEmptyString(input.processGeneration, "processGeneration"),
    expectedRenewalId: validateNonEmptyString(input.expectedRenewalId, "expectedRenewalId"),
    nextRenewalId: validateNonEmptyString(input.nextRenewalId, "nextRenewalId"),
    attemptedAtMs: validateNonNegativeSafeInteger(input.attemptedAtMs, "attemptedAtMs"),
    expiresAtMs: validateNonNegativeSafeInteger(input.expiresAtMs, "expiresAtMs"),
  };
}

function normalizeRegisterObjectDatabaseInput(
  input: GraftRegisterObjectDatabaseInput,
): GraftRegisterObjectDatabaseInput {
  return {
    objectId: validateNonEmptyString(input.objectId, "objectId"),
    remoteLogId: validateNonEmptyString(input.remoteLogId, "remoteLogId"),
  };
}

function normalizeClaimObjectInput(input: GraftClaimObjectInput): GraftClaimObjectInput {
  validateNonNegativeSafeInteger(input.ownerLeaseExpiryCutoffMs, "ownerLeaseExpiryCutoffMs");
  if (input.ownerLeaseExpiryCutoffMs > input.attemptedAtMs) {
    throw new Error("GRAFT_CONTROL_OWNER_LEASE_CUTOFF_INVALID");
  }
  return {
    objectId: validateNonEmptyString(input.objectId, "objectId"),
    observedEpoch: normalizeObjectEpoch(input.observedEpoch),
    ownerLeaseExpiryCutoffMs: input.ownerLeaseExpiryCutoffMs,
    nodeId: validateNonEmptyString(input.nodeId, "nodeId"),
    processGeneration: validateNonEmptyString(input.processGeneration, "processGeneration"),
    claimId: validateNonEmptyString(input.claimId, "claimId"),
    attemptedAtMs: validateNonNegativeSafeInteger(input.attemptedAtMs, "attemptedAtMs"),
  };
}

function normalizeOwnedObjectCommandInput<
  TInput extends GraftMarkObjectReadyInput | GraftReleaseObjectInput,
>(input: TInput): TInput {
  return {
    objectId: validateNonEmptyString(input.objectId, "objectId"),
    epoch: normalizeObjectEpoch(input.epoch),
    nodeId: validateNonEmptyString(input.nodeId, "nodeId"),
    processGeneration: validateNonEmptyString(input.processGeneration, "processGeneration"),
    claimId: validateNonEmptyString(input.claimId, "claimId"),
    attemptedAtMs: validateNonNegativeSafeInteger(input.attemptedAtMs, "attemptedAtMs"),
  } as TInput;
}

function normalizeBeginObjectAlarmChangeInput(
  input: GraftBeginObjectAlarmChangeInput,
): GraftBeginObjectAlarmChangeInput {
  return {
    ...normalizeObjectAlarmAuthorityInput(input),
    reconciliationId: validateNonEmptyString(input.reconciliationId, "reconciliationId"),
  };
}

function normalizeCompleteObjectAlarmChangeInput(
  input: GraftCompleteObjectAlarmChangeInput,
): GraftCompleteObjectAlarmChangeInput {
  const authority = normalizeObjectAlarmAuthorityInput(input);
  const reconciliationId = validateNonEmptyString(input.reconciliationId, "reconciliationId");
  if (input.alarm.kind === "none") {
    return { ...authority, reconciliationId, alarm: { kind: "none" } };
  }
  return {
    ...authority,
    reconciliationId,
    alarm: {
      kind: "scheduled",
      installationId: validateNonEmptyString(input.alarm.installationId, "installationId"),
      dueAtMs: validateNonNegativeSafeInteger(input.alarm.dueAtMs, "dueAtMs"),
    },
  };
}

function normalizeObjectAlarmAuthorityInput(
  input: GraftObjectAlarmAuthorityInput,
): GraftObjectAlarmAuthorityInput {
  return {
    objectId: validateNonEmptyString(input.objectId, "objectId"),
    epoch: normalizeObjectEpoch(input.epoch),
    nodeId: validateNonEmptyString(input.nodeId, "nodeId"),
    processGeneration: validateNonEmptyString(input.processGeneration, "processGeneration"),
    claimId: validateNonEmptyString(input.claimId, "claimId"),
    attemptedAtMs: validateNonNegativeSafeInteger(input.attemptedAtMs, "attemptedAtMs"),
  };
}

function normalizeServiceableObjectAlarmWorkInput(
  input: GraftServiceableObjectAlarmWorkInput,
): GraftServiceableObjectAlarmWorkInput {
  return {
    nodeId: validateNonEmptyString(input.nodeId, "nodeId"),
    processGeneration: validateNonEmptyString(input.processGeneration, "processGeneration"),
    dueAtOrBeforeMs: validateNonNegativeSafeInteger(input.dueAtOrBeforeMs, "dueAtOrBeforeMs"),
    ownerLeaseExpiryCutoffMs: validateNonNegativeSafeInteger(
      input.ownerLeaseExpiryCutoffMs,
      "ownerLeaseExpiryCutoffMs",
    ),
    afterObjectId: input.afterObjectId,
    limit: validatePositiveSafeInteger(input.limit, "limit"),
  };
}

function normalizeNodeApplicationOrigin(value: string): string {
  const applicationOrigin = validateNonEmptyString(value, "applicationOrigin");
  let parsed: URL;
  try {
    parsed = new URL(applicationOrigin);
  } catch (cause) {
    throw new Error("GRAFT_CONTROL_NODE_APPLICATION_ORIGIN_INVALID", { cause });
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("GRAFT_CONTROL_NODE_APPLICATION_ORIGIN_INVALID");
  }
  return parsed.origin;
}

function normalizeObjectEpoch(epoch: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(epoch)) {
    throw new Error(`GRAFT_CONTROL_OBJECT_EPOCH_INVALID:${epoch}`);
  }
  const parsed = BigInt(epoch);
  if (parsed > MAX_OBJECT_EPOCH) {
    throw new Error(`GRAFT_CONTROL_OBJECT_EPOCH_INVALID:${epoch}`);
  }
  return epoch;
}

function validateControlCommand(command: GraftControlCommand<unknown>): void {
  validateNonEmptyString(command.commandId, "commandId");
  validateNonNegativeSafeInteger(command.commandCreatedAtMs, "commandCreatedAtMs");
}

function validateNonEmptyString(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`GRAFT_CONTROL_STRING_INVALID:${name}`);
  }
  return value;
}

function validatePositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`GRAFT_CONTROL_POSITIVE_INTEGER_INVALID:${name}`);
  }
  return value;
}

function validateNonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`GRAFT_CONTROL_NON_NEGATIVE_INTEGER_INVALID:${name}`);
  }
  return value;
}
