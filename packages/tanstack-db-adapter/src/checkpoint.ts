import { outboxPageAfterVersionstamp } from "@fragno-dev/db/outbox";

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

/** Aligns stream replay while including the exact checkpoint entry for UOW verification. */
export function outboxStreamResumeCursor(versionstamp: string | undefined): string | undefined {
  if (versionstamp === undefined) {
    return undefined;
  }
  const aligned = outboxPageAfterVersionstamp(versionstamp);
  return aligned === versionstamp
    ? (BigInt(`0x${versionstamp}`) - 1n).toString(16).padStart(24, "0")
    : aligned;
}

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
