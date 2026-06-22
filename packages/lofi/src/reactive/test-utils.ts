import { column, idColumn, schema } from "@fragno-dev/db/schema";
import superjson from "superjson";

import type { OutboxEntry } from "@fragno-dev/db";

import type { LofiMutation } from "../types";

export const reactiveTestSchema = schema("app", (s) =>
  s.addTable("users", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("name", column("string"))
      .createIndex("idx_name", ["name"]),
  ),
);

export const createOutboxEntry = (options: {
  versionstamp: string;
  uowId?: string;
  mutations: LofiMutation[];
}): OutboxEntry =>
  ({
    versionstamp: options.versionstamp,
    uowId: options.uowId ?? `uow-${options.versionstamp}`,
    payload: superjson.serialize({
      version: 1,
      mutations: options.mutations,
    }),
  }) as OutboxEntry;

export const createUserMutation = (id: string, name: string, versionstamp = `v-${id}`) => ({
  op: "create" as const,
  schema: reactiveTestSchema.name,
  table: "users",
  externalId: id,
  values: { name },
  versionstamp,
});

export const waitFor = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for predicate.");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};
