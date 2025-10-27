import type { CompiledQuery } from "kysely";
import type { AnyColumn, AnySchema, FragnoId } from "../../schema/create";
import type {
  CompiledMutation,
  MutationOperation,
  RetrievalOperation,
  UOWCompiler,
} from "../../query/unit-of-work";
import type { KyselyConfig } from "./kysely-adapter";
import { createKyselyQueryCompiler } from "./kysely-query-compiler";
import { createKyselyQueryBuilder } from "./kysely-query-builder";
import { buildCondition, type Condition } from "../../query/condition-builder";
import { decodeCursor, serializeCursorValues } from "../../query/cursor";
import type { AnySelectClause } from "../../query/query";
import type { TableNameMapper } from "./kysely-shared";

/**
 * Create a Kysely-specific Unit of Work compiler
 *
 * This compiler translates UOW operations into Kysely CompiledQuery objects
 * that can be executed as a batch/transaction.
 *
 * @param schema - The database schema
 * @param config - Kysely configuration
 * @param mapper - Optional table name mapper for namespace prefixing
 * @returns A UOWCompiler instance for Kysely
 */
export function createKyselyUOWCompiler<TSchema extends AnySchema>(
  schema: TSchema,
  config: KyselyConfig,
  mapper?: TableNameMapper,
): UOWCompiler<TSchema, CompiledQuery> {
  const queryCompiler = createKyselyQueryCompiler(schema, config, mapper);
  const { db, provider } = config;
  // Resolve the db instance if it's a function
  const kysely = typeof db === "function" ? db() : db;
  const queryBuilder = createKyselyQueryBuilder(kysely, provider, mapper);

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
        case "count": {
          return queryCompiler.count(op.table.name, {
            where: op.options.where,
          });
        }

        case "find": {
          // Map UOW FindOptions to query compiler's FindManyOptions
          const {
            useIndex: _useIndex,
            orderByIndex,
            joins: join,
            after,
            before,
            pageSize,
            ...findManyOptions
          } = op.options;

          // Get index columns for ordering and cursor pagination
          let indexColumns: AnyColumn[] = [];
          let orderDirection: "asc" | "desc" = "asc";

          if (orderByIndex) {
            const index = op.table.indexes[orderByIndex.indexName];
            orderDirection = orderByIndex.direction;

            if (!index) {
              // If _primary index doesn't exist, fall back to internal ID column
              // (which is the actual primary key and maintains insertion order)
              if (orderByIndex.indexName === "_primary") {
                indexColumns = [op.table.getIdColumn()];
              } else {
                throw new Error(
                  `Index "${orderByIndex.indexName}" not found on table "${op.table.name}"`,
                );
              }
            } else {
              // Order by all columns in the index with the specified direction
              indexColumns = index.columns;
            }
          }

          // Convert orderByIndex to orderBy format
          let orderBy: [AnyColumn, "asc" | "desc"][] | undefined;
          if (indexColumns.length > 0) {
            orderBy = indexColumns.map((col) => [col, orderDirection]);
          }

          // Handle cursor pagination - build a cursor condition
          let cursorCondition: Condition | undefined;

          if ((after || before) && indexColumns.length > 0) {
            const cursor = after || before;
            const cursorData = decodeCursor(cursor!);
            const serializedValues = serializeCursorValues(cursorData, indexColumns, provider);

            // Build tuple comparison for cursor pagination
            // For "after" with "asc": (col1, col2, ...) > (val1, val2, ...)
            // For "before" with "desc": reverse the comparison
            const isAfter = !!after;
            const useGreaterThan =
              (isAfter && orderDirection === "asc") || (!isAfter && orderDirection === "desc");

            if (indexColumns.length === 1) {
              // Simple single-column case
              const col = indexColumns[0]!;
              const val = serializedValues[col.ormName];
              const operator = useGreaterThan ? ">" : "<";
              cursorCondition = {
                type: "compare",
                a: col,
                operator,
                b: val,
              };
            } else {
              // Multi-column tuple comparison - not yet supported for Kysely
              throw new Error(
                "Multi-column cursor pagination is not yet supported in Kysely Unit of Work implementation",
              );
            }
          }

          // Combine user where clause with cursor condition
          let combinedWhere: Condition | undefined;
          if (findManyOptions.where) {
            const whereResult = buildCondition(op.table.columns, findManyOptions.where);
            if (whereResult === true) {
              combinedWhere = undefined;
            } else if (whereResult === false) {
              return null;
            } else {
              combinedWhere = whereResult;
            }
          }

          if (cursorCondition) {
            if (combinedWhere) {
              combinedWhere = {
                type: "and",
                items: [combinedWhere, cursorCondition],
              };
            } else {
              combinedWhere = cursorCondition;
            }
          }

          // When we have joins or need to bypass buildFindOptions, use queryBuilder directly
          if (join && join.length > 0) {
            return queryBuilder.findMany(op.table, {
              // Safe cast: select from UOW matches SimplifyFindOptions requirement
              select: (findManyOptions.select ?? true) as AnySelectClause,
              where: combinedWhere,
              orderBy,
              limit: pageSize,
              join,
            });
          }

          return queryCompiler.findMany(op.table.name, {
            ...findManyOptions,
            where: combinedWhere ? () => combinedWhere! : undefined,
            orderBy: orderBy?.map(([col, dir]) => [col.ormName, dir]),
            limit: pageSize,
          });
        }
      }
    },

    compileMutationOperation(
      op: MutationOperation<TSchema>,
    ): CompiledMutation<CompiledQuery> | null {
      switch (op.type) {
        case "create":
          // queryCompiler.create() calls encodeValues() which handles runtime defaults
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
