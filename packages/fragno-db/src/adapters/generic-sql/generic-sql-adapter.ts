import { RequestContextStorage } from "@fragno-dev/core/internal/request-context-storage";
import {
  fragnoDatabaseAdapterNameFakeSymbol,
  fragnoDatabaseAdapterVersionFakeSymbol,
  type DatabaseAdapter,
  type DatabaseContextStorage,
  type TableNameMapper,
} from "../adapters";
import type { CompiledQuery, Dialect, QueryResult } from "../../sql-driver/sql-driver";
import { SqlDriverAdapter } from "../../sql-driver/sql-driver-adapter";
import { sql } from "../../sql-driver/sql";
import type { AnySchema } from "../../schema/create";
import { createTableNameMapper } from "../shared/table-name-mapper";
import type { SimpleQueryInterface } from "../../query/simple-query-interface";
import { createExecutor } from "./generic-sql-uow-executor";
import { createKyselyUOWDecoder } from "./uow-decoder";
import { createPreparedMigrations, type PreparedMigrations } from "./migration/prepared-migrations";
import type { DriverConfig } from "./driver-config";
import { GenericSQLUOWOperationCompiler } from "./query/generic-sql-uow-operation-compiler";
import { createUOWCompilerFromOperationCompiler } from "../shared/uow-operation-compiler";
import {
  fromUnitOfWorkCompiler,
  type UnitOfWorkFactory,
} from "../shared/from-unit-of-work-compiler";

export interface UnitOfWorkConfig {
  onQuery?: (query: CompiledQuery) => void;
  dryRun?: boolean;
}

export interface GenericSQLOptions {
  dialect: Dialect;
  driverConfig: DriverConfig;
  uowConfig?: UnitOfWorkConfig;
}

export class GenericSQLAdapter implements DatabaseAdapter<UnitOfWorkConfig> {
  readonly dialect: Dialect;
  readonly driverConfig: DriverConfig;
  readonly uowConfig?: UnitOfWorkConfig;

  #schemaNamespaceMap = new WeakMap<AnySchema, string>();
  #contextStorage: RequestContextStorage<DatabaseContextStorage>;

  #driver: SqlDriverAdapter;

  constructor({ dialect, driverConfig, uowConfig }: GenericSQLOptions) {
    this.dialect = dialect;
    this.driverConfig = driverConfig;
    this.uowConfig = uowConfig;

    this.#schemaNamespaceMap = new WeakMap<AnySchema, string>();
    this.#contextStorage = new RequestContextStorage();

    this.#driver = new SqlDriverAdapter(dialect);
  }

  get driver(): SqlDriverAdapter {
    return this.#driver;
  }

  get [fragnoDatabaseAdapterNameFakeSymbol](): string {
    return "generic-sql";
  }

  get [fragnoDatabaseAdapterVersionFakeSymbol](): number {
    return 0;
  }

  get contextStorage(): RequestContextStorage<DatabaseContextStorage> {
    return this.#contextStorage;
  }

  close(): Promise<void> {
    return this.#driver.destroy();
  }

  async isConnectionHealthy(): Promise<boolean> {
    const result = await this.#driver.executeQuery(sql`SELECT 1 as healthy`.compile(this.dialect));
    return result.rows[0]["healthy"] === 1;
  }

  prepareMigrations<T extends AnySchema>(schema: T, namespace: string): PreparedMigrations {
    return createPreparedMigrations({
      schema,
      namespace,
      database: this.driverConfig.databaseType,
      mapper: namespace ? this.createTableNameMapper(namespace) : undefined,
      driver: this.#driver,
    });
  }

  createTableNameMapper(namespace: string): TableNameMapper {
    return createTableNameMapper(namespace, false);
  }

  async getSchemaVersion(namespace: string): Promise<string | undefined> {
    const key = `${namespace}.schema_version`;
    const query = sql`SELECT value FROM fragno_db_settings WHERE key = ${key};`.compile(
      this.dialect,
    );

    let result: QueryResult<Record<string, unknown>>;
    try {
      result = await this.#driver.executeQuery(query);
    } catch (error) {
      if (error instanceof Error && error.message.includes("fragno_db_settings")) {
        return undefined;
      }
      throw error;
    }

    const value = result.rows[0]["value"];

    if (!value) {
      return undefined;
    }

    if (typeof value !== "string") {
      throw new Error(`Schema version for namespace ${namespace} is not a string`);
    }

    return value;
  }

  createQueryEngine<T extends AnySchema>(
    schema: T,
    namespace: string,
  ): SimpleQueryInterface<T, UnitOfWorkConfig> {
    this.#schemaNamespaceMap.set(schema, namespace);

    const operationCompiler = new GenericSQLUOWOperationCompiler(this.driverConfig, (ns) =>
      ns ? this.createTableNameMapper(ns) : undefined,
    );

    const factory: UnitOfWorkFactory = {
      compiler: createUOWCompilerFromOperationCompiler(operationCompiler),
      executor: createExecutor(this.#driver, false),
      decoder: createKyselyUOWDecoder(this.driverConfig.databaseType),
      uowConfig: this.uowConfig,
      schemaNamespaceMap: this.#schemaNamespaceMap,
    };

    return fromUnitOfWorkCompiler(schema, factory);
  }
}
