import type { AnySchema } from "@fragno-dev/db/schema";
import type { MutationOperation } from "@fragno-dev/db/unit-of-work";

import type { LofiMutation } from "../types";

type UowOperationsToLofiMutationsOptions = {
  versionstamp?: string | ((operation: MutationOperation<AnySchema>, index: number) => string);
};

const mutationIdToExternalId = (id: string | { externalId: string }): string =>
  typeof id === "string" ? id : id.externalId;

const resolveVersionstamp = (
  operation: MutationOperation<AnySchema>,
  index: number,
  options?: UowOperationsToLofiMutationsOptions,
): string =>
  typeof options?.versionstamp === "function"
    ? options.versionstamp(operation, index)
    : (options?.versionstamp ?? `uow-${(index + 1).toString().padStart(3, "0")}`);

export function uowOperationsToLofiMutations(
  operations: readonly MutationOperation<AnySchema>[],
  options?: UowOperationsToLofiMutationsOptions,
): LofiMutation[] {
  return operations.flatMap((operation, index): LofiMutation[] => {
    if (operation.type === "check") {
      return [];
    }

    const versionstamp = resolveVersionstamp(operation, index, options);

    if (operation.type === "create") {
      return [
        {
          op: "create",
          schema: operation.schema.name,
          table: operation.table,
          externalId: operation.generatedExternalId,
          values: operation.values as Record<string, unknown>,
          versionstamp,
        },
      ];
    }

    if (operation.type === "update") {
      return [
        {
          op: "update",
          schema: operation.schema.name,
          table: operation.table,
          externalId: mutationIdToExternalId(operation.id),
          set: operation.set as Record<string, unknown>,
          versionstamp,
        },
      ];
    }

    return [
      {
        op: "delete",
        schema: operation.schema.name,
        table: operation.table,
        externalId: mutationIdToExternalId(operation.id),
        versionstamp,
      },
    ];
  });
}

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

    return {
      type: "delete",
      schema,
      table: mutation.table,
      id: mutation.externalId,
      checkVersion: false,
    };
  });
}
