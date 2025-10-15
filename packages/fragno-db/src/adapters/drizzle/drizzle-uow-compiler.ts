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
import type { DrizzleConfig } from "./drizzle-adapter";
import { type ColumnType, type TableType, parseDrizzle } from "./shared";
import { encodeValues, ReferenceSubquery } from "../../query/result-transform";
import { serialize } from "../../schema/serialize";

export type DrizzleCompiledQuery = { sql: string; params: unknown[] };

/**
 * Create a Drizzle-specific Unit of Work compiler
 *
 * This compiler translates UOW operations into Drizzle query functions
 * that can be executed as a batch/transaction.
 *
 * @param schema - The database schema
 * @param config - Drizzle configuration
 * @returns A UOWCompiler instance for Drizzle
 */
export function createDrizzleUOWCompiler<TSchema extends AnySchema>(
  schema: TSchema,
  config: DrizzleConfig,
): UOWCompiler<TSchema, DrizzleCompiledQuery> {
  const [db, drizzleTables] = parseDrizzle(config.db);
  const { provider } = config;

  /**
   * Convert a Fragno table to a Drizzle table
   * @throws Error if table is not found in Drizzle schema
   */
  function toDrizzleTable(table: AnyTable): TableType {
    const tableName = table.ormName;
    const out = drizzleTables[tableName];
    if (out) {
      return out;
    }

    throw new Error(
      `[Drizzle] Unknown table name ${tableName}, is it included in your Drizzle schema?`,
    );
  }

  /**
   * Convert a Fragno column to a Drizzle column
   * @throws Error if column is not found in Drizzle table
   */
  function toDrizzleColumn(col: AnyColumn): ColumnType {
    const fragnoTable = schema.tables[col.tableName];
    if (!fragnoTable) {
      throw new Error(`[Drizzle] Unknown table ${col.tableName} for column ${col.ormName}.`);
    }

    const table = toDrizzleTable(fragnoTable);
    const out = table[col.ormName];
    if (out) {
      return out;
    }

    throw new Error(`[Drizzle] Unknown column name ${col.ormName} in ${fragnoTable.ormName}.`);
  }

  /**
   * Build a WHERE clause from a condition using Drizzle's query builder
   */
  function buildWhere(condition: Condition): Drizzle.SQL | undefined {
    if (condition.type === "compare") {
      const left = toDrizzleColumn(condition.a);
      const op = condition.operator;
      let right = condition.b;
      if (right instanceof Column) {
        right = toDrizzleColumn(right);
      } else {
        // Serialize non-Column values (e.g., FragnoId -> string, Date -> number for SQLite)
        right = serialize(right, condition.a, provider);
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
      return Drizzle.and(...condition.items.map((item) => buildWhere(item)));
    }

    if (condition.type === "not") {
      const result = buildWhere(condition.item);
      if (!result) return;

      return Drizzle.not(result);
    }

    return Drizzle.or(...condition.items.map((item) => buildWhere(item)));
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
        const drizzleRefTable = toDrizzleTable(refTable);
        const drizzleIdCol = toDrizzleColumn(idCol);

        // Create a parameterized SQL subquery using Drizzle's query builder
        // Safe cast: we're building a SQL subquery that returns a single bigint value
        processed[key] = db
          .select({ value: drizzleRefTable[internalIdCol.ormName] })
          .from(drizzleRefTable)
          .where(Drizzle.eq(drizzleIdCol, externalId))
          .limit(1) as unknown;
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
  function getTable(name: unknown): AnyTable {
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

  return {
    compileRetrievalOperation(op: RetrievalOperation<TSchema>): DrizzleCompiledQuery | null {
      switch (op.type) {
        case "find": {
          const { useIndex: _useIndex, orderByIndex, ...findOptions } = op.options;

          // Convert orderByIndex to orderBy format
          let orderBy: Drizzle.SQL[] | undefined;
          if (orderByIndex) {
            const index = op.table.indexes[orderByIndex.indexName];

            if (!index) {
              // If _primary index doesn't exist, fall back to internal ID column
              if (orderByIndex.indexName === "_primary") {
                const idColumn = toDrizzleColumn(op.table.getIdColumn());
                orderBy = [
                  orderByIndex.direction === "asc" ? Drizzle.asc(idColumn) : Drizzle.desc(idColumn),
                ];
              } else {
                throw new Error(
                  `Index "${orderByIndex.indexName}" not found on table "${op.table.name}"`,
                );
              }
            } else {
              // Order by all columns in the index with the specified direction
              orderBy = index.columns.map((col) => {
                const drizzleCol = toDrizzleColumn(col);
                return orderByIndex.direction === "asc"
                  ? Drizzle.asc(drizzleCol)
                  : Drizzle.desc(drizzleCol);
              });
            }
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

          // Build WHERE clause, handling boolean cases
          let whereClause: Drizzle.SQL | undefined;
          if (findOptions.where) {
            const condition = buildCondition(op.table.columns, findOptions.where);
            if (condition === false) {
              // Never matches - return null to indicate this query should be skipped
              return null;
            }
            if (condition !== true) {
              whereClause = buildWhere(condition);
            }
          }

          const queryConfig: Drizzle.DBQueryConfig<"many", boolean> = {
            columns,
            limit: findOptions.limit,
            offset: findOptions.offset,
            where: whereClause,
            orderBy,
          };

          // Return the SQL representation directly
          return db.query[op.table.ormName].findMany(queryConfig).toSQL();
        }
      }
    },

    compileMutationOperation(
      op: MutationOperation<TSchema>,
    ): CompiledMutation<DrizzleCompiledQuery> | null {
      switch (op.type) {
        case "create": {
          const table = getTable(op.table);
          const drizzleTable = toDrizzleTable(table);
          const encodedValues = encodeValues(op.values, table, true, provider);
          const values = processReferenceSubqueries(encodedValues);

          return {
            query: db.insert(drizzleTable).values(values).toSQL(),
            expectedAffectedRows: null, // creates don't need affected row checks
          };
        }

        case "update": {
          const table = getTable(op.table);
          const idColumn = table.getIdColumn();
          const versionColumn = table.getVersionColumn();
          const drizzleTable = toDrizzleTable(table);

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

          const whereClause = condition === true ? undefined : buildWhere(condition);
          const encodedSetValues = encodeValues(op.set, table, false, provider);
          const setValues = processReferenceSubqueries(encodedSetValues);

          // Automatically increment _version for optimistic concurrency control
          // Safe cast: we're building a SQL expression for incrementing the version
          setValues[versionColumn.ormName] = Drizzle.sql.raw(
            `COALESCE(${versionColumn.ormName}, 0) + 1`,
          ) as unknown;

          return {
            query: db.update(drizzleTable).set(setValues).where(whereClause).toSQL(),
            expectedAffectedRows: op.checkVersion ? 1 : null,
          };
        }

        case "delete": {
          const table = getTable(op.table);
          const idColumn = table.getIdColumn();
          const versionColumn = table.getVersionColumn();
          const drizzleTable = toDrizzleTable(table);

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

          const whereClause = condition === true ? undefined : buildWhere(condition);

          return {
            query: db.delete(drizzleTable).where(whereClause).toSQL(),
            expectedAffectedRows: op.checkVersion ? 1 : null,
          };
        }
      }
    },
  };
}
