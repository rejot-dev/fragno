import { RequestContextStorage } from "@fragno-dev/core/internal/request-context-storage";

import { FragnoDatabase } from "../../fragno-database";
import { getOutboxConfigForAdapter } from "../../internal/outbox-state";
import {
  createNamingResolver,
  suffixNamingStrategy,
  type SqlNamingStrategy,
} from "../../naming/sql-naming";
import { UnitOfWork, type UnitOfWorkConfig } from "../../query/unit-of-work/unit-of-work";
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
import { createInMemoryStore, ensureNamespaceStore } from "./store";

export type InMemoryUowConfig = UnitOfWorkConfig;

export class InMemoryAdapter implements DatabaseAdapter<InMemoryUowConfig> {
  readonly options: ResolvedInMemoryAdapterOptions;
  readonly namingStrategy: SqlNamingStrategy;

  #contextStorage: RequestContextStorage<DatabaseContextStorage>;
  #store = createInMemoryStore();
  #schemaNamespaceMap = new WeakMap<AnySchema, string | null>();
  #schemaByNamespace = new Map<string, { schema: AnySchema; namespace: string | null }>();

  constructor(options: InMemoryAdapterOptions = {}) {
    this.options = resolveInMemoryAdapterOptions(options);
    this.namingStrategy = options.namingStrategy ?? suffixNamingStrategy;
    this.#contextStorage = new RequestContextStorage();
    this.options.outbox = getOutboxConfigForAdapter(this);
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
    );
    const decoder = new InMemoryUowDecoder(resolverFactory);

    return new UnitOfWork(
      compiler,
      executor,
      decoder,
      name,
      config,
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

    return new UnitOfWork(compiler, executor, decoder, name, config, this.#schemaNamespaceMap);
  }

  createQueryEngine<T extends AnySchema>(
    schema: T,
    namespace: string | null,
  ): FragnoDatabase<T, InMemoryUowConfig> {
    this.registerSchema(schema, namespace);
    return new FragnoDatabase({ adapter: this, schema, namespace });
  }
}
