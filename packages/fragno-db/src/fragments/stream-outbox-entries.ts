import superjson, { type SuperJSONResult } from "superjson";

import type { DatabaseAdapter } from "../adapters/adapters";
import { assembleOutboxEntry } from "../outbox/assemble-outbox-entry";
import type { OutboxEntry, OutboxOperation } from "../outbox/outbox";
import { internalSchema } from "./internal-fragment.schema";

/** Parameters for one bounded poll of the outbox stream. */
export type OutboxStreamOptions = {
  afterVersionstamp: string | undefined;
  limit: number;
};

type OutboxEntryWithMutations = Omit<OutboxEntry, "payload"> & {
  mutations: Array<{ payload: SuperJSONResult }>;
};

/** Streams an indexed outbox page, including each entry's ordered mutations, one entry at a time. */
export async function* streamOutboxEntries(
  adapter: DatabaseAdapter<unknown>,
  { afterVersionstamp, limit }: OutboxStreamOptions,
): AsyncIterableIterator<OutboxEntry> {
  const afterValue = afterVersionstamp?.toLowerCase();
  const uow = adapter.createUnitOfWork(internalSchema, null, "internal.outbox.stream");
  uow.find("fragno_db_outbox", (b) => {
    const entries = afterValue
      ? b.whereIndex("idx_outbox_versionstamp", (eb) => eb("versionstamp", ">", afterValue))
      : b.whereIndex("idx_outbox_versionstamp");
    return entries
      .orderByIndex("idx_outbox_versionstamp", "asc")
      .pageSize(limit)
      .joinMany("mutations", "fragno_db_outbox_mutations", (mutations) =>
        mutations
          .onIndex("idx_outbox_mutations_entry_order", (eb) =>
            eb("entryVersionstamp", "=", eb.parent("versionstamp")),
          )
          .orderByIndex("idx_outbox_mutations_entry_order", "asc")
          .select(["payload"]),
      );
  });
  const [operation] = uow.getRetrievalOperations();
  if (!operation) {
    throw new Error("Outbox stream find operation was not recorded.");
  }

  for await (const result of adapter.streamRetrieval(operation)) {
    const entry = result as OutboxEntryWithMutations;
    const operations = entry.mutations.map((mutation) =>
      superjson.deserialize<OutboxOperation>(mutation.payload),
    );
    yield assembleOutboxEntry({ ...entry, refMap: entry.refMap }, operations);
  }
}
