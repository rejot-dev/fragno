import * as Drizzle from "drizzle-orm";
import type { AnyColumn, AnySchema, AnyTable, FragnoId } from "../../schema/create";
import { Column } from "../../schema/create";
import type {
  CompiledMutation,
  MutationOperation,
  RetrievalOperation,
  UOWCompiler,
} from "../../query/unit-of-work";
import { buildCondition, type Condition } from "../../query/condition-builder";
import { type ColumnType, type TableType, parseDrizzle, type DBType } from "./shared";
import { createTableNameMapper, type TableNameMapper } from "../shared/table-name-mapper";
import { encodeValues, ReferenceSubquery } from "../../query/result-transform";
import { serialize } from "../../schema/serialize";
import { decodeCursor, serializeCursorValues } from "../../query/cursor";
import type { CompiledJoin } from "../../query/orm/orm";
import { getOrderedJoinColumns } from "./join-column-utils";
import type { ConnectionPool } from "../../shared/connection-pool";

export type DrizzleCompiledQuery = {
  sql: string;
  params: unknown[];
};

/**
 * Create a Drizzle-specific Unit of Work compiler
 *
 * This compiler translates UOW operations into Drizzle query functions
 * that can be executed as a batch/transaction.
 *
 * @param pool - Connection pool for acquiring database connections
 * @param provider - SQL provider (sqlite, mysql, postgresql)
 * @param mapper - Optional table name mapper for namespace prefixing (fallback for operations without explicit namespace)
 * @returns A UOWCompiler instance for Drizzle
 */
export function createDrizzleUOWCompiler(
  pool: ConnectionPool<DBType>,
  provider: "sqlite" | "mysql" | "postgresql",
  mapper?: TableNameMapper,
): UOWCompiler<DrizzleCompiledQuery> {
  // Get db synchronously for compilation (doesn't execute, just builds SQL)
  // TODO: We don't even need a Drizzle instance with a db client attached here. `drizzle({ schema })` is enough.
  const dbRaw = pool.getDatabaseSync();
  const [db, drizzleTables] = parseDrizzle(dbRaw);

  /**
   * Get the mapper for a specific operation
   * Uses operation's namespace if provided, otherwise falls back to the default mapper
   */
  function getMapperForOperation(namespace: string | undefined): TableNameMapper | undefined {
    if (namespace) {
      return createTableNameMapper(namespace, true);
    }
    return mapper;
  }

  /**
   * Convert a Fragno table to a Drizzle table
   * @throws Error if table is not found in Drizzle schema
   */
  function toDrizzleTable(table: AnyTable, namespace: string | undefined): TableType {
    // Get the mapper for this operation's namespace
    const opMapper = getMapperForOperation(namespace);

    // Map logical table name to physical table name using the operation-specific mapper
    const physicalTableName = opMapper ? opMapper.toPhysical(table.ormName) : table.ormName;
    const out = drizzleTables[physicalTableName];
    if (out) {
      return out;
    }

    throw new Error(
      `[Drizzle] Unknown table name ${physicalTableName} (logical: ${table.ormName}), is it included in your Drizzle schema?`,
    );
  }

  /**
   * Convert a Fragno column to a Drizzle column
   * @throws Error if column is not found in Drizzle table
   */
  function toDrizzleColumn(
    schema: AnySchema,
    namespace: string | undefined,
    col: AnyColumn,
  ): ColumnType {
    const fragnoTable = schema.tables[col.tableName];
    if (!fragnoTable) {
      throw new Error(`[Drizzle] Unknown table ${col.tableName} for column ${col.ormName}.`);
    }

    const table = toDrizzleTable(fragnoTable, namespace);
    const out = table[col.ormName];
    if (out) {
      return out;
    }

    throw new Error(`[Drizzle] Unknown column name ${col.ormName} in ${fragnoTable.ormName}.`);
  }

  /**
   * Build a WHERE clause from a condition using Drizzle's query builder
   */
  function buildWhere(
    schema: AnySchema,
    namespace: string | undefined,
    condition: Condition,
  ): Drizzle.SQL | undefined {
    if (condition.type === "compare") {
      const left = toDrizzleColumn(schema, namespace, condition.a);
      const op = condition.operator;
      let right = condition.b;
      if (right instanceof Column) {
        right = toDrizzleColumn(schema, namespace, right);
      } else {
        // Handle string references - convert external ID to internal ID via subquery
        if (condition.a.role === "reference" && typeof right === "string") {
          // Find the table that contains this column
          const table = Object.values(schema.tables).find((t) =>
            Object.values(t.columns).includes(condition.a),
          );
          if (table) {
            // Find relation that uses this column
            const relation = Object.values(table.relations).find((rel) =>
              rel.on.some(([localCol]) => localCol === condition.a.ormName),
            );
            if (relation) {
              const refTable = relation.table;
              const internalIdCol = refTable.getInternalIdColumn();
              const idCol = refTable.getIdColumn();
              const physicalTableName = mapper
                ? mapper.toPhysical(refTable.ormName)
                : refTable.ormName;

              // Build a SQL subquery using Drizzle's sql template
              right = Drizzle.sql`(select ${Drizzle.sql.identifier(internalIdCol.name)} from ${Drizzle.sql.identifier(physicalTableName)} where ${Drizzle.sql.identifier(idCol.name)} = ${right} limit 1)`;
            }
          }
        } else {
          // Serialize non-Column values (e.g., FragnoId -> string, Date -> number for SQLite)
          right = serialize(right, condition.a, provider);
        }
      }

      switch (op) {
        case "=":
          return Drizzle.eq(left, right);
        case "!=":
          return Drizzle.ne(left, right);
        case ">":
          return Drizzle.gt(left, right);
        case ">=":
          return Drizzle.gte(left, right);
        case "<":
          return Drizzle.lt(left, right);
        case "<=":
          return Drizzle.lte(left, right);
        case "in": {
          return Drizzle.inArray(left, right as never[]);
        }
        case "not in":
          return Drizzle.notInArray(left, right as never[]);
        case "is":
          return right === null ? Drizzle.isNull(left) : Drizzle.eq(left, right);
        case "is not":
          return right === null ? Drizzle.isNotNull(left) : Drizzle.ne(left, right);
        case "contains": {
          right =
            typeof right === "string" ? `%${right}%` : Drizzle.sql`concat('%', ${right}, '%')`;
          return Drizzle.like(left, right as string);
        }
        case "not contains": {
          right =
            typeof right === "string" ? `%${right}%` : Drizzle.sql`concat('%', ${right}, '%')`;
          return Drizzle.notLike(left, right as string);
        }
        case "ends with": {
          right = typeof right === "string" ? `%${right}` : Drizzle.sql`concat('%', ${right})`;
          return Drizzle.like(left, right as string);
        }
        case "not ends with": {
          right = typeof right === "string" ? `%${right}` : Drizzle.sql`concat('%', ${right})`;
          return Drizzle.notLike(left, right as string);
        }
        case "starts with": {
          right = typeof right === "string" ? `${right}%` : Drizzle.sql`concat(${right}, '%')`;
          return Drizzle.like(left, right as string);
        }
        case "not starts with": {
          right = typeof right === "string" ? `${right}%` : Drizzle.sql`concat(${right}, '%')`;
          return Drizzle.notLike(left, right as string);
        }

        default:
          throw new Error(`Unsupported operator: ${op}`);
      }
    }

    if (condition.type === "and") {
      return Drizzle.and(...condition.items.map((item) => buildWhere(schema, namespace, item)));
    }

    if (condition.type === "not") {
      const result = buildWhere(schema, namespace, condition.item);
      if (!result) {
        return;
      }

      return Drizzle.not(result);
    }

    return Drizzle.or(...condition.items.map((item) => buildWhere(schema, namespace, item)));
  }

  /**
   * Process reference subqueries in encoded values, converting them to Drizzle SQL subqueries
   */
  function processReferenceSubqueries(values: Record<string, unknown>): Record<string, unknown> {
    const processed: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(values)) {
      if (value instanceof ReferenceSubquery) {
        const refTable = value.referencedTable;
        const externalId = value.externalIdValue;
        const internalIdCol = refTable.getInternalIdColumn();
        const idCol = refTable.getIdColumn();

        // Map logical table name to physical table name using the mapper
        const physicalTableName = mapper ? mapper.toPhysical(refTable.ormName) : refTable.ormName;

        // Build a SQL subquery using Drizzle's sql template
        // This creates a subquery: (SELECT _internalId FROM table WHERE id = ? LIMIT 1)
        // Safe cast: we're building a SQL subquery that returns a single bigint value
        processed[key] =
          Drizzle.sql`(select ${Drizzle.sql.identifier(internalIdCol.name)} from ${Drizzle.sql.identifier(physicalTableName)} where ${Drizzle.sql.identifier(idCol.name)} = ${externalId} limit 1)`;
      } else {
        processed[key] = value;
      }
    }

    return processed;
  }

  /**
   * Get table from schema by name
   * @throws Error if table is not found in schema
   */
  function getTable(schema: AnySchema, name: unknown): AnyTable {
    const table = schema.tables[name as string];
    if (!table) {
      throw new Error(`Invalid table name ${name}.`);
    }
    return table;
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

  /**
   * Process joins recursively to support nested joins with orderBy and limit
   */
  function processJoins(
    schema: AnySchema,
    namespace: string | undefined,
    joins: CompiledJoin[],
  ): Record<string, Drizzle.DBQueryConfig<"many", boolean>> {
    const result: Record<string, Drizzle.DBQueryConfig<"many", boolean>> = {};

    for (const join of joins) {
      const { options, relation } = join;

      if (!options) {
        continue;
      }

      const targetTable = relation.table;
      const joinName = relation.name;

      // Build columns for this join using shared utility
      const selectOption = options.select === undefined ? true : options.select;
      const orderedColumns = getOrderedJoinColumns(targetTable, selectOption);
      const joinColumns: Record<string, boolean> = {};
      for (const colName of orderedColumns) {
        joinColumns[colName] = true;
      }

      // Build orderBy for this join
      let joinOrderBy: Drizzle.SQL[] | undefined;
      if (options.orderBy && options.orderBy.length > 0) {
        joinOrderBy = options.orderBy.map(([col, direction]) => {
          const drizzleCol = toDrizzleColumn(schema, namespace, col);
          return direction === "asc" ? Drizzle.asc(drizzleCol) : Drizzle.desc(drizzleCol);
        });
      }

      // Build WHERE clause for this join if provided
      let joinWhere: Drizzle.SQL | undefined;
      if (options.where) {
        joinWhere = buildWhere(schema, namespace, options.where);
      }

      // Build the join config
      const joinConfig: Drizzle.DBQueryConfig<"many", boolean> = {
        columns: joinColumns,
        orderBy: joinOrderBy,
        limit: options.limit,
        where: joinWhere,
      };

      // Recursively process nested joins
      if (options.join && options.join.length > 0) {
        joinConfig.with = processJoins(schema, namespace, options.join);
      }

      result[joinName] = joinConfig;
    }

    return result;
  }

  return {
    compileRetrievalOperation(op: RetrievalOperation<AnySchema>): DrizzleCompiledQuery | null {
      const schema = op.schema;
      switch (op.type) {
        case "count": {
          // Build WHERE clause
          let whereClause: Drizzle.SQL | undefined;
          if (op.options.where) {
            const condition = buildCondition(op.table.columns, op.options.where);
            if (condition === false) {
              // Never matches - return null
              return null;
            }
            if (condition !== true) {
              whereClause = buildWhere(schema, op.namespace, condition);
            }
          }

          const drizzleTable = toDrizzleTable(op.table, op.namespace);
          const query = db.select({ count: Drizzle.count() }).from(drizzleTable);

          const compiledQuery = whereClause ? query.where(whereClause).toSQL() : query.toSQL();
          return compiledQuery;
        }

        case "find": {
          const {
            useIndex: _useIndex,
            orderByIndex,
            joins,
            after,
            before,
            pageSize,
            ...findOptions
          } = op.options;

          // Get index columns for ordering and cursor pagination
          let indexColumns: AnyColumn[] = [];
          let orderDirection: "asc" | "desc" = "asc";

          if (orderByIndex) {
            const index = op.table.indexes[orderByIndex.indexName];
            orderDirection = orderByIndex.direction;

            if (!index) {
              // If _primary index doesn't exist, fall back to ID column
              if (orderByIndex.indexName === "_primary") {
                indexColumns = [op.table.getIdColumn()];
              } else {
                throw new Error(
                  `Index "${orderByIndex.indexName}" not found on table "${op.table.name}"`,
                );
              }
            } else {
              indexColumns = index.columns;
            }
          }

          // Convert orderByIndex to orderBy format
          let orderBy: Drizzle.SQL[] | undefined;
          if (indexColumns.length > 0) {
            orderBy = indexColumns.map((col) => {
              const drizzleCol = toDrizzleColumn(schema, op.namespace, col);
              return orderDirection === "asc" ? Drizzle.asc(drizzleCol) : Drizzle.desc(drizzleCol);
            });
          }

          // Build query configuration
          const columns: Record<string, boolean> = {};
          const select = findOptions.select;

          if (select === true || select === undefined) {
            for (const col of Object.values(op.table.columns)) {
              columns[col.ormName] = true;
            }
          } else {
            for (const k of select) {
              columns[op.table.columns[k].ormName] = true;
            }
            // Always include hidden columns (for FragnoId construction with internal ID and version)
            for (const col of Object.values(op.table.columns)) {
              if (col.isHidden && !columns[col.ormName]) {
                columns[col.ormName] = true;
              }
            }
          }

          // Build WHERE clause with cursor conditions
          const whereClauses: Drizzle.SQL[] = [];

          // Add user-defined where clause
          if (findOptions.where) {
            const condition = buildCondition(op.table.columns, findOptions.where);
            if (condition === false) {
              // Never matches - return null to indicate this query should be skipped
              return null;
            }
            if (condition !== true) {
              const clause = buildWhere(schema, op.namespace, condition);
              if (clause) {
                whereClauses.push(clause);
              }
            }
          }

          // Add cursor-based pagination conditions
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
              const col = toDrizzleColumn(schema, op.namespace, indexColumns[0]!);
              const val = serializedValues[indexColumns[0]!.ormName];
              whereClauses.push(useGreaterThan ? Drizzle.gt(col, val) : Drizzle.lt(col, val));
            } else {
              // Multi-column tuple comparison using SQL
              const drizzleCols = indexColumns.map((c) => toDrizzleColumn(schema, op.namespace, c));
              const vals = indexColumns.map((c) => serializedValues[c.ormName]);
              const operator = useGreaterThan ? ">" : "<";
              // Safe cast: building a SQL comparison expression for cursor pagination
              // Build the tuple comparison: (col1, col2) > (val1, val2)
              const colsSQL = Drizzle.sql.join(drizzleCols, Drizzle.sql.raw(", "));
              const valsSQL = Drizzle.sql.join(
                vals.map((v) => Drizzle.sql`${v}`),
                Drizzle.sql.raw(", "),
              );
              whereClauses.push(
                Drizzle.sql`(${colsSQL}) ${Drizzle.sql.raw(operator)} (${valsSQL})`,
              );
            }
          }

          const whereClause = whereClauses.length > 0 ? Drizzle.and(...whereClauses) : undefined;

          // For cursor pagination, fetch one extra item to determine if there's a next page
          // Only apply this when using the high-level findWithCursor() API (op.withCursor === true)
          const effectiveLimit = pageSize && op.withCursor ? pageSize + 1 : pageSize;

          const queryConfig: Drizzle.DBQueryConfig<"many", boolean> = {
            columns,
            limit: effectiveLimit,
            where: whereClause,
            orderBy,
            with: {},
          };

          // Process joins recursively to support nested joins
          if (joins) {
            queryConfig.with = processJoins(schema, op.namespace, joins);
          }

          // For multi-schema support: get the mapper for the operation's namespace
          const opMapper = getMapperForOperation(op.namespace);
          const physicalTableName = opMapper
            ? opMapper.toPhysical(op.table.ormName)
            : op.table.ormName;
          const tableQuery = db.query[physicalTableName];

          if (!tableQuery) {
            throw new Error(
              `[Drizzle] Table ${op.table.ormName} (physical: ${physicalTableName}) not found in db.query. ` +
                `Available tables: ${Object.keys(db.query).join(", ")}`,
            );
          }

          const compiledQuery = tableQuery.findMany(queryConfig).toSQL();
          return compiledQuery;
        }
      }
    },

    compileMutationOperation(
      op: MutationOperation<AnySchema>,
    ): CompiledMutation<DrizzleCompiledQuery> | null {
      const schema = op.schema;
      switch (op.type) {
        case "create": {
          const table = getTable(schema, op.table);
          const drizzleTable = toDrizzleTable(table, op.namespace);
          // encodeValues now handles runtime defaults automatically
          const encodedValues = encodeValues(op.values, table, true, provider, true);
          const values = processReferenceSubqueries(encodedValues);

          const compiledQuery = db.insert(drizzleTable).values(values).toSQL();
          return {
            query: compiledQuery,
            expectedAffectedRows: null, // creates don't need affected row checks
            expectedReturnedRows: null,
          };
        }

        case "update": {
          const table = getTable(schema, op.table);
          const idColumn = table.getIdColumn();
          const versionColumn = table.getVersionColumn();
          const drizzleTable = toDrizzleTable(table, op.namespace);

          const externalId = typeof op.id === "string" ? op.id : op.id.externalId;
          const versionToCheck = getVersionToCheck(op.id, op.checkVersion);

          // Build WHERE clause that filters by ID and optionally by version
          const condition =
            versionToCheck !== undefined
              ? buildCondition(table.columns, (eb) =>
                  eb.and(
                    eb(idColumn.ormName, "=", externalId),
                    eb(versionColumn.ormName, "=", versionToCheck),
                  ),
                )
              : buildCondition(table.columns, (eb) => eb(idColumn.ormName, "=", externalId));

          // Handle boolean cases
          if (condition === false) {
            // Never matches - skip this operation
            return null;
          }

          const whereClause =
            condition === true ? undefined : buildWhere(schema, op.namespace, condition);
          const encodedSetValues = encodeValues(op.set, table, false, provider, true);
          const setValues = processReferenceSubqueries(encodedSetValues);

          // Automatically increment _version for optimistic concurrency control
          // Safe cast: we're building a SQL expression for incrementing the version
          setValues[versionColumn.ormName] = Drizzle.sql.raw(
            `COALESCE(${versionColumn.ormName}, 0) + 1`,
          ) as unknown;

          const compiledQuery = db.update(drizzleTable).set(setValues).where(whereClause).toSQL();
          return {
            query: compiledQuery,
            expectedAffectedRows: op.checkVersion ? 1 : null,
            expectedReturnedRows: null,
          };
        }

        case "delete": {
          const table = getTable(schema, op.table);
          const idColumn = table.getIdColumn();
          const versionColumn = table.getVersionColumn();
          const drizzleTable = toDrizzleTable(table, op.namespace);

          if (!op.id) {
            throw new Error(
              `[Drizzle] Delete operation on table "${op.table}" has undefined id. ` +
                `Make sure you're passing a valid FragnoId or string ID.`,
            );
          }

          const externalId = typeof op.id === "string" ? op.id : op.id.externalId;

          if (!externalId) {
            throw new Error(
              `[Drizzle] Delete operation on table "${op.table}" has invalid id. ` +
                `The FragnoId object exists but has no externalId. ` +
                `Received: ${JSON.stringify(op.id)}. ` +
                `Make sure the record was properly loaded from the database.`,
            );
          }
          const versionToCheck = getVersionToCheck(op.id, op.checkVersion);

          // Build WHERE clause that filters by ID and optionally by version
          const condition =
            versionToCheck !== undefined
              ? buildCondition(table.columns, (eb) =>
                  eb.and(
                    eb(idColumn.ormName, "=", externalId),
                    eb(versionColumn.ormName, "=", versionToCheck),
                  ),
                )
              : buildCondition(table.columns, (eb) => eb(idColumn.ormName, "=", externalId));

          // Handle boolean cases
          if (condition === false) {
            // Never matches - skip this operation
            return null;
          }

          const whereClause =
            condition === true ? undefined : buildWhere(schema, op.namespace, condition);

          const compiledQuery = db.delete(drizzleTable).where(whereClause).toSQL();
          return {
            query: compiledQuery,
            expectedAffectedRows: op.checkVersion ? 1 : null,
            expectedReturnedRows: null,
          };
        }

        case "check": {
          const table = getTable(schema, op.table);
          const idColumn = table.getIdColumn();
          const versionColumn = table.getVersionColumn();
          const drizzleTable = toDrizzleTable(table, op.namespace);

          const externalId = op.id.externalId;
          const version = op.id.version;

          // Build WHERE clause that filters by ID and version
          const condition = buildCondition(table.columns, (eb) =>
            eb.and(eb(idColumn.ormName, "=", externalId), eb(versionColumn.ormName, "=", version)),
          );

          if (typeof condition === "boolean") {
            throw new Error("Condition is a boolean, but should be a condition object.");
          }

          // Build a SELECT query to check if the row exists with the correct version
          // Use sql`1` to select a constant with an alias
          const compiledQuery = db
            .select({ exists: Drizzle.sql<number>`1`.as("exists") })
            .from(drizzleTable)
            .where(buildWhere(schema, op.namespace, condition))
            .limit(1)
            .toSQL();

          return {
            query: compiledQuery,
            expectedAffectedRows: null,
            expectedReturnedRows: 1, // Check that exactly 1 row was returned
          };
        }
      }
    },
  };
}
