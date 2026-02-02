import { RequestContextStorage } from "@fragno-dev/core/internal/request-context-storage";
import {
  fragnoDatabaseAdapterNameFakeSymbol,
  fragnoDatabaseAdapterVersionFakeSymbol,
  type DatabaseAdapter,
  type DatabaseContextStorage,
  type DatabaseAdapterMetadata,
  type SQLiteProfile,
  type TableNameMapper,
} from "../adapters";
import type { CompiledQuery, Dialect, QueryResult } from "../../sql-driver/sql-driver";
import { SqlDriverAdapter } from "../../sql-driver/sql-driver-adapter";
import { sql } from "../../sql-driver/sql";
import type { AnySchema } from "../../schema/create";
import { createTableNameMapper } from "../shared/table-name-mapper";
import type { SimpleQueryInterface } from "../../query/simple-query-interface";
import { createExecutor } from "./generic-sql-uow-executor";
import { UnitOfWorkDecoder } from "./uow-decoder";
import { createPreparedMigrations, type PreparedMigrations } from "./migration/prepared-migrations";
import type { DriverConfig } from "./driver-config";
import { GenericSQLUOWOperationCompiler } from "./query/generic-sql-uow-operation-compiler";
import { createUOWCompilerFromOperationCompiler } from "../shared/uow-operation-compiler";
import {
  fromUnitOfWorkCompiler,
  type UnitOfWorkFactory,
} from "../shared/from-unit-of-work-compiler";
import type { UOWInstrumentation } from "../../query/unit-of-work/unit-of-work";
import type { SQLiteStorageMode } from "./sqlite-storage";
import { sqliteStorageDefault, sqliteStoragePrisma } from "./sqlite-storage";

export interface UnitOfWorkConfig {
  onQuery?: (query: CompiledQuery) => void;
  dryRun?: boolean;
  instrumentation?: UOWInstrumentation;
}

export interface SqlAdapterOptions {
  dialect: Dialect;
  driverConfig: DriverConfig;
  uowConfig?: UnitOfWorkConfig;
  sqliteProfile?: SQLiteProfile;
  sqliteStorageMode?: SQLiteStorageMode;
}

export const sqliteProfiles: Record<SQLiteProfile, SQLiteStorageMode> = {
  default: sqliteStorageDefault,
  prisma: sqliteStoragePrisma,
};

export class SqlAdapter implements DatabaseAdapter<UnitOfWorkConfig> {
  readonly dialect: Dialect;
  readonly driverConfig: DriverConfig;
  readonly uowConfig?: UnitOfWorkConfig;
  readonly sqliteStorageMode?: SQLiteStorageMode;
  readonly sqliteProfile?: SQLiteProfile;
  readonly adapterMetadata: DatabaseAdapterMetadata;

  #schemaNamespaceMap = new WeakMap<AnySchema, string>();
  #contextStorage: RequestContextStorage<DatabaseContextStorage>;

  #driver: SqlDriverAdapter;

  constructor({
    dialect,
    driverConfig,
    uowConfig,
    sqliteProfile,
    sqliteStorageMode,
  }: SqlAdapterOptions) {
    this.dialect = dialect;
    this.driverConfig = driverConfig;
    this.uowConfig = uowConfig;
    const resolvedProfile = sqliteProfile ?? "default";

    if (sqliteStorageMode && sqliteProfile) {
      throw new Error("sqliteStorageMode cannot be used together with sqliteProfile.");
    }

    this.sqliteStorageMode =
      driverConfig.databaseType === "sqlite"
        ? (sqliteStorageMode ?? sqliteProfiles[resolvedProfile])
        : undefined;
    this.sqliteProfile =
      driverConfig.databaseType === "sqlite" && !sqliteStorageMode ? resolvedProfile : undefined;

    this.adapterMetadata = {
      databaseType: driverConfig.databaseType,
      sqliteProfile: this.sqliteProfile,
      sqliteStorageMode: this.sqliteStorageMode,
    };

    this.#schemaNamespaceMap = new WeakMap<AnySchema, string>();
    this.#contextStorage = new RequestContextStorage();

    this.#driver = new SqlDriverAdapter(dialect);
  }

  get driver(): SqlDriverAdapter {
    return this.#driver;
  }

  get [fragnoDatabaseAdapterNameFakeSymbol](): string {
    return "sql";
  }

  get [fragnoDatabaseAdapterVersionFakeSymbol](): number {
    return 1;
  }

  get contextStorage(): RequestContextStorage<DatabaseContextStorage> {
    return this.#contextStorage;
  }

  close(): Promise<void> {
    return this.#driver.destroy();
  }

  async isConnectionHealthy(): Promise<boolean> {
    const result = await this.#driver.executeQuery(sql`SELECT 1 as healthy`.compile(this.dialect));
    const healthyValue = result.rows[0]?.["healthy"];
    return healthyValue === 1 || healthyValue === 1n || healthyValue === "1";
  }

  prepareMigrations<T extends AnySchema>(schema: T, namespace: string): PreparedMigrations {
    return createPreparedMigrations({
      schema,
      namespace,
      database: this.driverConfig.databaseType,
      driverConfig: this.driverConfig,
      sqliteStorageMode: this.sqliteStorageMode,
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

    const operationCompiler = new GenericSQLUOWOperationCompiler(
      this.driverConfig,
      this.sqliteStorageMode,
      (ns) => (ns ? this.createTableNameMapper(ns) : undefined),
    );

    const factory: UnitOfWorkFactory = {
      compiler: createUOWCompilerFromOperationCompiler(operationCompiler),
      executor: createExecutor(this.#driver, this.driverConfig, false),
      decoder: new UnitOfWorkDecoder(this.driverConfig, this.sqliteStorageMode),
      uowConfig: this.uowConfig,
      schemaNamespaceMap: this.#schemaNamespaceMap,
    };

    return fromUnitOfWorkCompiler(schema, factory) as SimpleQueryInterface<T, UnitOfWorkConfig>;
  }
}

export type { SQLiteStorageMode } from "./sqlite-storage";
export { sqliteStorageDefault, sqliteStoragePrisma } from "./sqlite-storage";
