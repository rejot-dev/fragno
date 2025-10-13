import type { CompiledQuery } from "kysely";
import type { AnySchema, FragnoId } from "../../schema/create";
import type {
  CompiledMutation,
  MutationOperation,
  RetrievalOperation,
  UOWCompiler,
} from "../../query/unit-of-work";
import type { KyselyConfig } from "./kysely-adapter";
import { createKyselyQueryCompiler } from "./kysely-query-compiler";
import { buildCondition } from "../../query/condition-builder";

/**
 * Create a Kysely-specific Unit of Work compiler
 *
 * This compiler translates UOW operations into Kysely CompiledQuery objects
 * that can be executed as a batch/transaction.
 *
 * @param schema - The database schema
 * @param config - Kysely configuration
 * @returns A UOWCompiler instance for Kysely
 */
export function createKyselyUOWCompiler<TSchema extends AnySchema>(
  schema: TSchema,
  config: KyselyConfig,
): UOWCompiler<TSchema, CompiledQuery> {
  const queryCompiler = createKyselyQueryCompiler(schema, config);

  function toTable(name: unknown) {
    const table = schema.tables[name as string];
    if (!table) {
      throw new Error(`Invalid table name ${name}.`);
    }
    return table;
  }

  return {
    compileRetrievalOperation(op: RetrievalOperation<TSchema>): CompiledQuery | null {
      switch (op.type) {
        case "find": {
          // Map UOW FindOptions to query compiler's FindManyOptions
          // The useIndex field is metadata for optimization and not needed for compilation
          const { useIndex: _useIndex, orderByIndex, ...findManyOptions } = op.options;

          // Convert orderByIndex to orderBy format
          let orderBy: [string, "asc" | "desc"][] | undefined;
          if (orderByIndex) {
            const index = op.table.indexes[orderByIndex.indexName];

            if (!index) {
              // If _primary index doesn't exist, fall back to internal ID column
              // (which is the actual primary key and maintains insertion order)
              if (orderByIndex.indexName === "_primary") {
                orderBy = [[op.table.getIdColumn().ormName, orderByIndex.direction]];
              } else {
                throw new Error(
                  `Index "${orderByIndex.indexName}" not found on table "${op.table.name}"`,
                );
              }
            } else {
              // Order by all columns in the index with the specified direction
              orderBy = index.columns.map((col: { ormName: string }) => [
                col.ormName,
                orderByIndex.direction,
              ]);
            }
          }

          return queryCompiler.findMany(op.table.name, {
            ...findManyOptions,
            orderBy,
          });
        }
      }
    },

    compileMutationOperation(
      op: MutationOperation<TSchema>,
    ): CompiledMutation<CompiledQuery> | null {
      switch (op.type) {
        case "create":
          return {
            query: queryCompiler.create(op.table, op.values),
            expectedAffectedRows: null, // creates don't need affected row checks
          };

        case "update": {
          const table = toTable(op.table);
          const idColumn = table.getIdColumn();
          const versionColumn = table.getVersionColumn();

          const externalId = typeof op.id === "string" ? op.id : op.id.externalId;
          const versionToCheck = getVersionToCheck(op.id, op.checkVersion);

          // Build WHERE clause that filters by ID and optionally by version
          const whereClause =
            versionToCheck !== undefined
              ? () =>
                  buildCondition(table.columns, (eb) =>
                    eb.and(
                      eb(idColumn.ormName, "=", externalId),
                      eb(versionColumn.ormName, "=", versionToCheck),
                    ),
                  )
              : () => buildCondition(table.columns, (eb) => eb(idColumn.ormName, "=", externalId));

          const query = queryCompiler.updateMany(op.table, {
            where: whereClause,
            set: op.set,
          });

          return query
            ? {
                query,
                expectedAffectedRows: op.checkVersion ? 1 : null,
              }
            : null;
        }

        case "delete": {
          const table = toTable(op.table);
          const idColumn = table.getIdColumn();
          const versionColumn = table.getVersionColumn();

          // Extract external ID based on whether op.id is FragnoId or string
          const externalId = typeof op.id === "string" ? op.id : op.id.externalId;
          const versionToCheck = getVersionToCheck(op.id, op.checkVersion);

          // Build WHERE clause that filters by ID and optionally by version
          const whereClause =
            versionToCheck !== undefined
              ? () =>
                  buildCondition(table.columns, (eb) =>
                    eb.and(
                      eb(idColumn.ormName, "=", externalId),
                      eb(versionColumn.ormName, "=", versionToCheck),
                    ),
                  )
              : () => buildCondition(table.columns, (eb) => eb(idColumn.ormName, "=", externalId));

          const query = queryCompiler.deleteMany(op.table, {
            where: whereClause,
          });

          return query
            ? {
                query,
                expectedAffectedRows: op.checkVersion ? 1 : null,
              }
            : null;
        }
      }
    },
  };
}

/**
 * Get the version to check for a given ID and checkVersion flag.
 * @returns The version to check or undefined if no check is required.
 * @throws Error if the ID is a string and checkVersion is true.
 */
function getVersionToCheck(id: FragnoId | string, checkVersion: boolean): number | undefined {
  if (!checkVersion) {
    return undefined;
  }

  if (typeof id === "string") {
    throw new Error(
      `Cannot use checkVersion with a string ID. Version checking requires a FragnoId with version information.`,
    );
  }

  return id.version;
}
