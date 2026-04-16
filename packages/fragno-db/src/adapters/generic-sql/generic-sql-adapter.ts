import { RequestContextStorage } from "@fragno-dev/core/internal/request-context-storage";

import { FragnoDatabase } from "../../fragno-database";
import { getOutboxConfigForAdapter } from "../../internal/outbox-state";
import {
  createNamingResolver,
  type NamingResolver,
  type SqlNamingStrategy,
} from "../../naming/sql-naming";
import type {
  CompiledMutation,
  UOWExecutor,
  UOWInstrumentation,
  UnitOfWorkConfig as BaseUnitOfWorkConfig,
} from "../../query/unit-of-work/unit-of-work";
import { UnitOfWork } from "../../query/unit-of-work/unit-of-work";
import type { AnySchema } from "../../schema/create";
import { sql } from "../../sql-driver/sql";
import type { CompiledQuery, Dialect, QueryResult } from "../../sql-driver/sql-driver";
import { SqlDriverAdapter } from "../../sql-driver/sql-driver-adapter";
import {
  fragnoDatabaseAdapterNameFakeSymbol,
  fragnoDatabaseAdapterVersionFakeSymbol,
  type DatabaseAdapter,
  type DatabaseContextStorage,
  type DatabaseAdapterMetadata,
  type SQLiteProfile,
} from "../adapters";
import { createUOWCompilerFromOperationCompiler } from "../shared/uow-operation-compiler";
import type { DriverConfig } from "./driver-config";
import { createExecutor } from "./generic-sql-uow-executor";
import { createPreparedMigrations, type PreparedMigrations } from "./migration/prepared-migrations";
import { GenericSQLUOWOperationCompiler } from "./query/generic-sql-uow-operation-compiler";
import type { SQLiteStorageMode } from "./sqlite-storage";
import { sqliteStorageDefault, sqliteStoragePrisma } from "./sqlite-storage";
import { UnitOfWorkDecoder } from "./uow-decoder";

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
  namingStrategy?: SqlNamingStrategy;
}

export const sqliteProfiles: Record<SQLiteProfile, SQLiteStorageMode> = {
  default: sqliteStorageDefault,
  prisma: sqliteStoragePrisma,
};

function isCompiledMutation(query: unknown): query is CompiledMutation<CompiledQuery> {
  return (
    query !== null &&
    typeof query === "object" &&
    "expectedAffectedRows" in query &&
    "query" in query
  );
}

export class SqlAdapter implements DatabaseAdapter<UnitOfWorkConfig> {
  readonly dialect: Dialect;
  readonly driverConfig: DriverConfig;
  readonly uowConfig?: UnitOfWorkConfig;
  readonly sqliteStorageMode?: SQLiteStorageMode;
  readonly sqliteProfile?: SQLiteProfile;
  readonly adapterMetadata: DatabaseAdapterMetadata;
  readonly namingStrategy: SqlNamingStrategy;

  #schemaNamespaceMap = new WeakMap<AnySchema, string | null>();
  #contextStorage: RequestContextStorage<DatabaseContextStorage>;

  #driver: SqlDriverAdapter;

  constructor({
    dialect,
    driverConfig,
    uowConfig,
    sqliteProfile,
    sqliteStorageMode,
    namingStrategy,
  }: SqlAdapterOptions) {
    this.dialect = dialect;
    this.driverConfig = driverConfig;
    this.uowConfig = uowConfig;
    this.namingStrategy = namingStrategy ?? driverConfig.defaultNamingStrategy;
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

    this.#schemaNamespaceMap = new WeakMap<AnySchema, string | null>();
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

  prepareMigrations<T extends AnySchema>(schema: T, namespace: string | null): PreparedMigrations {
    const resolver = createNamingResolver(schema, namespace, this.namingStrategy);
    return createPreparedMigrations({
      schema,
      namespace: namespace ?? schema.name,
      database: this.driverConfig.databaseType,
      driverConfig: this.driverConfig,
      sqliteStorageMode: this.sqliteStorageMode,
      resolver,
      driver: this.#driver,
    });
  }

  #normalizeUowConfig(config?: UnitOfWorkConfig): BaseUnitOfWorkConfig | undefined {
    if (!config) {
      return undefined;
    }

    const { onQuery, ...restUowConfig } = config;
    return {
      ...restUowConfig,
      onQuery: onQuery
        ? (query) => {
            const actualQuery = isCompiledMutation(query) ? query.query : (query as CompiledQuery);
            onQuery(actualQuery);
          }
        : undefined,
    };
  }

  #createOperationCompiler() {
    return new GenericSQLUOWOperationCompiler(
      this.driverConfig,
      this.sqliteStorageMode,
      (schemaForResolver, namespaceForResolver): NamingResolver =>
        createNamingResolver(schemaForResolver, namespaceForResolver, this.namingStrategy),
    );
  }

  registerSchema<T extends AnySchema>(schema: T, namespace: string | null): void {
    this.#schemaNamespaceMap.set(schema, namespace);
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

  createUnitOfWork<T extends AnySchema>(
    schema: T,
    namespace: string | null,
    name?: string,
    config?: UnitOfWorkConfig,
  ): ReturnType<FragnoDatabase<T, UnitOfWorkConfig>["createUnitOfWork"]> {
    this.registerSchema(schema, namespace);
    return this.createBaseUnitOfWork(name, config).forSchema(schema);
  }

  createBaseUnitOfWork(
    name?: string,
    config?: UnitOfWorkConfig,
  ): ReturnType<FragnoDatabase<AnySchema, UnitOfWorkConfig>["createBaseUnitOfWork"]> {
    const compiler = createUOWCompilerFromOperationCompiler(this.#createOperationCompiler());
    const executor: UOWExecutor<CompiledQuery, unknown> = createExecutor(
      this.#driver,
      this.driverConfig,
      {
        dialect: this.dialect,
        dryRun: false,
        outbox: getOutboxConfigForAdapter(this),
        namingStrategy: this.namingStrategy,
      },
    );
    const decoder = new UnitOfWorkDecoder(this.driverConfig, this.sqliteStorageMode);

    return new UnitOfWork(
      compiler,
      executor,
      decoder,
      name,
      this.#normalizeUowConfig({ ...this.uowConfig, ...config }),
      this.#schemaNamespaceMap,
    );
  }

  createQueryEngine<T extends AnySchema>(
    schema: T,
    namespace: string | null,
  ): FragnoDatabase<T, UnitOfWorkConfig> {
    this.registerSchema(schema, namespace);
    return new FragnoDatabase({ adapter: this, schema, namespace });
  }
}

export type { SQLiteStorageMode } from "./sqlite-storage";
export { sqliteStorageDefault, sqliteStoragePrisma } from "./sqlite-storage";
export type { OutboxConfig } from "../../outbox/outbox";
