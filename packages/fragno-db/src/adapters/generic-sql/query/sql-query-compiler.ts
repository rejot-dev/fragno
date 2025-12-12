import type {
  CompiledQuery,
  Kysely,
  ExpressionBuilder,
  ExpressionWrapper,
  SelectQueryBuilder,
  InsertQueryBuilder,
} from "kysely";
import { sql } from "kysely";
import type { SqlBool } from "kysely";
import type { AnyColumn, AnyTable } from "../../../schema/create";
import type { Condition } from "../../../query/condition-builder";
import type { DriverConfig, SupportedDatabase } from "../driver-config";
import type { TableNameMapper } from "../../shared/table-name-mapper";
import { buildWhere, fullSQLName } from "./where-builder";
import { mapSelect, extendSelect } from "./select-builder";
import type { CompiledJoin } from "../../../query/orm/orm";
import { UnitOfWorkEncoder } from "../uow-encoder";

/**
 * Type helpers for Kysely query builders.
 *
 * These use `any` for database schema types because at this abstraction layer,
 * we cannot know the specific database schema - we work with generic query
 * compilation that needs to work across any schema.
 */

// oxlint-disable-next-line no-explicit-any
export type AnyKysely = Kysely<any>;

// oxlint-disable-next-line no-explicit-any
export type AnyExpressionBuilder = ExpressionBuilder<any, any>;

// oxlint-disable-next-line no-explicit-any
export type AnyExpressionWrapper = ExpressionWrapper<any, any, SqlBool>;

// oxlint-disable-next-line no-explicit-any
export type AnySelectQueryBuilder<O = any> = SelectQueryBuilder<any, any, O>;

// oxlint-disable-next-line no-explicit-any
export type AnyInsertQueryBuilder<O = any> = InsertQueryBuilder<any, any, O>;

/**
 * Options for compiling a find operation
 */
export interface FindManyCompilerOptions {
  select: true | string[];
  where?: Condition;
  orderBy?: [AnyColumn, "asc" | "desc"][];
  limit?: number;
  offset?: number;
  join?: CompiledJoin[];
}

/**
 * Options for compiling a count operation
 */
export interface CountCompilerOptions {
  where?: Condition;
}

/**
 * Options for compiling an update operation
 */
export interface UpdateCompilerOptions {
  where?: Condition;
  set: Record<string, unknown>;
}

/**
 * Options for compiling a delete operation
 */
export interface DeleteCompilerOptions {
  where?: Condition;
}

/**
 * Abstract base class for SQL query compilation.
 *
 * Similar to SQLGenerator for migrations, this class provides a framework
 * for compiling runtime queries with dialect-specific behavior.
 *
 * Each database dialect extends this class and implements the abstract methods
 * to handle database-specific SQL generation (like .limit() vs .top()).
 */
export abstract class SQLQueryCompiler {
  protected readonly db: AnyKysely;
  protected readonly driverConfig: DriverConfig;
  protected readonly database: SupportedDatabase;
  protected readonly mapper?: TableNameMapper;
  protected readonly encoder: UnitOfWorkEncoder;

  constructor(db: AnyKysely, driverConfig: DriverConfig, mapper?: TableNameMapper) {
    this.db = db;
    this.driverConfig = driverConfig;
    this.database = driverConfig.databaseType;
    this.mapper = mapper;
    this.encoder = new UnitOfWorkEncoder(driverConfig, db, mapper);
  }

  /**
   * Apply LIMIT clause to a query.
   * Different databases use different syntax (.limit() vs .top()).
   */
  protected abstract applyLimit<T>(query: T & { limit(limit: number): T }, limit: number): T;

  /**
   * Apply OFFSET clause to a query.
   * Some databases may not support offset.
   */
  protected abstract applyOffset<T>(query: T & { offset(offset: number): T }, offset: number): T;

  /**
   * Apply RETURNING clause to an insert/update query.
   * Returns the query with RETURNING if supported, otherwise returns as-is.
   */
  protected abstract applyReturning<T>(
    query: T & { returning(columns: string[]): T },
    columns: string[],
  ): T;

  /**
   * Get the physical table name, applying namespace mapping if provided.
   */
  protected getTableName(table: AnyTable): string {
    return this.mapper ? this.mapper.toPhysical(table.name) : table.name;
  }

  /**
   * Build WHERE clause from a condition tree.
   */
  protected buildWhereClause(condition: Condition, eb: AnyExpressionBuilder, table: AnyTable) {
    return buildWhere(condition, eb, this.driverConfig, this.mapper, table);
  }

  /**
   * Process joins recursively to support nested joins.
   */
  protected processJoins<O>(
    query: AnySelectQueryBuilder<O>,
    joins: CompiledJoin[],
    parentTable: AnyTable,
    parentTableName: string,
    mappedSelect: string[],
    parentPath: string = "",
  ): AnySelectQueryBuilder<O> {
    let result = query;

    for (const join of joins) {
      const { options: joinOptions, relation } = join;

      if (joinOptions === false) {
        continue;
      }

      const targetTable = relation.table;
      // Build the full path for this join (e.g., "author:inviter")
      const fullPath = parentPath ? `${parentPath}:${relation.name}` : relation.name;
      // SQL table alias uses underscores (e.g., "author_inviter")
      const joinName = fullPath.replace(/:/g, "_");

      // Update select
      mappedSelect.push(
        ...mapSelect(joinOptions.select, targetTable, {
          relation: fullPath, // Use full path with colons for column aliases
          tableName: joinName, // Use underscore version for table name
        }),
      );

      result = result.leftJoin(`${this.getTableName(targetTable)} as ${joinName}`, (b) =>
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
            conditions.push(this.buildWhereClause(joinOptions.where, eb, targetTable));
          }

          return eb.and(conditions);
        }),
      );

      // Recursively process nested joins with the full path
      if (joinOptions.join && joinOptions.join.length > 0) {
        result = this.processJoins(
          result,
          joinOptions.join,
          targetTable,
          joinName,
          mappedSelect,
          fullPath,
        );
      }
    }

    return result;
  }

  /**
   * Compile a COUNT query.
   */
  compileCount(table: AnyTable, options: CountCompilerOptions): CompiledQuery {
    let query = this.db
      .selectFrom(this.getTableName(table))
      .select(this.db.fn.countAll().as("count"));

    if (options.where) {
      query = query.where((b) => this.buildWhereClause(options.where!, b, table));
    }

    return query.compile();
  }

  /**
   * Compile a FIND MANY query.
   */
  compileFindMany(table: AnyTable, options: FindManyCompilerOptions): CompiledQuery {
    let query = this.db.selectFrom(this.getTableName(table));

    // Apply WHERE clause
    const whereQuery = options.where;
    if (whereQuery) {
      query = query.where((eb) => this.buildWhereClause(whereQuery, eb, table));
    }

    // Apply OFFSET
    if (options.offset !== undefined) {
      query = this.applyOffset(query, options.offset);
    }

    // Apply LIMIT
    if (options.limit !== undefined) {
      query = this.applyLimit(query, options.limit);
    }

    // Apply ORDER BY
    if (options.orderBy) {
      for (const [col, mode] of options.orderBy) {
        query = query.orderBy(fullSQLName(col, this.mapper), mode);
      }
    }

    // Build SELECT with joins
    const selectBuilder = extendSelect(options.select);
    const mappedSelect: string[] = [];

    // Process joins if provided
    if (options.join && options.join.length > 0) {
      query = this.processJoins(query, options.join, table, this.getTableName(table), mappedSelect);
    }

    const compiledSelect = selectBuilder.compile();
    mappedSelect.push(
      ...mapSelect(compiledSelect.result, table, { tableName: this.getTableName(table) }),
    );

    return query.select(mappedSelect).compile();
  }

  /**
   * Compile a CREATE (INSERT) query.
   */
  compileCreate(table: AnyTable, values: Record<string, unknown>): CompiledQuery {
    // Encode application values to database format (resolves FragnoId, generates defaults, serializes)
    const encodedValues = this.encoder.encodeForDatabase({
      values,
      table,
      generateDefaults: true,
    });

    let insert: AnyInsertQueryBuilder = this.db
      .insertInto(this.getTableName(table))
      .values(encodedValues);

    // Apply RETURNING if supported
    if (this.driverConfig.supportsReturning) {
      const columns = mapSelect(true, table, { tableName: this.getTableName(table) });
      insert = this.applyReturning(insert, columns);
    }

    return insert.compile();
  }

  /**
   * Compile an UPDATE query.
   */
  compileUpdate(table: AnyTable, options: UpdateCompilerOptions): CompiledQuery {
    const encoded = this.encoder.encodeForDatabase({
      values: options.set,
      table,
      generateDefaults: false,
    });

    // Add version increment (must be added after encoding, as a raw SQL expression)
    const versionCol = table.getVersionColumn();
    encoded[versionCol.name] = sql.raw(`COALESCE(${versionCol.name}, 0) + 1`);

    let query = this.db.updateTable(this.getTableName(table)).set(encoded);

    if (options.where) {
      query = query.where((eb) => this.buildWhereClause(options.where!, eb, table));
    }

    return query.compile();
  }

  /**
   * Compile a DELETE query.
   */
  compileDelete(table: AnyTable, options: DeleteCompilerOptions): CompiledQuery {
    let query = this.db.deleteFrom(this.getTableName(table));

    if (options.where) {
      query = query.where((eb) => this.buildWhereClause(options.where!, eb, table));
    }

    return query.compile();
  }

  /**
   * Compile a CHECK query (SELECT 1 to verify a row exists).
   */
  compileCheck(table: AnyTable, where: Condition): CompiledQuery {
    const query = this.db
      .selectFrom(this.getTableName(table))
      .select(sql<number>`1`.as("exists"))
      .where((eb) => this.buildWhereClause(where, eb, table))
      .limit(1);

    return query.compile();
  }
}
