import { FragnoId, type AnySchema } from "@fragno-dev/db/schema";
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
      const checkVersion = mutation.checkVersion;
      const hasCheckVersion = typeof checkVersion === "number";
      return {
        type: "update",
        schema,
        table: mutation.table,
        id: hasCheckVersion
          ? FragnoId.fromExternal(mutation.externalId, checkVersion)
          : mutation.externalId,
        checkVersion: hasCheckVersion,
        set: mutation.set,
      };
    }

    if (mutation.op === "upsert") {
      const checkVersion = mutation.checkVersion;
      const hasCheckVersion = typeof checkVersion === "number";
      return {
        type: "upsert",
        schema,
        table: mutation.table,
        id: hasCheckVersion
          ? FragnoId.fromExternal(mutation.externalId, checkVersion)
          : mutation.externalId,
        checkVersion: hasCheckVersion,
        conflict: mutation.conflict ?? "update",
        values: mutation.values,
        generatedExternalId: mutation.externalId,
      };
    }

    const checkVersion = mutation.checkVersion;
    const hasCheckVersion = typeof checkVersion === "number";
    return {
      type: "delete",
      schema,
      table: mutation.table,
      id: hasCheckVersion
        ? FragnoId.fromExternal(mutation.externalId, checkVersion)
        : mutation.externalId,
      checkVersion: hasCheckVersion,
    };
  });
}
