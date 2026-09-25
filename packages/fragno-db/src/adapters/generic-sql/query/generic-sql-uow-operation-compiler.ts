import type { CompiledQuery } from "kysely";

import type { NamingResolver } from "../../../naming/sql-naming";
import { buildCondition } from "../../../query/condition-builder";
import type { Condition } from "../../../query/condition-builder";
import { buildFindOptions } from "../../../query/find-options";
import { buildCheckAbsentCondition } from "../../../query/unit-of-work/check-absent";
import type { MutationOperation } from "../../../query/unit-of-work/mutation-recorder";
import type {
  RetrievalOperation,
  CompiledMutation,
  CompiledMutationResult,
} from "../../../query/unit-of-work/unit-of-work";
import { materializeRuntimeCreateValues } from "../../../query/value-encoding";
import type { AnyColumn, AnySchema } from "../../../schema/create";
import { UOWOperationCompiler } from "../../shared/uow-operation-compiler";
import type { DriverConfig } from "../driver-config";
import { createColdKysely } from "../migration/cold-kysely";
import type { SQLiteStorageMode } from "../sqlite-storage";
import { createSQLQueryCompiler } from "./create-sql-query-compiler";
import { buildCursorCondition } from "./cursor-utils";
import { QueryTreeSQLCompiler } from "./query-tree-sql-compiler";
import { SQLQueryCompiler, type AnyKysely } from "./sql-query-compiler";

type ScopedCompilers = {
  db: AnyKysely;
  resolver: NamingResolver;
  sql: SQLQueryCompiler | null;
  queryTree: QueryTreeSQLCompiler | null;
};

/**
 * Generic SQL UOW Operation Compiler.
 *
 * Uses SQLQueryCompiler for dialect-specific SQL generation while handling
 * high-level business logic like cursor pagination, version checking, and index resolution.
 */
export class GenericSQLUOWOperationCompiler extends UOWOperationCompiler<CompiledQuery> {
  private readonly sqliteStorageMode?: SQLiteStorageMode;
  private readonly scopedCompilers = new WeakMap<AnySchema, Map<string | null, ScopedCompilers>>();
  private coldKysely: AnyKysely | null = null;

  constructor(
    driverConfig: DriverConfig,
    sqliteStorageMode?: SQLiteStorageMode,
    resolverFactory?: (schema: AnySchema, namespace: string | null) => NamingResolver,
  ) {
    super(driverConfig, resolverFactory);
    this.sqliteStorageMode = sqliteStorageMode;
  }

  private getScopedCompilers(schema: AnySchema, namespace: string | null): ScopedCompilers {
    let byNamespace = this.scopedCompilers.get(schema);
    if (!byNamespace) {
      byNamespace = new Map();
      this.scopedCompilers.set(schema, byNamespace);
    }

    let scoped = byNamespace.get(namespace);
    if (!scoped) {
      const resolver = this.getNamingResolver(schema, namespace);
      this.coldKysely ??= createColdKysely(this.driverConfig.databaseType);
      const schemaName = resolver.getSchemaName();
      scoped = {
        db: schemaName ? this.coldKysely.withSchema(schemaName) : this.coldKysely,
        resolver,
        sql: null,
        queryTree: null,
      };
      byNamespace.set(namespace, scoped);
    }
    return scoped;
  }

  private getSQLCompiler(
    schema: AnySchema,
    namespace: string | null | undefined,
  ): SQLQueryCompiler {
    const scoped = this.getScopedCompilers(schema, namespace ?? null);
    scoped.sql ??= createSQLQueryCompiler(
      scoped.db,
      this.driverConfig,
      this.sqliteStorageMode,
      scoped.resolver,
    );
    return scoped.sql;
  }

  private getQueryTreeCompiler(
    schema: AnySchema,
    namespace: string | null | undefined,
  ): QueryTreeSQLCompiler {
    const scoped = this.getScopedCompilers(schema, namespace ?? null);
    scoped.queryTree ??= new QueryTreeSQLCompiler(
      scoped.db,
      this.driverConfig,
      this.sqliteStorageMode,
      scoped.resolver,
    );
    return scoped.queryTree;
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
    // Extract options
    const {
      useIndex: _useIndex,
      orderByIndex,
      queryTree,
      after,
      before,
      pageSize,
      ...findManyOptions
    } = op.options;

    if (queryTree) {
      const queryTreeCompiler = this.getQueryTreeCompiler(op.schema, op.namespace);
      return queryTreeCompiler.compile(queryTree, {
        readTracking: op.readTracking,
        withCursor: op.withCursor,
      });
    }

    const sqlCompiler = this.getSQLCompiler(op.schema, op.namespace);

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

    // Handle cursor pagination - build a cursor condition (supports multi-column lexicographic compare)
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

    // Build the adapter-independent options used by the SQL compiler.
    const compiledOptions = buildFindOptions(op.table, {
      ...findManyOptions,
      where: combinedWhere ? () => combinedWhere : undefined,
      orderBy: orderBy?.map(([col, dir]) => [col.name, dir]),
      limit: effectiveLimit,
    });

    if (compiledOptions === false) {
      return null;
    }

    return sqlCompiler.compileFindMany(op.table, {
      ...compiledOptions,
      readTracking: op.readTracking,
    });
  }

  override compileCreate(
    op: MutationOperation<AnySchema> & { type: "create" },
  ): CompiledMutation<CompiledQuery> | null {
    const sqlCompiler = this.getSQLCompiler(op.schema, op.namespace);
    const table = this.getTable(op.schema, op.table);
    const idColumnName = table.getIdColumn().name;
    const operationValues = op.values as Record<string, unknown>;
    const createValues =
      operationValues[idColumnName] === undefined
        ? { ...operationValues, [idColumnName]: op.generatedExternalId }
        : operationValues;
    const materializedValues = materializeRuntimeCreateValues(createValues, table);
    const materializedOperation = { ...op, values: materializedValues };

    return {
      query: sqlCompiler.compileCreate(table, materializedValues),
      operation: op,
      materializedOperation,
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

  override compileDeleteMany(
    op: MutationOperation<AnySchema> & { type: "delete-many" },
  ): CompiledMutationResult<CompiledQuery> {
    if (op.ids.length === 0) {
      return null;
    }

    const sqlCompiler = this.getSQLCompiler(op.schema, op.namespace);
    const table = this.getTable(op.schema, op.table);
    const idColumn = table.getIdColumn();
    const versionColumn = table.getVersionColumn();
    const versions = op.checkVersion
      ? op.ids.map((id) => {
          const version = this.getVersionToCheck(id, true);
          if (version === undefined) {
            throw new Error("Checked bulk deletes require versioned FragnoIds.");
          }
          return version;
        })
      : [];
    const sharedVersion =
      versions.length > 0 && versions.every((version) => version === versions[0])
        ? versions[0]
        : null;
    const fixedParameterCount = sharedVersion === null ? 0 : 1;
    const parametersPerId = op.checkVersion && sharedVersion === null ? 2 : 1;
    const maxIdsPerStatement = Number.isFinite(this.driverConfig.maxParametersPerQuery)
      ? Math.floor(
          (this.driverConfig.maxParametersPerQuery - fixedParameterCount) / parametersPerId,
        )
      : op.ids.length;
    if (maxIdsPerStatement < 1) {
      throw new Error(
        `Driver ${this.driverConfig.driverType} cannot bind one bulk delete ID with its configured parameter limit.`,
      );
    }

    const useReturningForCheck =
      op.checkVersion &&
      this.driverConfig.supportsReturning &&
      !this.driverConfig.supportsRowsAffected;
    const compiled: CompiledMutation<CompiledQuery>[] = [];
    for (let offset = 0; offset < op.ids.length; offset += maxIdsPerStatement) {
      const ids = op.ids.slice(offset, offset + maxIdsPerStatement);
      const conditionsResult =
        sharedVersion !== null
          ? buildCondition(table.columns, (eb) =>
              eb.and(
                eb(versionColumn.name, "=", sharedVersion),
                eb(
                  idColumn.name,
                  "in",
                  ids.map((id) => this.getExternalId(id)),
                ),
              ),
            )
          : op.checkVersion
            ? buildCondition(table.columns, (eb) =>
                eb.or(
                  ...ids.map((id) => {
                    const version = this.getVersionToCheck(id, true);
                    if (version === undefined) {
                      throw new Error("Checked bulk deletes require versioned FragnoIds.");
                    }
                    return eb.and(
                      eb(idColumn.name, "=", this.getExternalId(id)),
                      eb(versionColumn.name, "=", version),
                    );
                  }),
                ),
              )
            : buildCondition(table.columns, (eb) =>
                eb(
                  idColumn.name,
                  "in",
                  ids.map((id) => this.getExternalId(id)),
                ),
              );

      if (conditionsResult === false) {
        continue;
      }

      const conditions: Condition | undefined =
        conditionsResult === true ? undefined : conditionsResult;
      const expectedRows = op.checkVersion ? ids.length : null;
      compiled.push({
        query: sqlCompiler.compileDelete(table, {
          where: conditions,
          returning: useReturningForCheck,
        }),
        ...(offset === 0 ? { operation: op } : {}),
        op: "delete-many",
        expectedAffectedRows:
          useReturningForCheck || expectedRows === null ? null : BigInt(expectedRows),
        expectedReturnedRows: useReturningForCheck ? expectedRows : null,
      });
    }

    return compiled.length === 1 ? compiled[0] : compiled;
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

  override compileCheckAbsent(
    op: MutationOperation<AnySchema> & { type: "check-absent" },
  ): CompiledMutation<CompiledQuery> {
    const sqlCompiler = this.getSQLCompiler(op.schema, op.namespace);
    const { table, condition } = buildCheckAbsentCondition(
      op.schema,
      op.table,
      op.indexName,
      op.values,
    );

    return {
      query: sqlCompiler.compileCheck(table, condition),
      operation: op,
      op: "check-absent",
      expectedAffectedRows: null,
      expectedReturnedRows: 0,
    };
  }
}
