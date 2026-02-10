import { instantiate } from "@fragno-dev/core";
import type { DatabaseAdapter } from "../adapters/adapters";
import {
  SchemaRegistryCollisionError,
  internalFragmentDef,
  type InternalFragmentInstance,
} from "../fragments/internal-fragment";
import type { SyncCommandDefinition, SyncCommandTargetRegistration } from "../sync/types";
import {
  createInternalFragmentDescribeRoutes,
  createInternalFragmentOutboxRoutes,
  createInternalFragmentSyncRoutes,
} from "../fragments/internal-fragment.routes";
import { getOutboxStateForAdapter, type OutboxState } from "./outbox-state";

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

export type SyncCommandTarget = {
  fragmentName: string;
  schemaName: string;
  namespace: string | null;
  commands: Map<string, SyncCommandDefinition>;
};

export type AdapterRegistry = {
  internalFragment: InternalFragmentInstance;
  schemas: Map<string, SchemaInfo>;
  fragments: Map<string, FragmentMeta>;
  outboxState: OutboxState;
  syncCommandTargets: Map<string, SyncCommandTarget>;
  registerSchema: (
    schema: SchemaInfo,
    fragment: FragmentMeta,
    options?: { outboxEnabled?: boolean },
  ) => void;
  registerSyncCommands: (registration: SyncCommandTargetRegistration) => void;
  resolveSyncTarget: (fragmentName: string, schemaName: string) => SyncCommandTarget | undefined;
  resolveSyncCommand: (
    fragmentName: string,
    schemaName: string,
    commandName: string,
  ) => { command: SyncCommandDefinition; namespace: string | null } | undefined;
  listSchemas: () => SchemaInfo[];
  listFragments: () => FragmentMeta[];
  listOutboxFragments: () => FragmentMeta[];
  isOutboxEnabled: () => boolean;
};

type AdapterKey = DatabaseAdapter<unknown>;

const registryByAdapter = new WeakMap<AdapterKey, AdapterRegistry>();

const toAdapterKey = <TUOWConfig>(adapter: DatabaseAdapter<TUOWConfig>): AdapterKey =>
  adapter as AdapterKey;

const isDryRun = (): boolean => process.env["FRAGNO_INIT_DRY_RUN"] === "true";

const getNamespaceKey = (schema: SchemaInfo): string => schema.namespace ?? schema.name;
const getSyncTargetKey = (fragmentName: string, schemaName: string): string =>
  `${fragmentName}::${schemaName}`;

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
  const routes = [
    createInternalFragmentDescribeRoutes(),
    createInternalFragmentOutboxRoutes(),
    createInternalFragmentSyncRoutes(),
  ];

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
  const syncCommandTargets = new Map<string, SyncCommandTarget>();
  let registry: AdapterRegistry;

  registry = {
    internalFragment: undefined as unknown as InternalFragmentInstance,
    schemas,
    fragments,
    outboxState,
    syncCommandTargets,
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
    registerSyncCommands: (registration) => {
      const key = getSyncTargetKey(registration.fragmentName, registration.schemaName);
      const existing = syncCommandTargets.get(key);
      if (existing) {
        const commandsMatch =
          existing.commands.size === registration.commands.size &&
          [...existing.commands.entries()].every(
            ([name, command]) => registration.commands.get(name) === command,
          );
        if (
          existing.namespace !== registration.namespace ||
          existing.fragmentName !== registration.fragmentName ||
          existing.schemaName !== registration.schemaName ||
          !commandsMatch
        ) {
          throw new Error(
            `Sync commands for ${registration.fragmentName}/${registration.schemaName} are already registered.`,
          );
        }
        return;
      }
      syncCommandTargets.set(key, {
        fragmentName: registration.fragmentName,
        schemaName: registration.schemaName,
        namespace: registration.namespace,
        commands: new Map(registration.commands),
      });
    },
    resolveSyncTarget: (fragmentName, schemaName) => {
      const key = getSyncTargetKey(fragmentName, schemaName);
      return syncCommandTargets.get(key);
    },
    resolveSyncCommand: (fragmentName, schemaName, commandName) => {
      const target = registry.resolveSyncTarget(fragmentName, schemaName);
      if (!target) {
        return undefined;
      }
      const command = target.commands.get(commandName);
      if (!command) {
        return undefined;
      }
      return { command, namespace: target.namespace };
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
