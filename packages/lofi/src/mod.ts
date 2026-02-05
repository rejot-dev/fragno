import type { AnySchema } from "@fragno-dev/db/schema";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";

export type LofiClientOptions = {
  outboxUrl: string;
  endpointName: string;
  adapter: LofiAdapter;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  limit?: number;
  cursorKey?: string;
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
};

export type LofiSyncResult = {
  appliedEntries: number;
  lastVersionstamp?: string;
};

export type LofiSchemaRegistration = { schema: AnySchema };

export type LofiAdapter = {
  applyOutboxEntry(options: {
    sourceKey: string;
    versionstamp: string;
    mutations: LofiMutation[];
  }): Promise<{ applied: boolean }>;
  applyMutations?(mutations: LofiMutation[]): Promise<void>;
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;
};

export type IndexedDbAdapterOptions = {
  dbName?: string;
  endpointName: string;
  schemas: LofiSchemaRegistration[];
};

export type LofiQueryInterface<TSchema extends AnySchema> = {
  find: SimpleQueryInterface<TSchema>["find"];
  findFirst: SimpleQueryInterface<TSchema>["findFirst"];
  findWithCursor: SimpleQueryInterface<TSchema>["findWithCursor"];
};

export type LofiQueryEngineOptions = {
  schemaName?: string;
};

export interface LofiQueryableAdapter {
  createQueryEngine<const T extends AnySchema>(
    schema: T,
    options?: LofiQueryEngineOptions,
  ): LofiQueryInterface<T>;
}

export type LofiMutation =
  | {
      op: "create";
      schema: string;
      table: string;
      externalId: string;
      values: Record<string, unknown>;
      versionstamp: string;
    }
  | {
      op: "update";
      schema: string;
      table: string;
      externalId: string;
      set: Record<string, unknown>;
      versionstamp: string;
    }
  | {
      op: "delete";
      schema: string;
      table: string;
      externalId: string;
      versionstamp: string;
    };

export class LofiClient {
  constructor(_options: LofiClientOptions) {}

  start(_options?: { signal?: AbortSignal }): void {
    throw new Error("LofiClient is not implemented yet.");
  }

  stop(): void {
    throw new Error("LofiClient is not implemented yet.");
  }

  async syncOnce(_options?: { signal?: AbortSignal }): Promise<LofiSyncResult> {
    throw new Error("LofiClient is not implemented yet.");
  }
}

export class IndexedDbAdapter implements LofiAdapter, LofiQueryableAdapter {
  constructor(_options: IndexedDbAdapterOptions) {}

  async applyOutboxEntry(_options: {
    sourceKey: string;
    versionstamp: string;
    mutations: LofiMutation[];
  }): Promise<{ applied: boolean }> {
    throw new Error("IndexedDbAdapter is not implemented yet.");
  }

  async getMeta(_key: string): Promise<string | undefined> {
    throw new Error("IndexedDbAdapter is not implemented yet.");
  }

  async setMeta(_key: string, _value: string): Promise<void> {
    throw new Error("IndexedDbAdapter is not implemented yet.");
  }

  createQueryEngine<const T extends AnySchema>(
    _schema: T,
    _options?: LofiQueryEngineOptions,
  ): LofiQueryInterface<T> {
    throw new Error("IndexedDbAdapter is not implemented yet.");
  }
}

export function decodeOutboxPayload(_payload: unknown): unknown {
  throw new Error("decodeOutboxPayload is not implemented yet.");
}

export function resolveOutboxRefs<T extends Record<string, unknown>>(
  _mutation: T,
  _refMap: Record<string, string>,
): T {
  throw new Error("resolveOutboxRefs is not implemented yet.");
}

export function outboxMutationsToUowOperations(
  _mutations: LofiMutation[],
  _schemaMap: Record<string, AnySchema>,
): unknown[] {
  throw new Error("outboxMutationsToUowOperations is not implemented yet.");
}
