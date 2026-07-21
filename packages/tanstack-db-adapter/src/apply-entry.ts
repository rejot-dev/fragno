import type { AnySchema } from "@fragno-dev/db/schema";

import type { ChangeMessageOrDeleteKeyMessage } from "@tanstack/db";

import {
  checkpointForEntry,
  FRAGNO_OUTBOX_CHECKPOINT_METADATA_KEY,
  type FragnoOutboxCheckpoint,
} from "./checkpoint";
import {
  projectFragnoOutboxEntry,
  toTanStackChangeMessage,
  type FragnoCollectionRow,
  type FragnoCollectionTarget,
  type FragnoOutboxEntry,
} from "./protocol";

export type FragnoOutboxApplyControls<TRow extends object> = {
  begin(): void;
  write(message: ChangeMessageOrDeleteKeyMessage<TRow, string>): void;
  metadata: {
    collection: {
      set(key: string, value: unknown): void;
    };
  };
  commit(): void;
};

export function applyFragnoOutboxEntry<
  TSchema extends AnySchema,
  TTableName extends keyof TSchema["tables"] & string,
>(
  entry: FragnoOutboxEntry,
  target: FragnoCollectionTarget<TSchema, TTableName>,
  controls: FragnoOutboxApplyControls<FragnoCollectionRow<TSchema["tables"][TTableName]>>,
): FragnoOutboxCheckpoint {
  // Decode and project before opening the TanStack transaction so malformed payloads cannot leave
  // a pending transaction behind.
  const changes = projectFragnoOutboxEntry(entry, target);
  const checkpoint = checkpointForEntry(entry);

  controls.begin();
  for (const change of changes) {
    controls.write(toTanStackChangeMessage(change));
  }
  controls.metadata.collection.set(FRAGNO_OUTBOX_CHECKPOINT_METADATA_KEY, checkpoint);
  controls.commit();

  return checkpoint;
}
