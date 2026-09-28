import { RequestContextStorage } from "@fragno-dev/core/internal/request-context-storage";
import superjson, { type SuperJSONResult } from "superjson";

import { internalSchema } from "../../fragments/internal-fragment.schema";
import { getOutboxConfigForAdapter } from "../../internal/outbox-state";
import {
  createNamingResolver,
  suffixNamingStrategy,
  type SqlNamingStrategy,
} from "../../naming/sql-naming";
import { assembleOutboxEntry } from "../../outbox/assemble-outbox-entry";
import type { OutboxEntry, OutboxOperation } from "../../outbox/outbox";
import type { OutboxStreamOptions, SerializedOutboxStreamEntry } from "../../outbox/outbox-stream";
import { serializeOutboxStreamEntry } from "../../outbox/serialized-outbox-stream-entry";
import {
  UnitOfWork,
  type RetrievalOperation,
  type UnitOfWorkConfig,
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

type OutboxEntryWithMutations = Omit<OutboxEntry, "payload"> & {
  mutations: Array<{ payload: SuperJSONResult }>;
};

export class InMemoryAdapter implements DatabaseAdapter<InMemoryUowConfig> {
  readonly options: ResolvedInMemoryAdapterOptions;
  readonly namingStrategy: SqlNamingStrategy;

  readonly #contextStorage: RequestContextStorage<DatabaseContextStorage>;
  readonly #store = createInMemoryStore();
  readonly #schemaNamespaceMap = new WeakMap<AnySchema, string | null>();
  readonly #schemaByNamespace = new Map<string, { schema: AnySchema; namespace: string | null }>();

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

  /** In-memory iteration buffers one explicitly bounded page before yielding its decoded rows. */
  async *streamRetrieval(operation: RetrievalOperation<AnySchema>): AsyncIterableIterator<unknown> {
    if (operation.type !== "find" || operation.withCursor || operation.withSingleResult) {
      throw new Error("InMemoryAdapter.streamRetrieval requires a multi-row find operation.");
    }
    if (
      operation.options.pageSize === undefined ||
      !Number.isSafeInteger(operation.options.pageSize) ||
      operation.options.pageSize < 1
    ) {
      throw new Error(
        "InMemoryAdapter.streamRetrieval buffered-page execution requires a positive page size.",
      );
    }
    const uow = this.createBaseUnitOfWork();
    (uow as UnitOfWork).addRetrievalOperation(operation);
    const [result] = await uow.executeRetrieve();
    for (const row of result as unknown[]) {
      yield row;
    }
  }

  async *streamSerializedOutboxEntries(
    options: OutboxStreamOptions,
  ): AsyncIterableIterator<SerializedOutboxStreamEntry> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new Error("InMemoryAdapter.streamSerializedOutboxEntries requires a positive limit.");
    }

    const afterValue = options.afterVersionstamp?.toLowerCase();
    const uow = this.createUnitOfWork(internalSchema, null, "internal.outbox.stream");
    uow.find("fragno_db_outbox", (builder) => {
      const entries = afterValue
        ? builder.whereIndex("idx_outbox_versionstamp", (expression) =>
            expression("versionstamp", ">", afterValue),
          )
        : builder.whereIndex("idx_outbox_versionstamp");
      return entries
        .orderByIndex("idx_outbox_versionstamp", "asc")
        .pageSize(options.limit)
        .joinMany("mutations", "fragno_db_outbox_mutations", (mutations) =>
          mutations
            .onIndex("idx_outbox_mutations_entry_order", (expression) =>
              expression("entryVersionstamp", "=", expression.parent("versionstamp")),
            )
            .orderByIndex("idx_outbox_mutations_entry_order", "asc")
            .select(["payload"]),
        );
    });

    const [operation] = uow.getRetrievalOperations();
    if (!operation) {
      throw new Error("In-memory outbox stream find operation was not recorded.");
    }
    for await (const result of this.streamRetrieval(operation)) {
      const entry = result as OutboxEntryWithMutations;
      const operations = entry.mutations.map((mutation) =>
        superjson.deserialize<OutboxOperation>(mutation.payload),
      );
      yield serializeOutboxStreamEntry(
        assembleOutboxEntry({ ...entry, refMap: entry.refMap }, operations),
      );
    }
  }

  registerSchema(schema: AnySchema, namespace: string | null): void {
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
    const compiler = createInMemoryUowCompiler({
      now: this.options.clock.now,
      createId: this.options.idGenerator,
    });
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
    const compiler = createInMemoryUowCompiler({
      now: this.options.clock.now,
      createId: this.options.idGenerator,
    });
    const executor = createInMemoryUowExecutor(
      this.#store,
      this.options,
      resolverFactory,
      this.#schemaByNamespace,
    );
    const decoder = new InMemoryUowDecoder(resolverFactory);

    return new UnitOfWork(compiler, executor, decoder, name, config, this.#schemaNamespaceMap);
  }

  prepareMigrations(schema: AnySchema, namespace: string | null) {
    this.registerSchema(schema, namespace);

    return {
      async execute() {
        return;
      },
      async executeWithDriver() {
        return;
      },
      getSQL() {
        return "";
      },
      compile() {
        return {
          statements: [],
          sql: [],
          fromVersion: 0,
          toVersion: schema.version,
        };
      },
    };
  }
}
