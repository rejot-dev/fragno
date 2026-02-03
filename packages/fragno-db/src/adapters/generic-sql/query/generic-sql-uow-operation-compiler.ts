import { UOWOperationCompiler } from "../../shared/uow-operation-compiler";
import type { CompiledQuery } from "kysely";
import type { DriverConfig } from "../driver-config";
import type { NamingResolver } from "../../../naming/sql-naming";
import type { SQLiteStorageMode } from "../sqlite-storage";
import type {
  RetrievalOperation,
  MutationOperation,
  CompiledMutation,
} from "../../../query/unit-of-work/unit-of-work";
import type { AnyColumn, AnySchema } from "../../../schema/create";
import { buildCondition } from "../../../query/condition-builder";
import { createSQLQueryCompiler } from "./create-sql-query-compiler";
import { SQLQueryCompiler } from "./sql-query-compiler";
import { buildCursorCondition } from "./cursor-utils";
import type { Condition } from "../../../query/condition-builder";
import { buildFindOptions } from "../../../query/orm/orm";
import type { AnySelectClause } from "../../../query/simple-query-interface";
import { createColdKysely } from "../migration/cold-kysely";

/**
 * Generic SQL UOW Operation Compiler.
 *
 * Uses SQLQueryCompiler for dialect-specific SQL generation while handling
 * high-level business logic like cursor pagination, version checking, and index resolution.
 */
export class GenericSQLUOWOperationCompiler extends UOWOperationCompiler<CompiledQuery> {
  private readonly sqliteStorageMode?: SQLiteStorageMode;

  constructor(
    driverConfig: DriverConfig,
    sqliteStorageMode?: SQLiteStorageMode,
    resolverFactory?: (schema: AnySchema, namespace: string | null) => NamingResolver,
  ) {
    super(driverConfig, resolverFactory);
    this.sqliteStorageMode = sqliteStorageMode;
  }

  /**
   * Get SQL compiler for a specific namespace
   */
  private getSQLCompiler(
    schema: AnySchema,
    namespace: string | null | undefined,
  ): SQLQueryCompiler {
    const resolver = this.getNamingResolver(schema, namespace ?? null);
    const kysely = createColdKysely(this.driverConfig.databaseType);
    const schemaName = resolver.getSchemaName();
    const scopedKysely = schemaName ? kysely.withSchema(schemaName) : kysely;
    return createSQLQueryCompiler(
      scopedKysely,
      this.driverConfig,
      this.sqliteStorageMode,
      resolver,
    );
  }

  override compileCount(
    op: RetrievalOperation<AnySchema> & { type: "count" },
  ): CompiledQuery | null {
    const sqlCompiler = this.getSQLCompiler(op.schema, op.namespace);

    // Build where condition
    let conditions = op.options.where
      ? buildCondition(op.table.columns, op.options.where)
      : undefined;

    if (conditions === true) {
      conditions = undefined;
    }
    if (conditions === false) {
      return null;
    }

    return sqlCompiler.compileCount(op.table, { where: conditions });
  }

  override compileFind(op: RetrievalOperation<AnySchema> & { type: "find" }): CompiledQuery | null {
    const sqlCompiler = this.getSQLCompiler(op.schema, op.namespace);

    // Extract options
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
    // TODO: Multi-column cursor pagination not yet supported
    if ((after || before) && indexColumns.length > 1) {
      throw new Error(
        "Multi-column cursor pagination is not yet supported in Generic SQL implementation",
      );
    }
    const cursorCondition = buildCursorCondition(
      after || before,
      indexColumns,
      orderDirection,
      !!after,
      this.driverConfig,
      this.sqliteStorageMode,
    );

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
    const effectiveLimit = pageSize && op.withCursor ? pageSize + 1 : pageSize;

    // When we have joins, use the query builder directly
    if (join && join.length > 0) {
      return sqlCompiler.compileFindMany(op.table, {
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
      orderBy: orderBy?.map(([col, dir]) => [col.name, dir]),
      limit: effectiveLimit,
    });

    if (compiledOptions === false) {
      return null;
    }

    return sqlCompiler.compileFindMany(op.table, compiledOptions);
  }

  override compileCreate(
    op: MutationOperation<AnySchema> & { type: "create" },
  ): CompiledMutation<CompiledQuery> | null {
    const sqlCompiler = this.getSQLCompiler(op.schema, op.namespace);
    const table = this.getTable(op.schema, op.table);

    return {
      query: sqlCompiler.compileCreate(table, op.values),
      operation: op,
      op: "create",
      expectedAffectedRows: null, // creates don't need affected row checks
      expectedReturnedRows: null,
    };
  }

  override compileUpdate(
    op: MutationOperation<AnySchema> & { type: "update" },
  ): CompiledMutation<CompiledQuery> | null {
    const sqlCompiler = this.getSQLCompiler(op.schema, op.namespace);
    const table = this.getTable(op.schema, op.table);
    const idColumn = table.getIdColumn();
    const versionColumn = table.getVersionColumn();

    const externalId = this.getExternalId(op.id);
    const versionToCheck = this.getVersionToCheck(op.id, op.checkVersion);

    // Build WHERE clause that filters by ID and optionally by version
    const conditionsResult =
      versionToCheck !== undefined
        ? buildCondition(table.columns, (eb) =>
            eb.and(eb(idColumn.name, "=", externalId), eb(versionColumn.name, "=", versionToCheck)),
          )
        : buildCondition(table.columns, (eb) => eb(idColumn.name, "=", externalId));

    if (conditionsResult === false) {
      return null;
    }

    const conditions: Condition | undefined =
      conditionsResult === true ? undefined : conditionsResult;

    // Determine if we should use RETURNING-based checking
    // Use RETURNING when driver supports it but doesn't support affected rows reporting
    const useReturningForCheck =
      op.checkVersion &&
      this.driverConfig.supportsReturning &&
      !this.driverConfig.supportsRowsAffected;

    const query = sqlCompiler.compileUpdate(table, {
      set: op.set,
      where: conditions,
      returning: useReturningForCheck,
    });

    return {
      query,
      operation: op,
      op: "update",
      expectedAffectedRows: useReturningForCheck ? null : op.checkVersion ? 1n : null,
      expectedReturnedRows: useReturningForCheck ? 1 : null,
    };
  }

  override compileDelete(
    op: MutationOperation<AnySchema> & { type: "delete" },
  ): CompiledMutation<CompiledQuery> | null {
    const sqlCompiler = this.getSQLCompiler(op.schema, op.namespace);
    const table = this.getTable(op.schema, op.table);
    const idColumn = table.getIdColumn();
    const versionColumn = table.getVersionColumn();

    const externalId = this.getExternalId(op.id);
    const versionToCheck = this.getVersionToCheck(op.id, op.checkVersion);

    // Build WHERE clause that filters by ID and optionally by version
    const conditionsResult =
      versionToCheck !== undefined
        ? buildCondition(table.columns, (eb) =>
            eb.and(eb(idColumn.name, "=", externalId), eb(versionColumn.name, "=", versionToCheck)),
          )
        : buildCondition(table.columns, (eb) => eb(idColumn.name, "=", externalId));

    if (conditionsResult === false) {
      return null;
    }

    const conditions: Condition | undefined =
      conditionsResult === true ? undefined : conditionsResult;

    // Determine if we should use RETURNING-based checking
    // Use RETURNING when driver supports it but doesn't support affected rows reporting
    const useReturningForCheck =
      op.checkVersion &&
      this.driverConfig.supportsReturning &&
      !this.driverConfig.supportsRowsAffected;

    const query = sqlCompiler.compileDelete(table, {
      where: conditions,
      returning: useReturningForCheck,
    });

    return {
      query,
      operation: op,
      op: "delete",
      expectedAffectedRows: useReturningForCheck ? null : op.checkVersion ? 1n : null,
      expectedReturnedRows: useReturningForCheck ? 1 : null,
    };
  }

  override compileCheck(
    op: MutationOperation<AnySchema> & { type: "check" },
  ): CompiledMutation<CompiledQuery> {
    const sqlCompiler = this.getSQLCompiler(op.schema, op.namespace);
    const table = this.getTable(op.schema, op.table);
    const idColumn = table.getIdColumn();
    const versionColumn = table.getVersionColumn();

    const externalId = op.id.externalId;
    const version = op.id.version;

    // Build a SELECT 1 query to check if the row exists with the correct version
    const condition = buildCondition(table.columns, (eb) =>
      eb.and(eb(idColumn.name, "=", externalId), eb(versionColumn.name, "=", version)),
    );

    if (typeof condition === "boolean") {
      throw new Error("Condition is a boolean, but should be a condition object.");
    }

    return {
      query: sqlCompiler.compileCheck(table, condition),
      operation: op,
      op: "check",
      expectedAffectedRows: null,
      expectedReturnedRows: 1, // Check that exactly 1 row was returned
    };
  }
}
