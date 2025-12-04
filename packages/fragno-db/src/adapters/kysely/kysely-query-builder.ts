import {
  type BinaryOperator,
  type CompiledQuery,
  type ExpressionBuilder,
  type ExpressionWrapper,
  type Kysely,
  sql,
} from "kysely";
import type { AnySelectClause, FindManyOptions } from "../../query/query";
import type { SqlBool } from "kysely";
import { type AnyColumn, type AnyTable, Column } from "../../schema/create";
import type { SQLProvider } from "../../shared/providers";
import type { Condition } from "../../query/condition-builder";
import { serialize } from "../../schema/serialize";
import type { CompiledJoin, SimplifyFindOptions } from "../../query/orm/orm";
import { decodeResult, encodeValues, ReferenceSubquery } from "../../query/result-transform";
import type { TableNameMapper } from "../shared/table-name-mapper";

/**
 * Returns the fully qualified SQL name for a column (table.column).
 *
 * @param column - The column to get the full name for
 * @param mapper - Optional table name mapper for namespace prefixing
 * @returns The fully qualified SQL name in the format "tableName.columnName"
 * @internal
 *
 * @example
 * ```ts
 * fullSQLName(userTable.columns.email)
 * // Returns: "users.email"
 * ```
 */
export function fullSQLName(column: AnyColumn, mapper?: TableNameMapper) {
  const tableName = mapper ? mapper.toPhysical(column.tableName) : column.tableName;
  return `${tableName}.${column.name}`;
}

/**
 * Builds a WHERE clause expression from a Condition tree.
 *
 * Recursively processes condition objects to build Kysely WHERE expressions.
 * Handles comparison operators, logical AND/OR/NOT, and special string operators
 * like "contains", "starts with", and "ends with".
 *
 * @param condition - The condition tree to build the WHERE clause from
 * @param eb - Kysely expression builder for constructing SQL expressions
 * @param provider - The SQL provider (affects SQL generation)
 * @param mapper - Optional table name mapper for namespace prefixing
 * @param table - The table being queried (used for resolving reference columns)
 * @returns A Kysely expression wrapper representing the WHERE clause
 * @internal
 *
 * @example
 * ```ts
 * const condition = {
 *   type: "compare",
 *   a: userTable.columns.name,
 *   operator: "contains",
 *   b: "john"
 * };
 * const whereClause = buildWhere(condition, eb, 'postgresql');
 * ```
 */
export function buildWhere(
  condition: Condition,
  eb: ExpressionBuilder<any, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  provider: SQLProvider,
  mapper?: TableNameMapper,
  table?: AnyTable,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): ExpressionWrapper<any, any, SqlBool> {
  if (condition.type === "compare") {
    const left = condition.a;
    const op = condition.operator;
    let val = condition.b;

    if (!(val instanceof Column)) {
      // Handle string references - convert external ID to internal ID via subquery
      if (left.role === "reference" && typeof val === "string" && table) {
        // Find relation that uses this column
        const relation = Object.values(table.relations).find((rel) =>
          rel.on.some(([localCol]) => localCol === left.ormName),
        );
        if (relation) {
          const refTable = relation.table;
          const internalIdCol = refTable.getInternalIdColumn();
          const idCol = refTable.getIdColumn();
          const physicalTableName = mapper ? mapper.toPhysical(refTable.ormName) : refTable.ormName;

          // Build a SQL subquery
          val = eb
            .selectFrom(physicalTableName)
            .select(internalIdCol.name)
            .where(idCol.name, "=", val)
            .limit(1);
        }
      } else {
        val = serialize(val, left, provider);
      }
    }

    let v: BinaryOperator;
    let rhs: unknown;

    switch (op) {
      case "contains":
        v = "like";
        rhs =
          val instanceof Column
            ? sql`concat('%', ${eb.ref(fullSQLName(val, mapper))}, '%')`
            : `%${val}%`;
        break;
      case "not contains":
        v = "not like";
        rhs =
          val instanceof Column
            ? sql`concat('%', ${eb.ref(fullSQLName(val, mapper))}, '%')`
            : `%${val}%`;
        break;
      case "starts with":
        v = "like";
        rhs =
          val instanceof Column ? sql`concat(${eb.ref(fullSQLName(val, mapper))}, '%')` : `${val}%`;
        break;
      case "not starts with":
        v = "not like";
        rhs =
          val instanceof Column ? sql`concat(${eb.ref(fullSQLName(val, mapper))}, '%')` : `${val}%`;
        break;
      case "ends with":
        v = "like";
        rhs =
          val instanceof Column ? sql`concat('%', ${eb.ref(fullSQLName(val, mapper))})` : `%${val}`;
        break;
      case "not ends with":
        v = "not like";
        rhs =
          val instanceof Column ? sql`concat('%', ${eb.ref(fullSQLName(val, mapper))})` : `%${val}`;
        break;
      default:
        v = op;
        rhs = val instanceof Column ? eb.ref(fullSQLName(val, mapper)) : val;
    }

    return eb(fullSQLName(left, mapper), v, rhs);
  }

  // Nested conditions
  if (condition.type === "and") {
    return eb.and(condition.items.map((v) => buildWhere(v, eb, provider, mapper, table)));
  }

  if (condition.type === "not") {
    return eb.not(buildWhere(condition.item, eb, provider, mapper, table));
  }

  return eb.or(condition.items.map((v) => buildWhere(v, eb, provider, mapper, table)));
}

/**
 * Maps a select clause to SQL column names with optional aliases.
 *
 * Converts application-level select clauses (either array of keys or "select all")
 * into SQL-compatible column selections with proper aliasing for relations.
 *
 * @param select - The select clause (array of keys or true for all columns)
 * @param table - The table schema containing column definitions
 * @param options - Optional configuration
 * @param options.relation - Relation name to prefix in aliases (for joined data)
 * @param options.tableName - Override the table name in the SQL (defaults to table.name)
 * @returns Array of SQL select strings in the format "tableName.columnName as alias"
 * @internal
 *
 * @example
 * ```ts
 * mapSelect(['id', 'name'], userTable)
 * // Returns: ['users.id as id', 'users.name as name']
 *
 * mapSelect(['title'], postTable, { relation: 'posts' })
 * // Returns: ['posts.title as posts:title']
 * ```
 */
export function mapSelect(
  select: AnySelectClause,
  table: AnyTable,
  options: {
    relation?: string;
    tableName?: string;
  } = {},
): string[] {
  const { relation, tableName = table.name } = options;
  const out: string[] = [];
  const keys = Array.isArray(select) ? select : Object.keys(table.columns);

  for (const key of keys) {
    const col = table.columns[key];

    // Skip hidden columns when explicitly selecting
    if (Array.isArray(select) && col.isHidden) {
      continue;
    }

    // Add the column to the select list
    const name = relation ? `${relation}:${key}` : key;
    out.push(`${tableName}.${col.name} as ${name}`);
  }

  // Always include hidden columns (for FragnoId construction with internal ID and version)
  for (const key in table.columns) {
    const col = table.columns[key];
    if (col.isHidden && !keys.includes(key)) {
      const name = relation ? `${relation}:${key}` : key;
      out.push(`${tableName}.${col.name} as ${name}`);
    }
  }

  return out;
}

/**
 * Result type from compiling a select clause with extensions.
 * @internal
 */
export interface CompiledSelect {
  /**
   * The final select clause to use in the query
   */
  result: AnySelectClause;

  /**
   * Keys that were added to the select clause (not originally requested)
   */
  extendedKeys: string[];

  /**
   * Removes the extended keys from a record (mutates the record).
   * Used to clean up keys that were only needed for join operations.
   *
   * @param record - The record to remove extended keys from
   * @returns The same record with extended keys removed
   */
  removeExtendedKeys: (record: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Builder for extending a select clause with additional keys.
 * @internal
 */
export interface SelectBuilder {
  /**
   * Adds a key to the select clause if not already present.
   * Tracks which keys were added for later removal.
   *
   * @param key - The key to add to the select clause
   */
  extend: (key: string) => void;

  /**
   * Compiles the select clause into its final form.
   *
   * @returns The compiled select information
   */
  compile: () => CompiledSelect;
}

/**
 * Creates a builder that can extend a select clause with additional keys.
 *
 * This is useful when you need to temporarily include columns for join operations
 * or other internal processing, but don't want them in the final result.
 *
 * @param original - The original select clause from the user
 * @returns A select builder with extend() and compile() methods
 * @internal
 *
 * @example
 * ```ts
 * const builder = extendSelect(['name', 'email']);
 * builder.extend('id'); // Add id for join operation
 * const { result, removeExtendedKeys } = builder.compile();
 * // result: ['name', 'email', 'id']
 *
 * const record = { name: 'John', email: 'j@ex.com', id: 123 };
 * removeExtendedKeys(record);
 * // record: { name: 'John', email: 'j@ex.com' }
 * ```
 */
export function extendSelect(original: AnySelectClause): SelectBuilder {
  const select = Array.isArray(original) ? new Set(original) : true;
  const extendedKeys: string[] = [];

  return {
    extend(key) {
      if (select === true || select.has(key)) {
        return;
      }

      select.add(key);
      extendedKeys.push(key);
    },
    compile() {
      return {
        result: select instanceof Set ? Array.from(select) : true,
        extendedKeys,
        removeExtendedKeys(record) {
          for (const key of extendedKeys) {
            delete record[key];
          }
          return record;
        },
      };
    },
  };
}

/**
 * Executes a SELECT query to find multiple records.
 *
 * Builds and executes a Kysely query with the provided options including
 * filtering (where), ordering (orderBy), pagination (limit/offset), and
 * column selection (select).
 *
 * @param kysely - The Kysely database instance
 * @param provider - The SQL provider (affects SQL generation)
 * @param table - The table to query from
 * @param v - Query options including where, select, orderBy, limit, and offset
 * @param runSubQueryJoin - Function to execute subquery joins on the results
 * @returns Array of decoded records matching the query criteria
 * @internal
 *
 * @example
 * ```ts
 * const records = await findMany(kysely, 'postgresql', userTable, {
 *   where: someCondition,
 *   orderBy: [['name', 'asc']],
 *   limit: 10
 * });
 * ```
 */
export async function findMany(
  kysely: Kysely<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  provider: SQLProvider,
  table: AnyTable,
  v: SimplifyFindOptions<FindManyOptions>,
  runSubQueryJoin: (records: Record<string, unknown>[], join: CompiledJoin) => Promise<void>,
) {
  let query = kysely.selectFrom(table.name);

  const where = v.where;
  if (where) {
    query = query.where((eb) => buildWhere(where, eb, provider));
  }

  if (v.offset !== undefined) {
    query = query.offset(v.offset);
  }

  if (v.limit !== undefined) {
    query = provider === "mssql" ? query.top(v.limit) : query.limit(v.limit);
  }

  if (v.orderBy) {
    for (const [col, mode] of v.orderBy) {
      query = query.orderBy(fullSQLName(col), mode);
    }
  }

  const selectBuilder = extendSelect(v.select);
  const mappedSelect: string[] = [];
  const subqueryJoins: CompiledJoin[] = [];

  const compiledSelect = selectBuilder.compile();
  mappedSelect.push(...mapSelect(compiledSelect.result, table));

  const records = (await query.select(mappedSelect).execute()).map((v) =>
    decodeResult(v, table, provider),
  );

  await Promise.all(subqueryJoins.map((join) => runSubQueryJoin(records, join)));
  for (const record of records) {
    compiledSelect.removeExtendedKeys(record);
  }

  return records;
}

/**
 * Processes encoded values and replaces ReferenceSubquery markers with actual SQL subqueries.
 *
 * @param values - The encoded values that may contain ReferenceSubquery objects
 * @param kysely - The Kysely database instance for building subqueries
 * @param mapper - Optional table name mapper for namespace prefixing
 * @returns Processed values with subqueries in place of ReferenceSubquery markers
 * @internal
 */
function processReferenceSubqueries(
  values: Record<string, unknown>,
  kysely: Kysely<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  mapper?: TableNameMapper,
): Record<string, unknown> {
  const processed: Record<string, unknown> = {};
  const getTableName = (table: AnyTable) => (mapper ? mapper.toPhysical(table.name) : table.name);

  for (const [key, value] of Object.entries(values)) {
    if (value instanceof ReferenceSubquery) {
      const refTable = value.referencedTable;
      const externalId = value.externalIdValue;

      // Build a subquery: SELECT _internal_id FROM referenced_table WHERE id = external_id LIMIT 1
      processed[key] = kysely
        .selectFrom(getTableName(refTable))
        .select(refTable.getInternalIdColumn().name)
        .where(refTable.getIdColumn().name, "=", externalId)
        .limit(1);
    } else {
      processed[key] = value;
    }
  }

  return processed;
}

/**
 * Creates a query compiler that builds and compiles Kysely queries without executing them.
 *
 * Each method takes table and query parameters and returns a CompiledQuery that can be
 * executed later using kysely.executeQuery().
 *
 * @param kysely - The Kysely database instance
 * @param provider - The SQL provider (affects SQL generation)
 * @returns An object with methods for compiling various database operations
 * @internal
 *
 * @example
 * ```ts
 * const builder = createKyselyQueryBuilder(kysely, 'postgresql');
 * const query = builder.count(userTable, { where: someCondition });
 * const result = await kysely.executeQuery(query);
 * ```
 */
export function createKyselyQueryBuilder(
  kysely: Kysely<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  provider: SQLProvider,
  mapper?: TableNameMapper,
) {
  // Helper to get the physical table name (with namespace suffix if mapper is provided)
  const getTableName = (table: AnyTable) => (mapper ? mapper.toPhysical(table.name) : table.name);

  return {
    count(table: AnyTable, { where }: { where?: Condition }): CompiledQuery {
      let query = kysely.selectFrom(getTableName(table)).select(kysely.fn.countAll().as("count"));
      if (where) {
        query = query.where((b) => buildWhere(where, b, provider, mapper, table));
      }
      return query.compile();
    },

    create(table: AnyTable, values: Record<string, unknown>): CompiledQuery {
      const encodedValues = encodeValues(values, table, true, provider);
      const processedValues = processReferenceSubqueries(encodedValues, kysely, mapper);
      const insert = kysely.insertInto(getTableName(table)).values(processedValues);

      if (provider === "mssql") {
        return (
          insert
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .output(mapSelect(true, table, { tableName: "inserted" }) as any[])
            .compile()
        );
      }

      if (provider === "postgresql" || provider === "sqlite") {
        return insert
          .returning(mapSelect(true, table, { tableName: getTableName(table) }))
          .compile();
      }

      // For MySQL/other providers, return the insert query
      return insert.compile();
    },

    findMany<T extends AnyTable>(
      table: T,
      v: SimplifyFindOptions<FindManyOptions<T>>,
    ): CompiledQuery {
      let query = kysely.selectFrom(getTableName(table));

      const where = v.where;
      if (where) {
        query = query.where((eb) => buildWhere(where, eb, provider, mapper, table));
      }

      if (v.offset !== undefined) {
        query = query.offset(v.offset);
      }

      if (v.limit !== undefined) {
        query = provider === "mssql" ? query.top(v.limit) : query.limit(v.limit);
      }

      if (v.orderBy) {
        for (const [col, mode] of v.orderBy) {
          query = query.orderBy(fullSQLName(col, mapper), mode);
        }
      }

      const selectBuilder = extendSelect(v.select);
      const mappedSelect: string[] = [];

      // Process joins recursively to support nested joins
      const processJoins = (
        joins: CompiledJoin[] | undefined,
        parentTable: AnyTable,
        parentTableName: string,
        parentPath: string = "",
      ) => {
        for (const join of joins ?? []) {
          const { options: joinOptions, relation } = join;

          if (joinOptions === false) {
            continue;
          }

          const targetTable = relation.table;
          // Build the full path for this join (e.g., "author:inviter")
          const fullPath = parentPath ? `${parentPath}:${relation.name}` : relation.name;
          // SQL table alias uses underscores (e.g., "author_inviter")
          const joinName = fullPath.replace(/:/g, "_");

          // update select
          mappedSelect.push(
            ...mapSelect(joinOptions.select, targetTable, {
              relation: fullPath, // Use full path with colons for column aliases
              tableName: joinName, // Use underscore version for table name
            }),
          );

          query = query.leftJoin(`${getTableName(targetTable)} as ${joinName}`, (b) =>
            b.on((eb) => {
              const conditions = [];
              for (const [left, right] of relation.on) {
                // Foreign keys always use internal IDs
                // If the relation references an external ID column (any name), translate to "_internalId"
                const rightCol = targetTable.columns[right];
                const actualRight = rightCol?.role === "external-id" ? "_internalId" : right;

                conditions.push(
                  eb(
                    `${parentTableName}.${parentTable.columns[left].name}`,
                    "=",
                    eb.ref(`${joinName}.${targetTable.columns[actualRight].name}`),
                  ),
                );
              }

              if (joinOptions.where) {
                conditions.push(buildWhere(joinOptions.where, eb, provider, mapper, targetTable));
              }

              return eb.and(conditions);
            }),
          );

          // Recursively process nested joins with the full path
          processJoins(joinOptions.join, targetTable, joinName, fullPath);
        }
      };

      processJoins(v.join, table, getTableName(table));

      const compiledSelect = selectBuilder.compile();
      mappedSelect.push(
        ...mapSelect(compiledSelect.result, table, { tableName: getTableName(table) }),
      );

      return query.select(mappedSelect).compile();
    },

    updateMany(
      table: AnyTable,
      v: {
        where?: Condition;
        set: Record<string, unknown>;
      },
    ): CompiledQuery {
      const encoded = encodeValues(v.set, table, false, provider);
      const processed = processReferenceSubqueries(encoded, kysely, mapper);

      // Automatically increment _version for optimistic concurrency control
      const versionCol = table.getVersionColumn();
      // Safe cast: we're building a SQL expression for incrementing the version
      processed[versionCol.name] = sql.raw(`COALESCE(${versionCol.name}, 0) + 1`) as unknown;

      let query = kysely.updateTable(getTableName(table)).set(processed);
      const { where } = v;
      if (where) {
        query = query.where((eb) => buildWhere(where, eb, provider, mapper, table));
      }
      return query.compile();
    },

    upsertCheck(table: AnyTable, where: Condition | undefined): CompiledQuery {
      const idColumn = table.getIdColumn();
      let query = kysely.selectFrom(getTableName(table)).select([`${idColumn.name} as id`]);
      if (where) {
        query = query.where((b) => buildWhere(where, b, provider, mapper, table));
      }
      return query.limit(1).compile();
    },

    upsertUpdate(
      table: AnyTable,
      update: Record<string, unknown>,
      where: Condition | undefined,
      top?: boolean,
    ): CompiledQuery {
      const encoded = encodeValues(update, table, false, provider);
      const processed = processReferenceSubqueries(encoded, kysely, mapper);
      let query = kysely.updateTable(getTableName(table)).set(processed);
      if (top) {
        query = query.top(1);
      }
      if (where) {
        query = query.where((b) => buildWhere(where, b, provider, mapper, table));
      }
      return query.compile();
    },

    upsertUpdateById(table: AnyTable, update: Record<string, unknown>, id: unknown): CompiledQuery {
      const idColumn = table.getIdColumn();
      const encoded = encodeValues(update, table, false, provider);
      const processed = processReferenceSubqueries(encoded, kysely, mapper);
      return kysely
        .updateTable(getTableName(table))
        .set(processed)
        .where(idColumn.name, "=", id)
        .compile();
    },

    createMany(table: AnyTable, values: Record<string, unknown>[]): CompiledQuery {
      const encodedValues = values.map((v) => encodeValues(v, table, true, provider));
      const processedValues = encodedValues.map((v) =>
        processReferenceSubqueries(v, kysely, mapper),
      );
      return kysely.insertInto(getTableName(table)).values(processedValues).compile();
    },

    deleteMany(table: AnyTable, { where }: { where?: Condition }): CompiledQuery {
      let query = kysely.deleteFrom(getTableName(table));
      if (where) {
        query = query.where((eb) => buildWhere(where, eb, provider, mapper, table));
      }
      return query.compile();
    },

    findById(table: AnyTable, idValue: unknown): CompiledQuery {
      const idColumn = table.getIdColumn();
      return kysely
        .selectFrom(getTableName(table))
        .select(mapSelect(true, table, { tableName: getTableName(table) }))
        .where(idColumn.name, "=", idValue)
        .limit(1)
        .compile();
    },
  };
}
