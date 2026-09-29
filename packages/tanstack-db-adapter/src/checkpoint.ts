export const FRAGNO_OUTBOX_COLLECTION_CHECKPOINT_METADATA_KEY =
  "fragno.outbox.collection-checkpoint.v1";

/** The last applied entry identity, including its UOW to detect restored outbox history. */
export type FragnoOutboxCheckpoint = {
  versionstamp: string;
  uowId: string;
};

export type FragnoOutboxSource = {
  adapterIdentity: string;
  namespace: string;
  table: string;
};

/** Skips collection changes already committed before a shared checkpoint could advance. */
export function shouldApplyOutboxCheckpoint(
  appliedCheckpoint: FragnoOutboxCheckpoint | undefined,
  incomingCheckpoint: FragnoOutboxCheckpoint,
): boolean {
  if (
    appliedCheckpoint?.versionstamp === incomingCheckpoint.versionstamp &&
    appliedCheckpoint.uowId !== incomingCheckpoint.uowId
  ) {
    throw new Error(`Outbox checkpoint ${incomingCheckpoint.versionstamp} changed unit of work.`);
  }
  return !appliedCheckpoint || incomingCheckpoint.versionstamp > appliedCheckpoint.versionstamp;
}
