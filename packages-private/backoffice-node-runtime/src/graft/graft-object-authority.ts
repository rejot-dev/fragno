import type { DatabaseSync } from "node:sqlite";

const MAX_OBJECT_AUTHORITY_EPOCH = 9_223_372_036_854_775_807n;

/** Identifies the exact node claim authorized to append to one Graft object log. */
export type GraftObjectAuthority = {
  objectId: string;
  epoch: string;
  ownerNodeId: string;
  processGeneration: string;
  claimId: string;
};

/** Represents whether an object log has received its first ownership fencing commit. */
export type GraftObjectAuthorityState =
  | { state: "unowned"; objectId: string; epoch: "0" }
  | ({ state: "owned" } & GraftObjectAuthority);

/** Binds one object-log authority token to its last confirmed node lease deadline. */
export type GraftObjectActivationAuthority = GraftObjectAuthority & {
  leaseExpiresAtMs: number;
};

type GraftObjectAuthorityRow = {
  object_id: string;
  epoch: string;
  owner_node_id: string;
  process_generation: string;
  claim_id: string;
};

/** Adds the runtime-owned authority row while provisioning a new object database. */
export function createGraftObjectAuthoritySchema(database: DatabaseSync, objectId: string): void {
  database.exec(`
    CREATE TABLE node_runtime_object_authority (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      object_id TEXT NOT NULL UNIQUE REFERENCES node_runtime_object_identity(object_id),
      epoch TEXT NOT NULL,
      owner_node_id TEXT NOT NULL,
      process_generation TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      CHECK (
        (epoch = '0' AND owner_node_id = '' AND process_generation = '' AND claim_id = '') OR
        (epoch <> '0' AND owner_node_id <> '' AND process_generation <> '' AND claim_id <> '')
      )
    ) STRICT;
  `);
  database
    .prepare(
      `INSERT INTO node_runtime_object_authority
        (singleton, object_id, epoch, owner_node_id, process_generation, claim_id)
       VALUES (1, ?, '0', '', '', '')`,
    )
    .run(objectId);
}

/** Reads and validates the runtime-owned authority currently stored in an object clone. */
export function readGraftObjectAuthority(database: DatabaseSync): GraftObjectAuthorityState | null {
  const row = database
    .prepare(
      `SELECT object_id, epoch, owner_node_id, process_generation, claim_id
       FROM node_runtime_object_authority
       WHERE singleton = 1`,
    )
    .get() as GraftObjectAuthorityRow | undefined;
  if (!row) {
    return null;
  }
  const epoch = normalizeGraftObjectAuthorityEpoch(row.epoch);
  if (
    epoch === "0" &&
    row.owner_node_id === "" &&
    row.process_generation === "" &&
    row.claim_id === ""
  ) {
    return { state: "unowned", objectId: row.object_id, epoch: "0" };
  }
  if (
    epoch !== "0" &&
    row.owner_node_id !== "" &&
    row.process_generation !== "" &&
    row.claim_id !== ""
  ) {
    return {
      state: "owned",
      objectId: row.object_id,
      epoch,
      ownerNodeId: row.owner_node_id,
      processGeneration: row.process_generation,
      claimId: row.claim_id,
    };
  }
  throw new Error(`GRAFT_OBJECT_AUTHORITY_ROW_INVALID:${row.object_id}`);
}

/** Replaces the object-log fence inside the caller's existing SQLite transaction. */
export function writeGraftObjectAuthority(
  database: DatabaseSync,
  authority: GraftObjectAuthority,
): void {
  normalizeGraftObjectAuthority(authority);
  database
    .prepare(
      `UPDATE node_runtime_object_authority
       SET epoch = ?, owner_node_id = ?, process_generation = ?, claim_id = ?
       WHERE singleton = 1 AND object_id = ?`,
    )
    .run(
      authority.epoch,
      authority.ownerNodeId,
      authority.processGeneration,
      authority.claimId,
      authority.objectId,
    );
  const changes = database.prepare("SELECT changes() AS changes").get() as { changes: number };
  if (changes.changes !== 1) {
    throw new Error(`GRAFT_OBJECT_AUTHORITY_OBJECT_MISSING:${authority.objectId}`);
  }
}

/** Throws unless a local object clone carries the exact activation authority token. */
export function assertGraftObjectAuthority(
  database: DatabaseSync,
  expected: GraftObjectAuthority,
): void {
  const actual = readGraftObjectAuthority(database);
  if (!actual || !sameGraftObjectAuthority(actual, expected)) {
    throw new Error("NODE_RUNTIME_OBJECT_AUTHORITY_MISMATCH");
  }
}

/** Compares exact object-log authority identities without considering lease time. */
export function sameGraftObjectAuthority(
  left: GraftObjectAuthorityState,
  right: GraftObjectAuthority,
): boolean {
  return (
    left.state === "owned" &&
    left.objectId === right.objectId &&
    left.epoch === right.epoch &&
    left.ownerNodeId === right.ownerNodeId &&
    left.processGeneration === right.processGeneration &&
    left.claimId === right.claimId
  );
}

/** Returns whether one validated decimal fencing epoch precedes another. */
export function graftObjectAuthorityEpochPrecedes(left: string, right: string): boolean {
  return (
    BigInt(normalizeGraftObjectAuthorityEpoch(left)) <
    BigInt(normalizeGraftObjectAuthorityEpoch(right))
  );
}

function normalizeGraftObjectAuthority(authority: GraftObjectAuthority): GraftObjectAuthority {
  const epoch = normalizeGraftObjectAuthorityEpoch(authority.epoch);
  if (
    authority.objectId.length === 0 ||
    epoch === "0" ||
    authority.ownerNodeId.length === 0 ||
    authority.processGeneration.length === 0 ||
    authority.claimId.length === 0
  ) {
    throw new Error("GRAFT_OBJECT_AUTHORITY_INVALID");
  }
  return { ...authority, epoch };
}

function normalizeGraftObjectAuthorityEpoch(epoch: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(epoch)) {
    throw new Error(`GRAFT_OBJECT_AUTHORITY_EPOCH_INVALID:${epoch}`);
  }
  const parsed = BigInt(epoch);
  if (parsed > MAX_OBJECT_AUTHORITY_EPOCH) {
    throw new Error(`GRAFT_OBJECT_AUTHORITY_EPOCH_INVALID:${epoch}`);
  }
  return epoch;
}
