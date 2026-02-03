import { RequestContextStorage } from "@fragno-dev/core/internal/request-context-storage";
import {
  fragnoDatabaseAdapterNameFakeSymbol,
  fragnoDatabaseAdapterVersionFakeSymbol,
  type DatabaseAdapter,
  type DatabaseContextStorage,
  type DatabaseAdapterMetadata,
  type SQLiteProfile,
} from "../adapters";
import type { CompiledQuery, Dialect, QueryResult } from "../../sql-driver/sql-driver";
import { SqlDriverAdapter } from "../../sql-driver/sql-driver-adapter";
import { sql } from "../../sql-driver/sql";
import type { AnyColumn, AnySchema } from "../../schema/create";
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
import type { OutboxConfig } from "../../outbox/outbox";
import { createSQLSerializer } from "../../query/serialize/create-sql-serializer";
import {
  createNamingResolver,
  type NamingResolver,
  type SqlNamingStrategy,
} from "../../naming/sql-naming";

export interface UnitOfWorkConfig {
  onQuery?: (query: CompiledQuery) => void;
  dryRun?: boolean;
  instrumentation?: UOWInstrumentation;
}

export interface SqlAdapterOptions {
  dialect: Dialect;
  driverConfig: DriverConfig;
  uowConfig?: UnitOfWorkConfig;
  outbox?: OutboxConfig;
  sqliteProfile?: SQLiteProfile;
  sqliteStorageMode?: SQLiteStorageMode;
  namingStrategy?: SqlNamingStrategy;
}

export const sqliteProfiles: Record<SQLiteProfile, SQLiteStorageMode> = {
  default: sqliteStorageDefault,
  prisma: sqliteStoragePrisma,
};

export class SqlAdapter implements DatabaseAdapter<UnitOfWorkConfig> {
  readonly dialect: Dialect;
  readonly driverConfig: DriverConfig;
  readonly uowConfig?: UnitOfWorkConfig;
  readonly outbox?: OutboxConfig;
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
    outbox,
    sqliteProfile,
    sqliteStorageMode,
    namingStrategy,
  }: SqlAdapterOptions) {
    this.dialect = dialect;
    this.driverConfig = driverConfig;
    this.uowConfig = uowConfig;
    this.outbox = outbox;
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
    namespace: string | null,
  ): SimpleQueryInterface<T, UnitOfWorkConfig> {
    this.#schemaNamespaceMap.set(schema, namespace);
    const resolver = createNamingResolver(schema, namespace, this.namingStrategy);

    const operationCompiler = new GenericSQLUOWOperationCompiler(
      this.driverConfig,
      this.sqliteStorageMode,
      (schemaForResolver, namespaceForResolver): NamingResolver =>
        createNamingResolver(schemaForResolver, namespaceForResolver, this.namingStrategy),
    );

    const factory: UnitOfWorkFactory = {
      compiler: createUOWCompilerFromOperationCompiler(operationCompiler),
      executor: createExecutor(this.#driver, this.driverConfig, {
        dialect: this.dialect,
        dryRun: false,
        outbox: this.outbox,
        namingStrategy: this.namingStrategy,
      }),
      decoder: new UnitOfWorkDecoder(this.driverConfig, this.sqliteStorageMode, resolver),
      uowConfig: this.uowConfig,
      schemaNamespaceMap: this.#schemaNamespaceMap,
    };

    const queryEngine = fromUnitOfWorkCompiler(schema, factory) as SimpleQueryInterface<
      T,
      UnitOfWorkConfig
    >;

    const serializer = createSQLSerializer(this.driverConfig, this.sqliteStorageMode);
    const timestampColumn = { type: "timestamp" } as AnyColumn;

    return {
      ...queryEngine,
      now: async () => {
        const result = await this.#driver.executeQuery(
          sql`SELECT CURRENT_TIMESTAMP as now`.compile(this.dialect),
        );
        const rawValue = result.rows[0]?.["now"];
        if (rawValue === undefined || rawValue === null) {
          throw new Error("Failed to fetch database time");
        }
        return serializer.deserialize(rawValue, timestampColumn) as Date;
      },
    };
  }
}

export type { SQLiteStorageMode } from "./sqlite-storage";
export { sqliteStorageDefault, sqliteStoragePrisma } from "./sqlite-storage";
export type { OutboxConfig } from "../../outbox/outbox";
