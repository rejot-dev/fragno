import type { OutboxEntry } from "@fragno-dev/db";

import { decodeOutboxPayload, resolveOutboxRefs } from "../outbox";
import type { LofiAdapter, LofiMutation, LofiSubmitCommand } from "../types";

export type RebaseResult = {
  appliedEntries: number;
  lastVersionstamp?: string;
  queue: LofiSubmitCommand[];
};

const decodeEntryMutations = (entry: OutboxEntry): LofiMutation[] => {
  const payload = decodeOutboxPayload(entry.payload);
  const mutations: LofiMutation[] = [];
  for (const operation of payload.operations) {
    if (operation.op === "truncate") {
      mutations.push(
        ...operation.externalIds.map(
          (externalId): LofiMutation => ({
            op: "delete",
            schema: operation.schema,
            table: operation.table,
            externalId,
            versionstamp: operation.versionstamp,
          }),
        ),
      );
      continue;
    }

    if (operation.op === "create") {
      mutations.push({
        op: "create",
        schema: operation.schema,
        table: operation.table,
        externalId: operation.externalId,
        values: operation.values,
        versionstamp: operation.versionstamp,
      });
      continue;
    }

    if (operation.op === "update") {
      mutations.push({
        op: "update",
        schema: operation.schema,
        table: operation.table,
        externalId: operation.externalId,
        set: operation.set,
        versionstamp: operation.versionstamp,
      });
      continue;
    }

    mutations.push({
      op: "delete",
      schema: operation.schema,
      table: operation.table,
      externalId: operation.externalId,
      versionstamp: operation.versionstamp,
    });
  }
  return mutations;
};

export const applyOutboxEntries = async (options: {
  adapter: LofiAdapter;
  entries: OutboxEntry[];
  cursorKey: string;
  sourceKey?: string;
}): Promise<{ appliedEntries: number; lastVersionstamp?: string }> => {
  const { adapter, entries, cursorKey } = options;
  const sourceKey = options.sourceKey ?? cursorKey;

  let appliedEntries = 0;
  let lastVersionstamp: string | undefined;

  for (const entry of entries) {
    const mutations = decodeEntryMutations(entry);
    const resolvedMutations = entry.refMap
      ? mutations.map((mutation) => resolveOutboxRefs(mutation, entry.refMap ?? {}))
      : mutations;

    const result = await adapter.applyOutboxEntry({
      sourceKey,
      versionstamp: entry.versionstamp,
      uowId: entry.uowId,
      mutations: resolvedMutations,
    });

    lastVersionstamp = entry.versionstamp;
    await adapter.setMeta(cursorKey, entry.versionstamp);

    if (result.applied) {
      appliedEntries += 1;
    }
  }

  return { appliedEntries, lastVersionstamp };
};

export const rebaseSubmitQueue = async (options: {
  adapter: LofiAdapter;
  entries: OutboxEntry[];
  cursorKey: string;
  confirmedCommandIds: string[];
  queue: LofiSubmitCommand[];
  overlay?: {
    rebuild: (options?: { queue?: LofiSubmitCommand[]; schemaNames?: string[] }) => Promise<void>;
  };
}): Promise<RebaseResult> => {
  const { adapter, entries, cursorKey, confirmedCommandIds, queue, overlay } = options;

  const { appliedEntries, lastVersionstamp } = await applyOutboxEntries({
    adapter,
    entries,
    cursorKey,
  });

  const confirmedSet = new Set(confirmedCommandIds);
  const remaining: LofiSubmitCommand[] = [];

  for (const command of queue) {
    if (confirmedSet.has(command.id)) {
      continue;
    }
    remaining.push(command);
  }

  if (overlay) {
    await overlay.rebuild({ queue: remaining });
  }

  return { appliedEntries, lastVersionstamp, queue: remaining };
};
