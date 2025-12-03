import { RequestContextStorage } from "@fragno-dev/core/internal/request-context-storage";
import {
  fragnoDatabaseAdapterNameFakeSymbol,
  fragnoDatabaseAdapterVersionFakeSymbol,
  type DatabaseAdapter,
  type DatabaseContextStorage,
  type TableNameMapper,
} from "../adapters";
import type { CompiledQuery, Dialect } from "../../sql-driver/sql-driver";
import { SqlDriverAdapter } from "../../sql-driver/sql-driver-adapter";
import { sql } from "../../sql-driver/sql";
import type { AnySchema } from "../../schema/create";
import type { Migrator } from "../../migration-engine/create";
import type { SchemaGenerator } from "../../schema-generator/schema-generator";
import { createTableNameMapper } from "../kysely/kysely-shared";
import type { AbstractQuery } from "../../query/query";
import { createExecutor } from "./generic-sql-uow-executor";
import { fromKysely, createKyselyUOWDecoder, type KyselyUOWConfig } from "../kysely/kysely-query";
import { createKyselyUOWCompiler } from "../kysely/kysely-uow-compiler";
import { createPreparedMigrations, type PreparedMigrations } from "./migration/prepared-migrations";
import type { SupportedDatabase } from "./migration/cold-kysely";

export type SupportedDriverTypes = "sqlite-sqlocal" | "postgresql-pg" | "mysql-mysql2";
export type SupportedDatabases = SupportedDatabase;

export interface GenericSQLConfig {
  onQuery?: (query: CompiledQuery) => void;
  dryRun?: boolean;
}

export interface GenericSQLOptions {
  dialect: Dialect;
  driver: SupportedDriverTypes;
  config?: GenericSQLConfig;
}

export class GenericSQLAdapter implements DatabaseAdapter<KyselyUOWConfig> {
  #dialect: Dialect;
  #driverType: SupportedDriverTypes;
  #config?: GenericSQLConfig;

  #schemaNamespaceMap = new WeakMap<AnySchema, string>();
  #contextStorage: RequestContextStorage<DatabaseContextStorage>;

  #driver: SqlDriverAdapter;

  constructor({ dialect, driver, config }: GenericSQLOptions) {
    this.#dialect = dialect;
    this.#driverType = driver;
    this.#config = config;

    this.#schemaNamespaceMap = new WeakMap<AnySchema, string>();
    this.#contextStorage = new RequestContextStorage();

    this.#driver = new SqlDriverAdapter(dialect);
  }

  get databaseType(): SupportedDatabases {
    return this.#driverType.split("-")[0] as SupportedDatabases;
  }

  get dialect(): Dialect {
    return this.#dialect;
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
    const result = await this.#driver.executeQuery(sql`SELECT 1 as healthy`.build());
    return result.rows[0]["healthy"] === 1;
  }

  createMigrationEngine(_schema: AnySchema, _namespace: string): Migrator {
    throw new Error("Not implemented");
  }

  prepareMigrations<T extends AnySchema>(schema: T, namespace: string): PreparedMigrations {
    return createPreparedMigrations({
      schema,
      namespace,
      database: this.databaseType,
    });
  }

  createSchemaGenerator(_fragments: { schema: AnySchema; namespace: string }[]): SchemaGenerator {
    throw new Error("Not implemented");
  }

  createTableNameMapper(namespace: string): TableNameMapper {
    return createTableNameMapper(namespace);
  }

  async getSchemaVersion(namespace: string): Promise<string | undefined> {
    const key = `${namespace}.schema_version`;
    const result = await this.#driver.executeQuery(
      sql`SELECT value FROM fragno_db_settings WHERE key = ${key}`.build(),
    );
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
  ): AbstractQuery<T, KyselyUOWConfig> {
    this.#schemaNamespaceMap.set(schema, namespace);

    const mapper = namespace ? createTableNameMapper(namespace) : undefined;
    const compiler = createKyselyUOWCompiler(this.databaseType, mapper);
    const executor = createExecutor(this.#driver, false);
    const decoder = createKyselyUOWDecoder(this.databaseType);

    return fromKysely(schema, compiler, executor, decoder, this.#config, this.#schemaNamespaceMap);
  }
}
