import type { MutationOperation } from "@fragno-dev/db/mutation-recorder";
import type { AnySchema } from "@fragno-dev/db/schema";

import { resolveMutations } from "../query/mutation-values";
import type { LofiMutation } from "../types";

type UowOperationsToLofiMutationsOptions = {
  versionstamp?: string | ((operation: MutationOperation<AnySchema>, index: number) => string);
  /** Materializes DbNow values using this authoritative timestamp. */
  now?: Date;
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

const fillCreateDbNowDefaults = (
  operation: Extract<MutationOperation<AnySchema>, { type: "create" }>,
): Record<string, unknown> => {
  const values = { ...(operation.values as Record<string, unknown>) };
  const table = operation.schema.tables[operation.table];

  for (const [key, column] of Object.entries(table?.columns ?? {})) {
    if (column.role === "internal-id" || Object.prototype.hasOwnProperty.call(values, key)) {
      continue;
    }

    if (column.default && "dbSpecial" in column.default && column.default.dbSpecial === "now") {
      values[key] = { tag: "db-now" };
    }
  }

  return values;
};

export function uowOperationsToLofiMutations(
  operations: readonly MutationOperation<AnySchema>[],
  options?: UowOperationsToLofiMutationsOptions,
): LofiMutation[] {
  const mutations: LofiMutation[] = [];
  // Existing callbacks observe source-operation indices; expanded deletes use a disjoint range.
  let expandedBulkDeleteIndex = operations.length;

  for (const [operationIndex, operation] of operations.entries()) {
    if (operation.type === "check" || operation.type === "check-absent") {
      continue;
    }

    if (operation.type === "delete-many") {
      for (const id of operation.ids) {
        mutations.push({
          op: "delete",
          schema: operation.schema.name,
          table: operation.table,
          externalId: mutationIdToExternalId(id),
          versionstamp: resolveVersionstamp(operation, expandedBulkDeleteIndex, options),
        });
        expandedBulkDeleteIndex += 1;
      }
      continue;
    }

    const versionstamp = resolveVersionstamp(operation, operationIndex, options);
    if (operation.type === "create") {
      mutations.push({
        op: "create",
        schema: operation.schema.name,
        table: operation.table,
        externalId: operation.generatedExternalId,
        values: fillCreateDbNowDefaults(operation),
        versionstamp,
      });
      continue;
    }

    if (operation.type === "update") {
      mutations.push({
        op: "update",
        schema: operation.schema.name,
        table: operation.table,
        externalId: mutationIdToExternalId(operation.id),
        set: operation.set as Record<string, unknown>,
        versionstamp,
      });
      continue;
    }

    mutations.push({
      op: "delete",
      schema: operation.schema.name,
      table: operation.table,
      externalId: mutationIdToExternalId(operation.id),
      versionstamp,
    });
  }

  return options?.now ? resolveMutations(mutations, options.now.getTime()) : mutations;
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
