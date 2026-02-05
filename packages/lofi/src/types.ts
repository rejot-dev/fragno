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
    uowId: string;
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
  ignoreUnknownSchemas?: boolean;
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
