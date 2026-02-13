import type { AnySchema } from "@fragno-dev/db/schema";
import type { MutationOperation } from "@fragno-dev/db/unit-of-work";
import type { LofiMutation } from "../types";
import { stripShardField } from "../system-columns";

export function outboxMutationsToUowOperations(
  mutations: LofiMutation[],
  schemaMap: Record<string, AnySchema>,
): MutationOperation<AnySchema>[] {
  const shardMetadata = { shard: null, shardScope: "scoped" as const };

  return mutations.map((mutation) => {
    const schema = schemaMap[mutation.schema];
    if (!schema) {
      throw new Error(`Unknown outbox schema: ${mutation.schema}`);
    }

    if (mutation.op === "create") {
      return {
        type: "create",
        schema,
        table: mutation.table,
        values: stripShardField(mutation.values) ?? mutation.values,
        generatedExternalId: mutation.externalId,
        ...shardMetadata,
      };
    }

    if (mutation.op === "update") {
      return {
        type: "update",
        schema,
        table: mutation.table,
        id: mutation.externalId,
        checkVersion: false,
        set: stripShardField(mutation.set) ?? mutation.set,
        ...shardMetadata,
      };
    }

    return {
      type: "delete",
      schema,
      table: mutation.table,
      id: mutation.externalId,
      checkVersion: false,
      ...shardMetadata,
    };
  });
}
