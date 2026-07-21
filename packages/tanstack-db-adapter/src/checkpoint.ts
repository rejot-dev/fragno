import type { FragnoOutboxEntry } from "./protocol";

export const FRAGNO_OUTBOX_CHECKPOINT_METADATA_KEY = "fragno.outbox.checkpoint.v1";
export const FRAGNO_OUTBOX_SOURCE_METADATA_KEY = "fragno.outbox.source.v1";

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
  if (!checkpoint) {
    return true;
  }

  if (entry.versionstamp < checkpoint.versionstamp) {
    return false;
  }

  if (entry.versionstamp > checkpoint.versionstamp) {
    return true;
  }

  if (entry.uowId !== checkpoint.uowId) {
    throw new Error(
      `Outbox versionstamp ${entry.versionstamp} changed from UOW ${checkpoint.uowId} to ${entry.uowId}.`,
    );
  }

  return false;
}
