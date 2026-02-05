import { RequestContextStorage } from "@fragno-dev/core/internal/request-context-storage";
import {
  fragnoDatabaseAdapterNameFakeSymbol,
  fragnoDatabaseAdapterVersionFakeSymbol,
  type DatabaseAdapter,
  type DatabaseContextStorage,
} from "../adapters";
import type { AnySchema, AnyTable, FragnoId } from "../../schema/create";
import type { SimpleQueryInterface, TableToUpdateValues } from "../../query/simple-query-interface";
import {
  resolveInMemoryAdapterOptions,
  type InMemoryAdapterOptions,
  type ResolvedInMemoryAdapterOptions,
} from "./options";
import { createInMemoryStore, ensureNamespaceStore } from "./store";
import {
  createInMemoryUowCompiler,
  createInMemoryUowExecutor,
  InMemoryUowDecoder,
} from "./in-memory-uow";
import { UnitOfWork, type UnitOfWorkConfig } from "../../query/unit-of-work/unit-of-work";
import type { CursorResult } from "../../query/cursor";
import {
  createNamingResolver,
  suffixNamingStrategy,
  type SqlNamingStrategy,
} from "../../naming/sql-naming";

class UpdateManySpecialBuilder<TTable extends AnyTable> {
  #indexName?: string;
  #condition?: unknown;
  #setValues?: TableToUpdateValues<TTable>;

  whereIndex(indexName: string, condition?: unknown): this {
    this.#indexName = indexName;
    this.#condition = condition;
    return this;
  }

  set(values: TableToUpdateValues<TTable>): this {
    this.#setValues = values;
    return this;
  }

  getConfig() {
    return {
      indexName: this.#indexName,
      condition: this.#condition,
      setValues: this.#setValues,
    };
  }
}

const hasIdField = (record: unknown): record is { id: string | FragnoId } =>
  record !== null && typeof record === "object" && "id" in record;

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

  createQueryEngine<T extends AnySchema>(
    schema: T,
    namespace: string | null,
  ): SimpleQueryInterface<T, InMemoryUowConfig> {
    this.#schemaNamespaceMap.set(schema, namespace);
    const namespaceKey = namespace ?? schema.name;
    this.#schemaByNamespace.set(namespaceKey, { schema, namespace });
    const resolverFactory = (schemaForResolver: AnySchema, namespaceForResolver: string | null) =>
      createNamingResolver(schemaForResolver, namespaceForResolver, this.namingStrategy);
    const resolver = resolverFactory(schema, namespace);
    ensureNamespaceStore(this.#store, namespaceKey, schema, resolver);

    const compiler = createInMemoryUowCompiler();
    const executor = createInMemoryUowExecutor(
      this.#store,
      this.options,
      resolverFactory,
      this.#schemaByNamespace,
    );
    const decoder = new InMemoryUowDecoder(resolverFactory);

    const createUow = (opts?: { name?: string; config?: UnitOfWorkConfig }) =>
      new UnitOfWork(
        compiler,
        executor,
        decoder,
        opts?.name,
        opts?.config,
        this.#schemaNamespaceMap,
      ).forSchema(schema);

    const queryEngine = {
      now: async () => this.options.clock.now(),
      async find(tableName, builderFn) {
        const uow = createUow();
        uow.find(tableName, builderFn);
        const [result]: unknown[][] = await uow.executeRetrieve();
        return result ?? [];
      },

      async findWithCursor(tableName, builderFn) {
        const uow = createUow().findWithCursor(tableName, builderFn);
        const [result] = await uow.executeRetrieve();
        return result as CursorResult<unknown>;
      },

      async findFirst(tableName, builderFn) {
        const uow = createUow();
        if (builderFn) {
          uow.find(tableName, (b) => {
            builderFn(b);
            return b.pageSize(1);
          });
        } else {
          uow.find(tableName, (b) => b.whereIndex("primary").pageSize(1));
        }
        const [result]: unknown[][] = await uow.executeRetrieve();
        return result?.[0] ?? null;
      },

      async create(tableName, values) {
        const uow = createUow();
        uow.create(tableName, values);
        const { success } = await uow.executeMutations();
        if (!success) {
          throw new Error("Failed to create record");
        }

        const createdId = uow.getCreatedIds()[0];
        if (!createdId) {
          throw new Error("Failed to get created ID");
        }
        return createdId;
      },

      async createMany(tableName, valuesArray) {
        const uow = createUow();
        for (const values of valuesArray) {
          uow.create(tableName, values);
        }
        const { success } = await uow.executeMutations();
        if (!success) {
          throw new Error("Failed to create records");
        }
        return uow.getCreatedIds();
      },

      async update(tableName, id, builderFn) {
        const uow = createUow();
        uow.update(tableName, id, builderFn);
        const { success } = await uow.executeMutations();
        if (!success) {
          throw new Error("Failed to update record (version conflict or record not found)");
        }
      },

      async updateMany(tableName, builderFn) {
        const table = schema.tables[tableName];
        if (!table) {
          throw new Error(`Table ${tableName} not found in schema`);
        }

        const specialBuilder = new UpdateManySpecialBuilder<typeof table>();
        builderFn(specialBuilder);
        const { indexName, condition, setValues } = specialBuilder.getConfig();

        if (!indexName) {
          throw new Error("whereIndex() must be called in updateMany");
        }
        if (!setValues) {
          throw new Error("set() must be called in updateMany");
        }

        const findUow = createUow();
        findUow.find(tableName, (b) => {
          if (condition !== undefined && condition !== null) {
            return b.whereIndex(indexName as never, condition as never);
          }
          return b.whereIndex(indexName as never);
        });
        const [records]: unknown[][] = await findUow.executeRetrieve();

        if (!records || records.length === 0) {
          return;
        }

        const updateUow = createUow();
        for (const record of records) {
          if (!hasIdField(record)) {
            throw new Error("Record missing id field");
          }
          updateUow.update(tableName, record.id, (b) => b.set(setValues).check());
        }
        const { success } = await updateUow.executeMutations();
        if (!success) {
          throw new Error("Failed to update records (version conflict)");
        }
      },

      async delete(tableName, id, builderFn) {
        const uow = createUow();
        uow.delete(tableName, id, builderFn);
        const { success } = await uow.executeMutations();
        if (!success) {
          throw new Error("Failed to delete record (version conflict or record not found)");
        }
      },

      async deleteMany(tableName, builderFn) {
        const findUow = createUow();
        findUow.find(tableName, builderFn);
        const [records]: unknown[][] = await findUow.executeRetrieve();

        if (!records || records.length === 0) {
          return;
        }

        const deleteUow = createUow();
        for (const record of records) {
          if (!hasIdField(record)) {
            throw new Error("Record missing id field");
          }
          deleteUow.delete(tableName, record.id);
        }
        const { success } = await deleteUow.executeMutations();
        if (!success) {
          throw new Error("Failed to delete records (version conflict)");
        }
      },

      createUnitOfWork(name, config) {
        return createUow({ name, config });
      },
    } as SimpleQueryInterface<T, InMemoryUowConfig>;
    return queryEngine;
  }
}
