import type { DatabaseAdapter } from "./adapters/adapters";
import type { AnySchema } from "./schema/create";
import type { AbstractQuery } from "./query/query";

export type { DatabaseAdapter };

export const fragnoDatabaseFakeSymbol = "$fragno-database" as const;
export const fragnoDatabaseLibraryVersion = "0.1" as const;

export interface CreateFragnoDatabaseDefinitionOptions<T extends AnySchema> {
  namespace: string;
  schema: T;
}

export function isFragnoDatabase(value: unknown): value is FragnoDatabase<AnySchema> {
  if (value instanceof FragnoDatabase) {
    return true;
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  return (
    fragnoDatabaseFakeSymbol in value &&
    value[fragnoDatabaseFakeSymbol] === fragnoDatabaseFakeSymbol
  );
}

/**
 * Definition of a Fragno database schema and namespace.
 * Created by library authors using defineFragnoDatabase().
 * Apps instantiate it by calling .create(adapter).
 */
export class FragnoDatabaseDefinition<const T extends AnySchema> {
  #namespace: string;
  #schema: T;

  constructor(options: CreateFragnoDatabaseDefinitionOptions<T>) {
    this.#namespace = options.namespace;
    this.#schema = options.schema;
  }

  get namespace() {
    return this.#namespace;
  }

  get schema() {
    return this.#schema;
  }

  /**
   * Creates a FragnoDatabase instance by binding an adapter to this definition.
   */
  create(adapter: DatabaseAdapter): FragnoDatabase<T> {
    return new FragnoDatabase({
      namespace: this.#namespace,
      schema: this.#schema,
      adapter,
    });
  }
}

/**
 * A Fragno database instance with a bound adapter.
 * Created from a FragnoDatabaseDefinition by calling .create(adapter).
 */
export class FragnoDatabase<const T extends AnySchema> {
  #namespace: string;
  #schema: T;
  #adapter: DatabaseAdapter;

  constructor(options: { namespace: string; schema: T; adapter: DatabaseAdapter }) {
    this.#namespace = options.namespace;
    this.#schema = options.schema;
    this.#adapter = options.adapter;
  }

  get [fragnoDatabaseFakeSymbol](): typeof fragnoDatabaseFakeSymbol {
    return fragnoDatabaseFakeSymbol;
  }

  async createClient(): Promise<AbstractQuery<T>> {
    const dbVersion = await this.#adapter.getSchemaVersion(this.#namespace);
    if (dbVersion !== this.#schema.version.toString()) {
      throw new Error(
        `Database is not at expected version. Did you forget to run migrations?` +
          ` Current version: ${dbVersion}, Expected version: ${this.#schema.version}`,
      );
    }

    return this.#adapter.createQueryEngine(this.#schema, this.#namespace);
  }

  async runMigrations(): Promise<boolean> {
    if (!this.#adapter.createMigrationEngine) {
      throw new Error("Migration engine not supported for this adapter.");
    }

    const migrator = this.#adapter.createMigrationEngine(this.#schema, this.#namespace);
    const preparedMigration = await migrator.prepareMigration();
    await preparedMigration.execute();

    return preparedMigration.operations.length > 0;
  }

  get namespace() {
    return this.#namespace;
  }

  get schema() {
    return this.#schema;
  }

  get adapter() {
    return this.#adapter;
  }

  async generateSchema(options?: {
    path?: string;
    toVersion?: number;
    fromVersion?: number;
  }): Promise<{ schema: string; path: string }> {
    const adapter = this.#adapter;

    if (adapter.createSchemaGenerator) {
      if (options?.toVersion !== undefined || options?.fromVersion !== undefined) {
        console.warn("⚠️ toVersion and fromVersion are not supported for schema generation.");
      }

      const generator = adapter.createSchemaGenerator(this.#schema, this.#namespace);
      const defaultPath = options?.path ?? "schema.ts";
      return generator.generateSchema({
        path: defaultPath,
        toVersion: options?.toVersion,
        fromVersion: options?.fromVersion,
      });
    }

    if (adapter.createMigrationEngine) {
      const migrator = adapter.createMigrationEngine(this.#schema, this.#namespace);
      const targetVersion = options?.toVersion ?? this.#schema.version;
      const sourceVersion = options?.fromVersion;

      // Get current version for file naming if not provided
      const currentVersion = sourceVersion ?? (await migrator.getVersion());

      // Determine the default path using the migrator's getDefaultFileName if available
      const defaultPath =
        options?.path ??
        (migrator.getDefaultFileName
          ? migrator.getDefaultFileName(this.#namespace, currentVersion, targetVersion)
          : "schema.sql");

      // Generate migration from source to target version
      const preparedMigration = await migrator.prepareMigrationTo(targetVersion, {
        updateSettings: true,
        fromVersion: sourceVersion,
      });

      if (!preparedMigration.getSQL) {
        throw new Error(
          "Migration engine does not support SQL generation. Ensure your adapter's migration engine provides getSQL().",
        );
      }

      const sql = preparedMigration.getSQL();

      // If no migrations needed, return informative message
      if (!sql.trim()) {
        throw new Error("No migrations needed. Database is already at the target version.");
      }

      return {
        schema: sql,
        path: defaultPath,
      };
    }

    throw new Error(
      "Adapter does not support schema generation. Ensure your adapter implements either createSchemaGenerator or createMigrationEngine.",
    );
  }
}

export function defineFragnoDatabase<const TSchema extends AnySchema>(
  options: CreateFragnoDatabaseDefinitionOptions<TSchema>,
): FragnoDatabaseDefinition<TSchema> {
  return new FragnoDatabaseDefinition(options);
}
