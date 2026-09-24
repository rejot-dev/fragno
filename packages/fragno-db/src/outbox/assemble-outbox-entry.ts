import superjson from "superjson";

import type { OutboxEntry, OutboxOperation, OutboxPayload, OutboxRefMap } from "./outbox";

/** Assembles a wire-ready outbox entry from its ordered mutation operations. */
export function assembleOutboxEntry(
  entry: Pick<OutboxEntry, "id" | "versionstamp" | "uowId" | "createdAt"> & {
    refMap: OutboxRefMap | null | undefined;
  },
  operations: OutboxOperation[],
): OutboxEntry {
  return {
    id: entry.id,
    versionstamp: entry.versionstamp,
    uowId: entry.uowId,
    payload: superjson.serialize({ version: 2, operations } satisfies OutboxPayload),
    refMap: entry.refMap ?? undefined,
    createdAt: entry.createdAt,
  };
}
