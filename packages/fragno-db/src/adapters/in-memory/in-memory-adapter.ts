import { RequestContextStorage } from "@fragno-dev/core/internal/request-context-storage";

import { FragnoDatabase } from "../../fragno-database";
import { getOutboxConfigForAdapter } from "../../internal/outbox-state";
import {
  createNamingResolver,
  suffixNamingStrategy,
  type SqlNamingStrategy,
} from "../../naming/sql-naming";
import { createShardQueryPolicy } from "../../query/unit-of-work/query-policies";
import {
  UnitOfWork,
  type UnitOfWorkConfig,
  type QueryPolicyEntry,
} from "../../query/unit-of-work/unit-of-work";
import type { AnySchema } from "../../schema/create";
import {
  fragnoDatabaseAdapterNameFakeSymbol,
  fragnoDatabaseAdapterVersionFakeSymbol,
  type DatabaseAdapter,
  type DatabaseContextStorage,
} from "../adapters";
import {
  createInMemoryUowCompiler,
  createInMemoryUowExecutor,
  InMemoryUowDecoder,
} from "./in-memory-uow";
import {
  resolveInMemoryAdapterOptions,
  type InMemoryAdapterOptions,
  type ResolvedInMemoryAdapterOptions,
} from "./options";
import { createInMemoryStore, ensureNamespaceStore, type InMemoryStore } from "./store";

export type InMemoryUowConfig = UnitOfWorkConfig;

const mergeUowConfigs = (
  base?: UnitOfWorkConfig,
  override?: UnitOfWorkConfig,
): UnitOfWorkConfig | undefined => {
  if (!base && !override) {
    return undefined;
  }

  const merged: UnitOfWorkConfig = {
    ...base,
    ...override,
  };

  const mergedPolicies: QueryPolicyEntry[] = [...(base?.queryPolicies ?? [])];
  if (override?.queryPolicies && override.queryPolicies.length > 0) {
    const indexByName = new Map<string, number>();
    for (let i = 0; i < mergedPolicies.length; i += 1) {
      indexByName.set(mergedPolicies[i]!.policy.name, i);
    }
    for (const policy of override.queryPolicies) {
      const existingIndex = indexByName.get(policy.policy.name);
      if (existingIndex === undefined) {
        indexByName.set(policy.policy.name, mergedPolicies.length);
        mergedPolicies.push(policy);
      } else {
        mergedPolicies[existingIndex] = policy;
      }
    }
  }
  if (mergedPolicies.length > 0) {
    merged.queryPolicies = mergedPolicies;
  }

  return merged;
};

export class InMemoryAdapter implements DatabaseAdapter<InMemoryUowConfig> {
  readonly options: ResolvedInMemoryAdapterOptions;
  readonly namingStrategy: SqlNamingStrategy;

  #contextStorage: RequestContextStorage<DatabaseContextStorage>;
  #store = createInMemoryStore();
  #schemaNamespaceMap = new WeakMap<AnySchema, string | null>();
  #schemaByNamespace = new Map<string, { schema: AnySchema; namespace: string | null }>();

  constructor(options: InMemoryAdapterOptions = {}, internals?: { store?: InMemoryStore }) {
    this.options = resolveInMemoryAdapterOptions(options);
    this.namingStrategy = options.namingStrategy ?? suffixNamingStrategy;
    this.#store = internals?.store ?? createInMemoryStore();
    this.#contextStorage = new RequestContextStorage();
    this.options.outbox = getOutboxConfigForAdapter(this);
  }

  fork(): InMemoryAdapter {
    return new InMemoryAdapter(
      {
        clock: this.options.clock,
        idGenerator: this.options.idGenerator,
        internalIdGenerator: this.options.internalIdGenerator,
        enforceConstraints: this.options.enforceConstraints,
        btreeOrder: this.options.btreeOrder,
        namingStrategy: this.namingStrategy,
      },
      { store: this.#store },
    );
  }

  get [fragnoDatabaseAdapterNameFakeSymbol](): string {
    return "in-memory";
  }

  get [fragnoDatabaseAdapterVersionFakeSymbol](): number {
    return 0;
  }

  get contextStorage(): RequestContextStorage<DatabaseContextStorage> {
    return this.#contextStorage;
  }

  async getSchemaVersion(_namespace: string): Promise<string | undefined> {
    return undefined;
  }

  async isConnectionHealthy(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    return;
  }

  async reset(): Promise<void> {
    this.#store.namespaces.clear();
    for (const [namespaceKey, { schema, namespace }] of this.#schemaByNamespace) {
      const resolver = createNamingResolver(schema, namespace, this.namingStrategy);
      ensureNamespaceStore(this.#store, namespaceKey, schema, resolver);
    }
  }

  registerSchema<T extends AnySchema>(schema: T, namespace: string | null): void {
    this.#schemaNamespaceMap.set(schema, namespace);
    const namespaceKey = namespace ?? schema.name;
    this.#schemaByNamespace.set(namespaceKey, { schema, namespace });
    const resolver = createNamingResolver(schema, namespace, this.namingStrategy);
    ensureNamespaceStore(this.#store, namespaceKey, schema, resolver);
  }

  createUnitOfWork<T extends AnySchema>(
    schema: T,
    namespace: string | null,
    name?: string,
    config?: InMemoryUowConfig,
  ) {
    this.registerSchema(schema, namespace);

    const resolverFactory = (schemaForResolver: AnySchema, namespaceForResolver: string | null) =>
      createNamingResolver(schemaForResolver, namespaceForResolver, this.namingStrategy);
    const compiler = createInMemoryUowCompiler();
    const executor = createInMemoryUowExecutor(
      this.#store,
      this.options,
      resolverFactory,
      this.#schemaByNamespace,
      () => (this.#contextStorage.hasStore() ? this.#contextStorage.getStore().shard : null),
    );
    const decoder = new InMemoryUowDecoder(resolverFactory);

    const shardPolicy = createShardQueryPolicy({
      shardingStrategy: undefined,
      getShard: () =>
        this.#contextStorage.hasStore() ? this.#contextStorage.getStore().shard : null,
      getShardScope: () =>
        this.#contextStorage.hasStore() ? this.#contextStorage.getStore().shardScope : "scoped",
    });

    const baseUowConfig: UnitOfWorkConfig = {
      queryPolicies: [
        {
          policy: shardPolicy,
          getContext: () => ({}),
        },
      ],
    };

    return new UnitOfWork(
      compiler,
      executor,
      decoder,
      name,
      mergeUowConfigs(baseUowConfig, config),
      this.#schemaNamespaceMap,
    ).forSchema(schema);
  }

  createBaseUnitOfWork(name?: string, config?: InMemoryUowConfig) {
    const resolverFactory = (schemaForResolver: AnySchema, namespaceForResolver: string | null) =>
      createNamingResolver(schemaForResolver, namespaceForResolver, this.namingStrategy);
    const compiler = createInMemoryUowCompiler();
    const executor = createInMemoryUowExecutor(
      this.#store,
      this.options,
      resolverFactory,
      this.#schemaByNamespace,
    );
    const decoder = new InMemoryUowDecoder(resolverFactory);

    const shardPolicy = createShardQueryPolicy({
      shardingStrategy: undefined,
      getShard: () =>
        this.#contextStorage.hasStore() ? this.#contextStorage.getStore().shard : null,
      getShardScope: () =>
        this.#contextStorage.hasStore() ? this.#contextStorage.getStore().shardScope : "scoped",
    });

    const baseUowConfig: UnitOfWorkConfig = {
      queryPolicies: [
        {
          policy: shardPolicy,
          getContext: () => ({}),
        },
      ],
    };

    return new UnitOfWork(
      compiler,
      executor,
      decoder,
      name,
      mergeUowConfigs(baseUowConfig, config),
      this.#schemaNamespaceMap,
    );
  }

  createQueryEngine<T extends AnySchema>(
    schema: T,
    namespace: string | null,
  ): FragnoDatabase<T, InMemoryUowConfig> {
    this.registerSchema(schema, namespace);
    return new FragnoDatabase({ adapter: this, schema, namespace });
  }
}
