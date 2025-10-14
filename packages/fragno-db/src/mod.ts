import type { DatabaseAdapter } from "./adapters/adapters";
import type { AnySchema } from "./schema/create";
import type { AbstractQuery } from "./query/query";

export interface CreateFragnoDatabaseOptions<T extends AnySchema> {
  namespace: string;
  schema: T;
}

export class FragnoDatabase<const T extends AnySchema> {
  #namespace: string;
  #schema: T;

  constructor(options: CreateFragnoDatabaseOptions<T>) {
    this.#namespace = options.namespace;
    this.#schema = options.schema;
  }

  async createClient(adapter: DatabaseAdapter): Promise<AbstractQuery<T>> {
    const dbVersion = await adapter.getSchemaVersion(this.#namespace);
    if (dbVersion !== this.#schema.version.toString()) {
      throw new Error(`Database is not at expected version. Did you forget to run migrations?`);
    }

    return adapter.createQueryEngine(this.#schema, this.#namespace);
  }

  async runMigrations(adapter: DatabaseAdapter): Promise<boolean> {
    if (!adapter.createMigrationEngine) {
      throw new Error("Migration engine not supported for this adapter.");
    }

    const migrator = adapter.createMigrationEngine(this.#schema, this.#namespace);
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
}

export function createFragnoDatabase<T extends AnySchema>(
  options: CreateFragnoDatabaseOptions<T>,
): FragnoDatabase<T> {
  return new FragnoDatabase(options);
}
