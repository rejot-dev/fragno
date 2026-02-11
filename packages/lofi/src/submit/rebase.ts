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
  return payload.mutations.map((mutation) => {
    if (mutation.op === "create") {
      return {
        op: "create",
        schema: mutation.schema,
        table: mutation.table,
        externalId: mutation.externalId,
        values: mutation.values,
        versionstamp: mutation.versionstamp,
      };
    }

    if (mutation.op === "update") {
      return {
        op: "update",
        schema: mutation.schema,
        table: mutation.table,
        externalId: mutation.externalId,
        set: mutation.set,
        versionstamp: mutation.versionstamp,
      };
    }

    return {
      op: "delete",
      schema: mutation.schema,
      table: mutation.table,
      externalId: mutation.externalId,
      versionstamp: mutation.versionstamp,
    };
  });
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
