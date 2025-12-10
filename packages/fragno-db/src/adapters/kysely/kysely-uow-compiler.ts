import { type CompiledQuery, sql } from "kysely";
import type { AnyColumn, AnySchema, FragnoId } from "../../schema/create";
import type {
  CompiledMutation,
  MutationOperation,
  RetrievalOperation,
  UOWCompiler,
} from "../../query/unit-of-work";
import { createKyselyQueryBuilder, buildWhere } from "./kysely-query-builder";
import { buildCondition, type Condition } from "../../query/condition-builder";
import { decodeCursor, serializeCursorValues } from "../../query/cursor";
import type { AnySelectClause } from "../../query/query";
import { createKysely } from "./kysely-shared";
import { createTableNameMapper, type TableNameMapper } from "../shared/table-name-mapper";
import type { SQLProvider } from "../../shared/providers";
import { buildFindOptions } from "../../query/orm/orm";

/**
 * Create a Kysely-specific Unit of Work compiler
 *
 * This compiler translates UOW operations into Kysely CompiledQuery objects
 * that can be executed as a batch/transaction.
 *
 * @param pool - Connection pool for acquiring database connections
 * @param provider - SQL provider (postgresql, mysql, sqlite, etc.)
 * @param mapperFactory - Optional factory function to create mappers for namespaces (receives undefined for non-namespaced operations)
 * @returns A UOWCompiler instance for Kysely
 */
export function createKyselyUOWCompiler(
  provider: SQLProvider,
  mapperFactory?: (namespace: string | undefined) => TableNameMapper | undefined,
): UOWCompiler<CompiledQuery> {
  // Get kysely instance for query building (compilation doesn't execute, just builds SQL)
  const kysely = createKysely(provider);

  /**
   * Get the mapper for a specific operation
   */
  function getMapperForOperation(namespace: string | undefined): TableNameMapper | undefined {
    return mapperFactory
      ? mapperFactory(namespace)
      : namespace
        ? createTableNameMapper(namespace)
        : undefined;
  }

  function getQueryBuilder(namespace: string | undefined) {
    const opMapper = getMapperForOperation(namespace);
    return createKyselyQueryBuilder(kysely, provider, opMapper);
  }

  function toTable(schema: AnySchema, name: unknown) {
    const table = schema.tables[name as string];
    if (!table) {
      throw new Error(`Invalid table name ${name}.`);
    }
    return table;
  }

  return {
    compileRetrievalOperation(op: RetrievalOperation<AnySchema>): CompiledQuery | null {
      const queryBuilder = getQueryBuilder(op.namespace);

      switch (op.type) {
        case "count": {
          let conditions = op.options.where
            ? buildCondition(op.table.columns, op.options.where)
            : undefined;
          if (conditions === true) {
            conditions = undefined;
          }
          if (conditions === false) {
            return null;
          }

          return queryBuilder.count(op.table, { where: conditions });
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
            // Decode cursor if it's a string, otherwise use it as-is
            const cursorObj = typeof cursor === "string" ? decodeCursor(cursor!) : cursor!;
            const serializedValues = serializeCursorValues(cursorObj, indexColumns, provider);

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

          // For cursor pagination, fetch one extra item to determine if there's a next page
          // Only apply this when using the high-level findWithCursor() API (op.withCursor === true)
          const effectiveLimit = pageSize && op.withCursor ? pageSize + 1 : pageSize;

          // When we have joins, use the query builder directly
          if (join && join.length > 0) {
            return queryBuilder.findMany(op.table, {
              // Safe cast: select from UOW matches SimplifyFindOptions requirement
              select: (findManyOptions.select ?? true) as AnySelectClause,
              where: combinedWhere,
              orderBy,
              limit: effectiveLimit,
              join,
            });
          }

          // Otherwise, use buildFindOptions to process the query options
          const compiledOptions = buildFindOptions(op.table, {
            ...findManyOptions,
            where: combinedWhere ? () => combinedWhere! : undefined,
            orderBy: orderBy?.map(([col, dir]) => [col.ormName, dir]),
            limit: effectiveLimit,
          });

          if (compiledOptions === false) {
            return null;
          }

          return queryBuilder.findMany(op.table, compiledOptions);
        }
      }
    },

    compileMutationOperation(
      op: MutationOperation<AnySchema>,
    ): CompiledMutation<CompiledQuery> | null {
      const queryBuilder = getQueryBuilder(op.namespace);

      switch (op.type) {
        case "create": {
          const table = toTable(op.schema, op.table);
          // queryBuilder.create() calls encodeValues() which handles runtime defaults
          return {
            query: queryBuilder.create(table, op.values),
            expectedAffectedRows: null, // creates don't need affected row checks
            expectedReturnedRows: null,
          };
        }

        case "update": {
          const table = toTable(op.schema, op.table);
          const idColumn = table.getIdColumn();
          const versionColumn = table.getVersionColumn();

          const externalId = typeof op.id === "string" ? op.id : op.id.externalId;
          const versionToCheck = getVersionToCheck(op.id, op.checkVersion);

          // Build WHERE clause that filters by ID and optionally by version
          const conditionsResult =
            versionToCheck !== undefined
              ? buildCondition(table.columns, (eb) =>
                  eb.and(
                    eb(idColumn.ormName, "=", externalId),
                    eb(versionColumn.ormName, "=", versionToCheck),
                  ),
                )
              : buildCondition(table.columns, (eb) => eb(idColumn.ormName, "=", externalId));

          if (conditionsResult === false) {
            return null;
          }

          const conditions: Condition | undefined =
            conditionsResult === true ? undefined : conditionsResult;

          const query = queryBuilder.updateMany(table, {
            set: op.set,
            where: conditions,
          });

          return {
            query,
            expectedAffectedRows: op.checkVersion ? 1 : null,
            expectedReturnedRows: null,
          };
        }

        case "delete": {
          const table = toTable(op.schema, op.table);
          const idColumn = table.getIdColumn();
          const versionColumn = table.getVersionColumn();

          // Extract external ID based on whether op.id is FragnoId or string
          const externalId = typeof op.id === "string" ? op.id : op.id.externalId;
          const versionToCheck = getVersionToCheck(op.id, op.checkVersion);

          // Build WHERE clause that filters by ID and optionally by version
          const conditionsResult =
            versionToCheck !== undefined
              ? buildCondition(table.columns, (eb) =>
                  eb.and(
                    eb(idColumn.ormName, "=", externalId),
                    eb(versionColumn.ormName, "=", versionToCheck),
                  ),
                )
              : buildCondition(table.columns, (eb) => eb(idColumn.ormName, "=", externalId));

          if (conditionsResult === false) {
            return null;
          }

          const conditions: Condition | undefined =
            conditionsResult === true ? undefined : conditionsResult;

          const query = queryBuilder.deleteMany(table, {
            where: conditions,
          });

          return {
            query,
            expectedAffectedRows: op.checkVersion ? 1 : null,
            expectedReturnedRows: null,
          };
        }

        case "check": {
          const table = toTable(op.schema, op.table);
          const idColumn = table.getIdColumn();
          const versionColumn = table.getVersionColumn();
          const mapper = getMapperForOperation(op.namespace);
          const tableName = mapper ? mapper.toPhysical(op.table) : op.table;

          const externalId = op.id.externalId;
          const version = op.id.version;

          // Build a SELECT 1 query to check if the row exists with the correct version
          const condition = buildCondition(table.columns, (eb) =>
            eb.and(eb(idColumn.ormName, "=", externalId), eb(versionColumn.ormName, "=", version)),
          );

          let query = kysely.selectFrom(tableName).select(sql<number>`1`.as("exists"));

          if (typeof condition === "boolean") {
            throw new Error("Condition is a boolean, but should be a condition object.");
          }

          query = query.where((eb) => buildWhere(condition, eb, provider, mapper, table)).limit(1);

          return {
            query: query.compile(),
            expectedAffectedRows: null,
            expectedReturnedRows: 1, // Check that exactly 1 row was returned
          };
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
