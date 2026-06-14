import { InMemoryAdapter, type InMemoryAdapterOptions } from "@fragno-dev/db/adapters/in-memory";

import type {
  BackofficeDatabaseAdapterFactory,
  BackofficeDatabaseAdapterKind,
  BackofficeDatabaseAdapterScope,
  CreateBackofficeDatabaseAdapterInput,
} from "./database-adapters";

export type InMemoryBackofficeDatabaseAdapters = BackofficeDatabaseAdapterFactory & {
  cleanup(): Promise<void>;
  reset(): Promise<void>;
};

type InMemoryBackofficeDatabaseAdaptersInternals = {
  adapters: Map<string, InMemoryAdapter>;
};

const sharedDatabaseKinds = new Set<BackofficeDatabaseAdapterKind>(["automations", "pi"]);

const normalizeKeyPart = (value: string | undefined, fallback: string) => {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
};

const createAdapterKey = (
  scope: BackofficeDatabaseAdapterScope | undefined,
  input: CreateBackofficeDatabaseAdapterInput,
) => {
  const scopeId = normalizeKeyPart(scope?.id, "singleton");

  if (sharedDatabaseKinds.has(input.kind)) {
    return `${scopeId}:${input.kind}`;
  }

  const databaseName = normalizeKeyPart(input.databaseName, "default");
  return `${scopeId}:${input.kind}:${databaseName}`;
};

export const createInMemoryBackofficeDatabaseAdapters = (
  options: {
    adapterOptions?: InMemoryAdapterOptions;
  } = {},
  scope?: BackofficeDatabaseAdapterScope,
  internals: InMemoryBackofficeDatabaseAdaptersInternals = { adapters: new Map() },
): InMemoryBackofficeDatabaseAdapters => {
  const { adapters } = internals;

  const getAdapter = (input: CreateBackofficeDatabaseAdapterInput) => {
    const key = createAdapterKey(scope, input);
    const existing = adapters.get(key);
    if (existing) {
      return existing;
    }

    const adapter = new InMemoryAdapter(options.adapterOptions);
    adapters.set(key, adapter);
    return adapter;
  };

  return {
    createAdapter(input) {
      return getAdapter(input);
    },
    forScope(nextScope) {
      return createInMemoryBackofficeDatabaseAdapters(options, nextScope, internals);
    },
    async reset() {
      await Promise.all([...adapters.values()].map(async (adapter) => await adapter.reset()));
    },
    async cleanup() {
      await Promise.all([...adapters.values()].map(async (adapter) => await adapter.close()));
      adapters.clear();
    },
  };
};
