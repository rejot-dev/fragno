import type { DatabaseAdapter } from "./adapters/adapters";
import type { AnySchema } from "./schema/create";
import type { AbstractQuery } from "./query/query";

export const isFragnoDatabaseIdentifier = "$fragno-db" as const;
export const fragnoDatabaseLibraryVersion = "0.1" as const;

export interface FragnoDatabaseIdentifier {
  namespace: string;
  version: typeof fragnoDatabaseLibraryVersion;
  identifier: typeof isFragnoDatabaseIdentifier;
}

export interface CreateFragnoDatabaseOptions<T extends AnySchema> {
  namespace: string;
  schema: T;
  /**
   * Optional lazy adapter factory. If provided, the adapter will be created
   * on-demand when needed (useful for CLI tools that import without executing).
   */
  getAdapter?: () => Promise<DatabaseAdapter> | DatabaseAdapter;
}

export function isFragnoDatabase(value: unknown): value is FragnoDatabase<AnySchema> {
  if (value instanceof FragnoDatabase) {
    return true;
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (
    !("isFragnoDatabase" in value) ||
    typeof value.isFragnoDatabase !== "object" ||
    value.isFragnoDatabase === null
  ) {
    return false;
  }

  return (
    "identifier" in value.isFragnoDatabase &&
    value.isFragnoDatabase.identifier === isFragnoDatabaseIdentifier
  );
}

export class FragnoDatabase<const T extends AnySchema> {
  #namespace: string;
  #schema: T;
  #adapter?: DatabaseAdapter;
  #getAdapter?: () => Promise<DatabaseAdapter> | DatabaseAdapter;

  constructor(options: CreateFragnoDatabaseOptions<T>) {
    this.#namespace = options.namespace;
    this.#schema = options.schema;
    this.#getAdapter = options.getAdapter;
  }

  get isFragnoDatabase(): FragnoDatabaseIdentifier {
    return {
      namespace: this.#namespace,
      version: fragnoDatabaseLibraryVersion,
      identifier: isFragnoDatabaseIdentifier,
    };
  }

  async #ensureAdapter(providedAdapter?: DatabaseAdapter): Promise<DatabaseAdapter> {
    if (providedAdapter) {
      return providedAdapter;
    }
    if (this.#adapter) {
      return this.#adapter;
    }
    if (this.#getAdapter) {
      this.#adapter = await this.#getAdapter();
      return this.#adapter;
    }
    throw new Error(
      "No adapter available. Either pass an adapter to createClient(), bind one with withAdapter(), or provide getAdapter in constructor.",
    );
  }

  async createClient(adapter?: DatabaseAdapter): Promise<AbstractQuery<T>> {
    const resolvedAdapter = await this.#ensureAdapter(adapter);

    const dbVersion = await resolvedAdapter.getSchemaVersion(this.#namespace);
    if (dbVersion !== this.#schema.version.toString()) {
      throw new Error(
        `Database is not at expected version. Did you forget to run migrations?` +
          ` Current version: ${dbVersion}, Expected version: ${this.#schema.version}`,
      );
    }

    return resolvedAdapter.createQueryEngine(this.#schema, this.#namespace);
  }

  async runMigrations(adapter?: DatabaseAdapter): Promise<boolean> {
    const resolvedAdapter = await this.#ensureAdapter(adapter);
    if (!resolvedAdapter.createMigrationEngine) {
      throw new Error("Migration engine not supported for this adapter.");
    }

    const migrator = resolvedAdapter.createMigrationEngine(this.#schema, this.#namespace);
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

  /**
   * Binds an adapter to this FragnoDatabase instance.
   * This is useful for CLI tools that need to access the adapter.
   */
  withAdapter(adapter: DatabaseAdapter): this {
    this.#adapter = adapter;
    return this;
  }

  /**
   * Generates schema files based on the adapter type.
   * For Kysely: generates SQL migration file
   * For Drizzle: generates TypeScript schema file
   */
  generateSchema(options?: { path?: string }): { schema: string; path: string } {
    if (!this.#adapter) {
      throw new Error(
        "No adapter bound to this FragnoDatabase instance. Call withAdapter() first.",
      );
    }

    // Try Drizzle schema generator first
    if (this.#adapter.createSchemaGenerator) {
      const generator = this.#adapter.createSchemaGenerator(this.#schema, this.#namespace);
      const defaultPath = options?.path ?? "schema.ts";
      return generator.generateSchema({ path: defaultPath });
    }

    // Try Kysely migration engine with SQL generation
    if (this.#adapter.createMigrationEngine) {
      throw new Error(
        "Kysely adapter migration engine requires async operation. Use generateSchemaAsync() instead.",
      );
    }

    throw new Error(
      "Adapter does not support schema generation. Ensure your adapter implements either createSchemaGenerator or createMigrationEngine.",
    );
  }

  /**
   * Async version of generateSchema for adapters that require async operations.
   *
   * For migration-based adapters (Kysely), this will:
   * 1. Check the current database version
   * 2. Generate migrations only for the difference between current and target version
   *
   * For schema generation adapters (Drizzle), this generates the full schema.
   */
  async generateSchemaAsync(options?: {
    path?: string;
  }): Promise<{ schema: string; path: string }> {
    const adapter = await this.#ensureAdapter();

    // Try Drizzle schema generator first
    if (adapter.createSchemaGenerator) {
      const generator = adapter.createSchemaGenerator(this.#schema, this.#namespace);
      const defaultPath = options?.path ?? "schema.ts";
      return generator.generateSchema({ path: defaultPath });
    }

    // Try Kysely migration engine with SQL generation
    if (adapter.createMigrationEngine) {
      const migrator = adapter.createMigrationEngine(this.#schema, this.#namespace);
      const defaultPath = options?.path ?? "schema.sql";

      const targetVersion = this.#schema.version;

      // Generate migration from current to target version
      const preparedMigration = await migrator.prepareMigrationTo(targetVersion, {
        updateSettings: true,
      });

      if (!preparedMigration.getSQL) {
        throw new Error(
          "Migration engine does not support SQL generation. Ensure your adapter's migration engine provides getSQL().",
        );
      }

      const sql = preparedMigration.getSQL();

      // If no migrations needed, return informative message
      if (!sql.trim()) {
        return {
          schema: "-- Database is already at the target version. No migrations needed.",
          path: defaultPath,
        };
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

export function createFragnoDatabase<T extends AnySchema>(
  options: CreateFragnoDatabaseOptions<T>,
): FragnoDatabase<T> {
  return new FragnoDatabase(options);
}
