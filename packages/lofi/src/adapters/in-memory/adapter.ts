import type { AnySchema, AnyTable } from "@fragno-dev/db/schema";
import type {
  InMemoryLofiAdapterOptions,
  LofiAdapter,
  LofiMutation,
  LofiQueryEngineOptions,
  LofiQueryInterface,
  LofiQueryableAdapter,
} from "../../types";
import { createInMemoryQueryEngine } from "./query";
import { InMemoryLofiStore } from "./store";

type InboxRow = {
  sourceKey: string;
  uowId: string;
  versionstamp: string;
  receivedAt: number;
};

export class InMemoryLofiAdapter implements LofiAdapter, LofiQueryableAdapter {
  readonly endpointName: string;
  readonly schemas: AnySchema[];
  readonly store: InMemoryLofiStore;
  private readonly schemaMap: Map<string, AnySchema>;
  private readonly tableMap: Map<string, Map<string, AnyTable>>;
  private readonly ignoreUnknownSchemas: boolean;
  private readonly meta = new Map<string, string>();
  private readonly inbox = new Map<string, InboxRow>();

  constructor(options: InMemoryLofiAdapterOptions) {
    if (!options.endpointName || options.endpointName.trim().length === 0) {
      throw new Error("InMemoryLofiAdapter requires a non-empty endpointName.");
    }

    const schemaMap = new Map<string, AnySchema>();
    const tableMap = new Map<string, Map<string, AnyTable>>();

    for (const schema of options.schemas) {
      if (!schema.name || schema.name.trim().length === 0) {
        throw new Error("InMemoryLofiAdapter schemas must have a non-empty name.");
      }
      if (schemaMap.has(schema.name)) {
        throw new Error(`InMemoryLofiAdapter schema name must be unique: ${schema.name}`);
      }
      schemaMap.set(schema.name, schema);
      const tables = new Map<string, AnyTable>();
      for (const [tableName, table] of Object.entries(schema.tables)) {
        tables.set(tableName, table);
      }
      tableMap.set(schema.name, tables);
    }

    this.endpointName = options.endpointName;
    this.schemas = [...schemaMap.values()];
    this.schemaMap = schemaMap;
    this.tableMap = tableMap;
    this.ignoreUnknownSchemas = options.ignoreUnknownSchemas ?? false;
    this.store =
      options.store ??
      new InMemoryLofiStore({
        endpointName: this.endpointName,
        schemas: this.schemas,
      });
  }

  async applyOutboxEntry(options: {
    sourceKey: string;
    versionstamp: string;
    uowId: string;
    mutations: LofiMutation[];
  }): Promise<{ applied: boolean }> {
    const inboxKey = `${options.sourceKey}::${options.uowId}::${options.versionstamp}`;
    if (this.inbox.has(inboxKey)) {
      return { applied: false };
    }

    const knownMutations: LofiMutation[] = [];
    for (const mutation of options.mutations) {
      const schema = this.schemaMap.get(mutation.schema);
      if (!schema) {
        if (this.ignoreUnknownSchemas) {
          continue;
        }
        throw new Error(`Unknown outbox schema: ${mutation.schema}`);
      }
      const table = this.tableMap.get(mutation.schema)?.get(mutation.table);
      if (!table) {
        if (this.ignoreUnknownSchemas) {
          continue;
        }
        throw new Error(`Unknown outbox table: ${mutation.schema}.${mutation.table}`);
      }
      knownMutations.push(mutation);
    }

    if (knownMutations.length > 0) {
      this.store.applyMutations(knownMutations);
    }

    this.inbox.set(inboxKey, {
      sourceKey: options.sourceKey,
      uowId: options.uowId,
      versionstamp: options.versionstamp,
      receivedAt: Date.now(),
    });

    return { applied: true };
  }

  async applyMutations(mutations: LofiMutation[]): Promise<void> {
    if (mutations.length === 0) {
      return;
    }

    const knownMutations: LofiMutation[] = [];
    for (const mutation of mutations) {
      const schema = this.schemaMap.get(mutation.schema);
      if (!schema) {
        if (this.ignoreUnknownSchemas) {
          continue;
        }
        throw new Error(`Unknown mutation schema: ${mutation.schema}`);
      }
      const table = this.tableMap.get(mutation.schema)?.get(mutation.table);
      if (!table) {
        if (this.ignoreUnknownSchemas) {
          continue;
        }
        throw new Error(`Unknown mutation table: ${mutation.schema}.${mutation.table}`);
      }
      knownMutations.push(mutation);
    }

    if (knownMutations.length > 0) {
      this.store.applyMutations(knownMutations);
    }
  }

  async getMeta(key: string): Promise<string | undefined> {
    return this.meta.get(key);
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.meta.set(key, value);
  }

  createQueryEngine<const T extends AnySchema>(
    schema: T,
    options?: LofiQueryEngineOptions,
  ): LofiQueryInterface<T> {
    return createInMemoryQueryEngine({
      schema,
      store: this.store,
      schemaName: options?.schemaName,
    });
  }

  clear(): void {
    this.store.clear();
    this.inbox.clear();
  }

  reset(): void {
    this.clear();
  }
}
