import { instantiate } from "@fragno-dev/core";
import type { DatabaseAdapter } from "../adapters/adapters";
import type { OutboxConfig } from "../outbox/outbox";
import type { MutationOperation } from "../query/unit-of-work/unit-of-work";
import {
  SchemaRegistryCollisionError,
  internalFragmentDef,
  type InternalFragmentInstance,
} from "../fragments/internal-fragment";
import {
  internalFragmentDescribeRoutes,
  internalFragmentOutboxRoutes,
} from "../fragments/internal-fragment.routes";
import type { AnySchema } from "../schema/create";

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
  outboxState: OutboxState;
  registerSchema: (
    schema: SchemaInfo,
    fragment: FragmentMeta,
    options?: { outboxEnabled?: boolean },
  ) => void;
  listSchemas: () => SchemaInfo[];
  listFragments: () => FragmentMeta[];
  listOutboxFragments: () => FragmentMeta[];
  isOutboxEnabled: () => boolean;
};

type AdapterKey = DatabaseAdapter<unknown>;

const registryByAdapter = new WeakMap<AdapterKey, AdapterRegistry>();
const outboxStateByAdapter = new WeakMap<AdapterKey, OutboxState>();

const toAdapterKey = <TUOWConfig>(adapter: DatabaseAdapter<TUOWConfig>): AdapterKey =>
  adapter as AdapterKey;

const isDryRun = (): boolean => process.env["FRAGNO_INIT_DRY_RUN"] === "true";

const getNamespaceKey = (schema: SchemaInfo): string => schema.namespace ?? schema.name;

const getOperationNamespaceKey = (operation: MutationOperation<AnySchema>): string =>
  operation.namespace ?? operation.schema.name;

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

type OutboxState = {
  config: OutboxConfig;
  enabledSchemaKeys: Set<string>;
  enabledFragments: Set<string>;
};

const createOutboxState = (): OutboxState => {
  const enabledSchemaKeys = new Set<string>();
  const enabledFragments = new Set<string>();
  const config: OutboxConfig = {
    enabled: false,
    shouldInclude: (operation) => enabledSchemaKeys.has(getOperationNamespaceKey(operation)),
  };

  return { config, enabledSchemaKeys, enabledFragments };
};

const getOutboxStateForAdapter = (adapter: AdapterKey): OutboxState => {
  const existing = outboxStateByAdapter.get(adapter);
  if (existing) {
    return existing;
  }

  const state = createOutboxState();
  outboxStateByAdapter.set(adapter, state);
  return state;
};

export const getOutboxConfigForAdapter = <TUOWConfig>(
  adapter: DatabaseAdapter<TUOWConfig>,
): OutboxConfig => {
  const adapterKey = toAdapterKey(adapter);
  return getOutboxStateForAdapter(adapterKey).config;
};

const buildInternalFragment = (
  adapter: DatabaseAdapter<unknown>,
  registry: AdapterRegistry,
): InternalFragmentInstance => {
  const routes = [internalFragmentDescribeRoutes, internalFragmentOutboxRoutes];

  return instantiate(internalFragmentDef)
    .withConfig({ registry })
    .withOptions({ databaseAdapter: adapter, databaseNamespace: null })
    .withRoutes(routes)
    .build();
};

const createRegistry = (adapter: DatabaseAdapter<unknown>): AdapterRegistry => {
  const schemas = new Map<string, SchemaInfo>();
  const fragments = new Map<string, FragmentMeta>();
  const outboxState = getOutboxStateForAdapter(adapter);
  let registry: AdapterRegistry;

  registry = {
    internalFragment: undefined as unknown as InternalFragmentInstance,
    schemas,
    fragments,
    outboxState,
    registerSchema: (schema, fragment, options) => {
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
        if (options?.outboxEnabled) {
          outboxState.enabledSchemaKeys.add(namespaceKey);
          outboxState.enabledFragments.add(fragment.name);
          outboxState.config.enabled = true;
        }
        return;
      }
      schemas.set(namespaceKey, schemaCopy);
      fragments.set(fragment.name, { ...fragment });
      if (options?.outboxEnabled) {
        outboxState.enabledSchemaKeys.add(namespaceKey);
        outboxState.enabledFragments.add(fragment.name);
        outboxState.config.enabled = true;
      }
    },
    listSchemas: () => sortSchemas([...schemas.values()]),
    listFragments: () => sortFragments([...fragments.values()]),
    listOutboxFragments: () =>
      sortFragments(
        [...fragments.values()].filter((fragment) =>
          outboxState.enabledFragments.has(fragment.name),
        ),
      ),
    isOutboxEnabled: () => outboxState.config.enabled,
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
