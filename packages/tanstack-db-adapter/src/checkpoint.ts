import type { FragnoOutboxEntry } from "./protocol";

export const FRAGNO_OUTBOX_COLLECTION_CHECKPOINT_METADATA_KEY =
  "fragno.outbox.collection-checkpoint.v1";

export type FragnoOutboxCheckpoint = {
  versionstamp: string;
  uowId: string;
};

export type FragnoOutboxSource = {
  adapterIdentity: string;
  namespace: string;
  table: string;
};

export function checkpointForEntry(entry: FragnoOutboxEntry): FragnoOutboxCheckpoint {
  return {
    versionstamp: entry.versionstamp,
    uowId: entry.uowId,
  };
}

export function shouldApplyOutboxEntry(
  checkpoint: FragnoOutboxCheckpoint | undefined,
  entry: FragnoOutboxEntry,
): boolean {
  return shouldApplyOutboxCheckpoint(checkpoint, checkpointForEntry(entry));
}

export function shouldApplyOutboxCheckpoint(
  appliedCheckpoint: FragnoOutboxCheckpoint | undefined,
  incomingCheckpoint: FragnoOutboxCheckpoint,
): boolean {
  if (!appliedCheckpoint) {
    return true;
  }

  if (incomingCheckpoint.versionstamp < appliedCheckpoint.versionstamp) {
    return false;
  }

  if (incomingCheckpoint.versionstamp > appliedCheckpoint.versionstamp) {
    return true;
  }

  if (incomingCheckpoint.uowId !== appliedCheckpoint.uowId) {
    throw new Error(
      `Outbox versionstamp ${incomingCheckpoint.versionstamp} changed from UOW ${appliedCheckpoint.uowId} to ${incomingCheckpoint.uowId}.`,
    );
  }

  return false;
}
