import { instantiate } from "@fragno-dev/core";
import type { DatabaseAdapter } from "../adapters/adapters";
import {
  SchemaRegistryCollisionError,
  internalFragmentDef,
  type InternalFragmentInstance,
} from "../fragments/internal-fragment";
import {
  internalFragmentDescribeRoutes,
  internalFragmentOutboxRoutes,
} from "../fragments/internal-fragment.routes";

export type SchemaInfo = {
  name: string;
  namespace: string | null;
  version: number;
  tables: string[];
};

export type FragmentMeta = {
  name: string;
  mountRoute: string;
};

export type AdapterRegistry = {
  internalFragment: InternalFragmentInstance;
  schemas: Map<string, SchemaInfo>;
  fragments: Map<string, FragmentMeta>;
  registerSchema: (schema: SchemaInfo, fragment: FragmentMeta) => void;
  listSchemas: () => SchemaInfo[];
  listFragments: () => FragmentMeta[];
};

type AdapterKey = DatabaseAdapter<unknown>;

const registryByAdapter = new WeakMap<AdapterKey, AdapterRegistry>();

const toAdapterKey = <TUOWConfig>(adapter: DatabaseAdapter<TUOWConfig>): AdapterKey =>
  adapter as AdapterKey;

const isDryRun = (): boolean => process.env["FRAGNO_INIT_DRY_RUN"] === "true";

const getNamespaceKey = (schema: SchemaInfo): string => schema.namespace ?? schema.name;

const sortSchemas = (schemas: SchemaInfo[]): SchemaInfo[] =>
  schemas.sort((a, b) => {
    const namespaceA = a.namespace ?? "";
    const namespaceB = b.namespace ?? "";
    if (namespaceA !== namespaceB) {
      return namespaceA.localeCompare(namespaceB);
    }
    if (a.name !== b.name) {
      return a.name.localeCompare(b.name);
    }
    return a.version - b.version;
  });

const sortFragments = (fragments: FragmentMeta[]): FragmentMeta[] =>
  fragments.sort((a, b) => a.name.localeCompare(b.name));

const buildInternalFragment = (
  adapter: DatabaseAdapter<unknown>,
  registry: AdapterRegistry,
): InternalFragmentInstance => {
  const outboxEnabled = (adapter as { outbox?: { enabled?: boolean } }).outbox?.enabled ?? false;
  const routes = [
    internalFragmentDescribeRoutes,
    ...(outboxEnabled ? [internalFragmentOutboxRoutes] : []),
  ];

  return instantiate(internalFragmentDef)
    .withConfig({
      registry,
      outbox: { enabled: outboxEnabled },
    })
    .withOptions({ databaseAdapter: adapter, databaseNamespace: null })
    .withRoutes(routes)
    .build();
};

const createRegistry = (adapter: DatabaseAdapter<unknown>): AdapterRegistry => {
  const schemas = new Map<string, SchemaInfo>();
  const fragments = new Map<string, FragmentMeta>();
  let registry: AdapterRegistry;

  registry = {
    internalFragment: undefined as unknown as InternalFragmentInstance,
    schemas,
    fragments,
    registerSchema: (schema, fragment) => {
      const namespaceKey = getNamespaceKey(schema);
      const existing = schemas.get(namespaceKey);
      if (existing && (existing.name !== schema.name || existing.namespace !== schema.namespace)) {
        throw new SchemaRegistryCollisionError({
          namespaceKey,
          existing: { name: existing.name, namespace: existing.namespace },
          attempted: { name: schema.name, namespace: schema.namespace },
        });
      }
      const schemaCopy = { ...schema, tables: [...schema.tables] };
      if (
        existing &&
        existing.name === schemaCopy.name &&
        existing.namespace === schemaCopy.namespace &&
        existing.version === schemaCopy.version &&
        existing.tables.length === schemaCopy.tables.length &&
        existing.tables.every((table, index) => table === schemaCopy.tables[index])
      ) {
        fragments.set(fragment.name, { ...fragment });
        return;
      }
      schemas.set(namespaceKey, schemaCopy);
      fragments.set(fragment.name, { ...fragment });
    },
    listSchemas: () => sortSchemas([...schemas.values()]),
    listFragments: () => sortFragments([...fragments.values()]),
  };

  registry.internalFragment = buildInternalFragment(adapter, registry);
  return registry;
};

export const getRegistryForAdapterSync = <TUOWConfig>(
  adapter: DatabaseAdapter<TUOWConfig>,
): AdapterRegistry => {
  const adapterKey = toAdapterKey(adapter);
  const existing = registryByAdapter.get(adapterKey);
  if (existing) {
    return existing;
  }
  if (isDryRun()) {
    throw new Error("Adapter registry is unavailable during dry-run initialization.");
  }

  const registry = createRegistry(adapterKey);
  registryByAdapter.set(adapterKey, registry);
  return registry;
};

export const getInternalFragment = <TUOWConfig>(
  adapter: DatabaseAdapter<TUOWConfig>,
): InternalFragmentInstance => {
  const adapterKey = toAdapterKey(adapter);
  if (isDryRun()) {
    return instantiate(internalFragmentDef)
      .withOptions({ databaseAdapter: adapterKey, databaseNamespace: null })
      .build();
  }
  return getRegistryForAdapterSync(adapterKey).internalFragment;
};
