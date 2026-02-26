import type { AnySchema } from "@fragno-dev/db/schema";
import type { MutationOperation } from "@fragno-dev/db/unit-of-work";
import type { LofiMutation } from "../types";

export function outboxMutationsToUowOperations(
  mutations: LofiMutation[],
  schemaMap: Record<string, AnySchema>,
): MutationOperation<AnySchema>[] {
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
        values: mutation.values,
        generatedExternalId: mutation.externalId,
      };
    }

    if (mutation.op === "update") {
      return {
        type: "update",
        schema,
        table: mutation.table,
        id: mutation.externalId,
        checkVersion: false,
        set: mutation.set,
      };
    }

    if (mutation.op === "upsert") {
      return {
        type: "upsert",
        schema,
        table: mutation.table,
        values: mutation.values,
        generatedExternalId: mutation.externalId,
      };
    }

    return {
      type: "delete",
      schema,
      table: mutation.table,
      id: mutation.externalId,
      checkVersion: false,
    };
  });
}
