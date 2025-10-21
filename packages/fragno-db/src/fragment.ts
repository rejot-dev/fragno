import type { AnySchema } from "./schema/create";
import type { AbstractQuery } from "./query/query";
import type { DatabaseAdapter } from "./adapters/adapters";
import type { FragnoPublicConfig, FragmentDefinition } from "@fragno-dev/core";

/**
 * Extended FragnoPublicConfig that includes a database adapter.
 * Use this type when creating fragments with database support.
 */
export type FragnoPublicConfigWithDatabase = FragnoPublicConfig & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  databaseAdapter: DatabaseAdapter<any>;
};

/**
 * Additional context provided to database fragments containing the database adapter and ORM instance.
 */
export type DatabaseFragmentContext<TSchema extends AnySchema> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  databaseAdapter: DatabaseAdapter<any>;
  orm: AbstractQuery<TSchema>;
};

export class DatabaseFragmentBuilder<
  const TSchema extends AnySchema,
  const TConfig,
  const TDeps = {},
  const TServices extends Record<string, unknown> = {},
> {
  #name: string;
  #schema?: TSchema;
  #namespace?: string;
  #dependencies?: (
    context: {
      config: TConfig;
      fragnoConfig: FragnoPublicConfig;
    } & DatabaseFragmentContext<TSchema>,
  ) => TDeps;
  #services?: (
    context: {
      config: TConfig;
      fragnoConfig: FragnoPublicConfig;
      deps: TDeps;
    } & DatabaseFragmentContext<TSchema>,
  ) => TServices;

  constructor(options: {
    name: string;
    schema?: TSchema;
    namespace?: string;
    dependencies?: (
      context: {
        config: TConfig;
        fragnoConfig: FragnoPublicConfig;
      } & DatabaseFragmentContext<TSchema>,
    ) => TDeps;
    services?: (
      context: {
        config: TConfig;
        fragnoConfig: FragnoPublicConfig;
        deps: TDeps;
      } & DatabaseFragmentContext<TSchema>,
    ) => TServices;
  }) {
    this.#name = options.name;
    this.#schema = options.schema;
    this.#namespace = options.namespace;
    this.#dependencies = options.dependencies;
    this.#services = options.services;
  }

  get $requiredOptions(): FragnoPublicConfigWithDatabase {
    throw new Error("Type only method. Do not call.");
  }

  get definition(): FragmentDefinition<TConfig, TDeps, TServices> {
    const schema = this.#schema;
    const namespace = this.#namespace ?? "";
    const name = this.#name;
    const dependencies = this.#dependencies;
    const services = this.#services;

    return {
      name,
      dependencies: (config: TConfig, options: FragnoPublicConfig) => {
        const dbContext = this.#createDatabaseContext(options, schema, namespace, name);
        return dependencies?.({ config, fragnoConfig: options, ...dbContext }) ?? ({} as TDeps);
      },
      services: (config: TConfig, options: FragnoPublicConfig, deps: TDeps) => {
        const dbContext = this.#createDatabaseContext(options, schema, namespace, name);
        return (
          services?.({ config, fragnoConfig: options, deps, ...dbContext }) ?? ({} as TServices)
        );
      },
      additionalContext: {
        databaseSchema: schema,
        databaseNamespace: namespace,
      },
    };
  }

  #createDatabaseContext(
    options: FragnoPublicConfig,
    schema: TSchema | undefined,
    namespace: string,
    name: string,
  ): DatabaseFragmentContext<TSchema> {
    // Safe cast: FragnoPublicConfig is extended with databaseAdapter by the user
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const databaseAdapter = (options as any).databaseAdapter as DatabaseAdapter<any> | undefined;

    if (!databaseAdapter) {
      throw new Error(`Fragment '${name}' requires a database adapter in options.databaseAdapter`);
    }
    if (!schema) {
      throw new Error(`Fragment '${name}' requires a schema. Use withDatabase() to provide one.`);
    }

    // Safe cast: we create a query engine for TSchema and know it will be AbstractQuery<TSchema>
    const orm = databaseAdapter.createQueryEngine(
      schema,
      namespace,
    ) as unknown as AbstractQuery<TSchema>;

    return { databaseAdapter, orm };
  }

  withDatabase<TNewSchema extends AnySchema>(
    schema: TNewSchema,
    namespace?: string,
  ): DatabaseFragmentBuilder<TNewSchema, TConfig, TDeps, TServices> {
    return new DatabaseFragmentBuilder<TNewSchema, TConfig, TDeps, TServices>({
      name: this.#name,
      schema,
      namespace: namespace ?? this.#name + "-db",
      dependencies: this.#dependencies as
        | ((
            context: {
              config: TConfig;
              fragnoConfig: FragnoPublicConfig;
            } & DatabaseFragmentContext<TNewSchema>,
          ) => TDeps)
        | undefined,
      services: this.#services as
        | ((
            context: {
              config: TConfig;
              fragnoConfig: FragnoPublicConfig;
              deps: TDeps;
            } & DatabaseFragmentContext<TNewSchema>,
          ) => TServices)
        | undefined,
    });
  }

  withDependencies<TNewDeps>(
    fn: (
      context: {
        config: TConfig;
        fragnoConfig: FragnoPublicConfig;
      } & DatabaseFragmentContext<TSchema>,
    ) => TNewDeps,
  ): DatabaseFragmentBuilder<TSchema, TConfig, TNewDeps, {}> {
    return new DatabaseFragmentBuilder<TSchema, TConfig, TNewDeps, {}>({
      name: this.#name,
      schema: this.#schema,
      namespace: this.#namespace,
      dependencies: fn,
      services: undefined,
    });
  }

  withServices<TNewServices extends Record<string, unknown>>(
    fn: (
      context: {
        config: TConfig;
        fragnoConfig: FragnoPublicConfig;
        deps: TDeps;
      } & DatabaseFragmentContext<TSchema>,
    ) => TNewServices,
  ): DatabaseFragmentBuilder<TSchema, TConfig, TDeps, TNewServices> {
    return new DatabaseFragmentBuilder<TSchema, TConfig, TDeps, TNewServices>({
      name: this.#name,
      schema: this.#schema,
      namespace: this.#namespace,
      dependencies: this.#dependencies,
      services: fn,
    });
  }
}

export function defineFragmentWithDatabase<TConfig = {}>(
  name: string,
): DatabaseFragmentBuilder<never, TConfig, {}, {}> {
  return new DatabaseFragmentBuilder<never, TConfig, {}, {}>({
    name,
  });
}
