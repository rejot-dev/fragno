import type { AnyColumn, AnySchema, AnyTable, FragnoId } from "../../schema/create";
import type { Condition } from "../../query/condition-builder";
import type {
  CompiledMutation,
  RetrievalOperation,
  MutationOperation,
} from "../../query/unit-of-work";
import { Cursor } from "../../query/cursor";
import type { DriverConfig } from "../generic-sql/driver-config";
import { createTableNameMapper, type TableNameMapper } from "./table-name-mapper";

/**
 * Options for compiling a find operation with cursor pagination
 */
export interface FindCompilationOptions {
  /** Index columns used for ordering */
  indexColumns: AnyColumn[];
  /** Order direction for the index */
  orderDirection: "asc" | "desc";
  /** User-provided where condition */
  userWhere: Condition | boolean | undefined;
  /** Cursor string or Cursor object for pagination (after) */
  after?: string | Cursor;
  /** Cursor string or Cursor object for pagination (before) */
  before?: string | Cursor;
  /** Page size for pagination */
  pageSize?: number;
  /** Whether this is a high-level cursor API call (affects limit calculation) */
  withCursor?: boolean;
  /** Driver config for cursor serialization */
  driverConfig: DriverConfig;
}

/**
 * Result of cursor condition building
 */
export interface CursorConditionResult {
  /** The combined where condition (user where + cursor condition) */
  where: Condition | undefined;
  /** The effective limit to use (may be pageSize + 1 for cursor detection) */
  limit: number | undefined;
}

/**
 * Abstract base class for Unit of Work operation compilers
 *
 * This class provides a structure and utilities for implementing UOW compilers
 * for different ORM/query builders (Kysely, Drizzle, etc.).
 *
 * Subclasses must implement the abstract methods for each operation type,
 * and can use the provided utility methods for common tasks.
 *
 * @template TCompiledQuery - The type of compiled query for the target ORM
 */
export abstract class UOWOperationCompiler<TCompiledQuery> {
  #driverConfig: DriverConfig;
  #mapperFactory?: (namespace: string | undefined) => TableNameMapper | undefined;

  constructor(
    driverConfig: DriverConfig,
    mapperFactory?: (namespace: string | undefined) => TableNameMapper | undefined,
  ) {
    this.#driverConfig = driverConfig;
    this.#mapperFactory = mapperFactory;
  }

  protected get driverConfig(): DriverConfig {
    return this.#driverConfig;
  }

  protected get mapperFactory():
    | ((namespace: string | undefined) => TableNameMapper | undefined)
    | undefined {
    return this.#mapperFactory;
  }

  abstract compileCount(
    op: RetrievalOperation<AnySchema> & { type: "count" },
  ): TCompiledQuery | null;

  abstract compileFind(op: RetrievalOperation<AnySchema> & { type: "find" }): TCompiledQuery | null;

  /**
   * Compile a create operation
   */
  abstract compileCreate(
    op: MutationOperation<AnySchema> & { type: "create" },
  ): CompiledMutation<TCompiledQuery> | null;

  abstract compileUpdate(
    op: MutationOperation<AnySchema> & { type: "update" },
  ): CompiledMutation<TCompiledQuery> | null;

  abstract compileDelete(
    op: MutationOperation<AnySchema> & { type: "delete" },
  ): CompiledMutation<TCompiledQuery> | null;

  abstract compileCheck(
    op: MutationOperation<AnySchema> & { type: "check" },
  ): CompiledMutation<TCompiledQuery> | null;

  // ==================== Utility Methods ====================

  /**
   * Get the mapper for a specific operation based on its namespace
   */
  protected getMapperForOperation(namespace: string | undefined): TableNameMapper | undefined {
    return this.#mapperFactory
      ? this.#mapperFactory(namespace)
      : namespace
        ? createTableNameMapper(namespace)
        : undefined;
  }

  /**
   * Get a table from a schema by name
   * @throws Error if table is not found
   */
  protected getTable(schema: AnySchema, tableName: string): AnyTable {
    const table = schema.tables[tableName];
    if (!table) {
      throw new Error(`Invalid table name ${tableName}.`);
    }
    return table;
  }

  /**
   * Get the version to check for a given ID and checkVersion flag
   * @returns The version to check or undefined if no check is required
   * @throws Error if the ID is a string and checkVersion is true
   */
  protected getVersionToCheck(id: FragnoId | string, checkVersion: boolean): number | undefined {
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
   * Extract external ID from FragnoId or string
   */
  protected getExternalId(id: FragnoId | string): string {
    return typeof id === "string" ? id : id.externalId;
  }

  /**
   * Get the physical table name for an operation, applying namespace mapping if needed
   */
  protected getPhysicalTableName(logicalName: string, namespace: string | undefined): string {
    const mapper = this.getMapperForOperation(namespace);
    return mapper ? mapper.toPhysical(logicalName) : logicalName;
  }
}
