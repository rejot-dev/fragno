import type { DatabaseAdapter } from "./adapters/adapters";
import type { IUnitOfWork, TypedUnitOfWork } from "./query/unit-of-work/unit-of-work";
import type { AnySchema } from "./schema/create";

export const fragnoDatabaseFakeSymbol = "$fragno-database" as const;

export interface CreateFragnoDatabaseDefinitionOptions<T extends AnySchema> {
  namespace: string | null;
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
 * A Fragno database instance with a bound adapter.
 * Created from a FragnoDatabaseDefinition by calling .create(adapter).
 */
export class FragnoDatabase<const T extends AnySchema, TUOWConfig = void> {
  #namespace: string | null;
  #schema: T;
  #adapter: DatabaseAdapter<TUOWConfig>;

  constructor(options: {
    namespace: string | null;
    schema: T;
    adapter: DatabaseAdapter<TUOWConfig>;
  }) {
    this.#namespace = options.namespace;
    this.#schema = options.schema;
    this.#adapter = options.adapter;
    this.#adapter.registerSchema(this.#schema, this.#namespace);
  }

  get [fragnoDatabaseFakeSymbol](): typeof fragnoDatabaseFakeSymbol {
    return fragnoDatabaseFakeSymbol;
  }

  get namespace() {
    return this.#namespace;
  }

  get schema() {
    return this.#schema;
  }

  get adapter(): DatabaseAdapter<TUOWConfig> {
    return this.#adapter;
  }

  createUnitOfWork = (name?: string, config?: TUOWConfig): TypedUnitOfWork<T, [], unknown> => {
    return this.#adapter.createUnitOfWork(this.#schema, this.#namespace, name, config);
  };

  createBaseUnitOfWork = (name?: string, config?: TUOWConfig): IUnitOfWork => {
    this.#adapter.registerSchema(this.#schema, this.#namespace);
    const uow = this.#adapter.createBaseUnitOfWork(name, config);
    uow.registerSchema(this.#schema, this.#namespace);
    return uow;
  };
}
