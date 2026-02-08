import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import type { DatabaseAdapter } from "../adapters/adapters";
import {
  ADAPTER_IDENTITY_KEY,
  SETTINGS_NAMESPACE,
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
  identity: string;
  internalFragment: InternalFragmentInstance;
  schemas: Map<string, SchemaInfo>;
  fragments: Map<string, FragmentMeta>;
  registerSchema: (schema: SchemaInfo, fragment: FragmentMeta) => void;
  listSchemas: () => SchemaInfo[];
  listFragments: () => FragmentMeta[];
};

type AdapterKey = DatabaseAdapter<unknown>;

const registryByIdentity = new Map<string, AdapterRegistry>();
const registryByAdapter = new WeakMap<AdapterKey, AdapterRegistry>();
const identityByAdapter = new WeakMap<AdapterKey, string>();

const toAdapterKey = <TUOWConfig>(adapter: DatabaseAdapter<TUOWConfig>): AdapterKey =>
  adapter as AdapterKey;

const isDryRun = (): boolean => process.env["FRAGNO_INIT_DRY_RUN"] === "true";

const schemaKey = (schema: SchemaInfo): string => {
  const namespaceKey = schema.namespace ?? "";
  return `${namespaceKey}:${schema.name}`;
};

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

const readIdentity = async (fragment: InternalFragmentInstance): Promise<string | undefined> =>
  fragment.inContext(async function () {
    return await this.handlerTx()
      .withServiceCalls(
        () =>
          [
            fragment.services.settingsService.get(SETTINGS_NAMESPACE, ADAPTER_IDENTITY_KEY),
          ] as const,
      )
      .transform(({ serviceResult: [result] }) => (result as { value?: string } | undefined)?.value)
      .execute();
  });

const writeIdentity = async (
  fragment: InternalFragmentInstance,
  identity: string,
): Promise<void> => {
  await fragment.inContext(async function () {
    await this.handlerTx()
      .withServiceCalls(
        () =>
          [
            fragment.services.settingsService.set(
              SETTINGS_NAMESPACE,
              ADAPTER_IDENTITY_KEY,
              identity,
            ),
          ] as const,
      )
      .execute();
  });
};

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

const createRegistry = (adapter: DatabaseAdapter<unknown>, identity: string): AdapterRegistry => {
  const schemas = new Map<string, SchemaInfo>();
  const fragments = new Map<string, FragmentMeta>();

  const registry: AdapterRegistry = {
    identity,
    internalFragment: undefined as unknown as InternalFragmentInstance,
    schemas,
    fragments,
    registerSchema: (schema, fragment) => {
      schemas.set(schemaKey(schema), { ...schema, tables: [...schema.tables] });
      fragments.set(fragment.name, { ...fragment });
    },
    listSchemas: () => sortSchemas([...schemas.values()]),
    listFragments: () => sortFragments([...fragments.values()]),
  };

  registry.internalFragment = buildInternalFragment(adapter, registry);
  return registry;
};

export const getRegistryForIdentity = (identity: string): AdapterRegistry => {
  const registry = registryByIdentity.get(identity);
  if (!registry) {
    throw new Error(`Adapter registry not found for identity "${identity}".`);
  }
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

  const registry = createRegistry(adapterKey, "");
  registryByAdapter.set(adapterKey, registry);
  return registry;
};

export const resolveAdapterIdentity = async <TUOWConfig>(
  adapter: DatabaseAdapter<TUOWConfig>,
): Promise<string> => {
  const adapterKey = toAdapterKey(adapter);
  const cachedIdentity = identityByAdapter.get(adapterKey);
  if (cachedIdentity) {
    return cachedIdentity;
  }

  const registry = registryByAdapter.get(adapterKey);
  const fragment =
    registry?.internalFragment ??
    instantiate(internalFragmentDef)
      .withOptions({ databaseAdapter: adapterKey, databaseNamespace: null })
      .build();

  let identity = await readIdentity(fragment);
  if (!identity) {
    const generated = defaultFragnoRuntime.random.uuid();
    await writeIdentity(fragment, generated);
    identity = await readIdentity(fragment);
  }

  if (!identity) {
    throw new Error("Failed to persist adapter identity.");
  }

  identityByAdapter.set(adapterKey, identity);
  return identity;
};

export const getRegistryForAdapter = async <TUOWConfig>(
  adapter: DatabaseAdapter<TUOWConfig>,
): Promise<AdapterRegistry> => {
  const adapterKey = toAdapterKey(adapter);
  const existing = registryByAdapter.get(adapterKey);
  if (existing && existing.identity) {
    return existing;
  }

  const identity = await resolveAdapterIdentity(adapter);
  const identityRegistry = registryByIdentity.get(identity);
  if (identityRegistry) {
    registryByAdapter.set(adapterKey, identityRegistry);
    identityByAdapter.set(adapterKey, identity);
    return identityRegistry;
  }

  if (existing) {
    existing.identity = identity;
    registryByIdentity.set(identity, existing);
    identityByAdapter.set(adapterKey, identity);
    return existing;
  }

  if (isDryRun()) {
    throw new Error("Adapter registry is unavailable during dry-run initialization.");
  }

  const registry = createRegistry(adapterKey, identity);
  registryByAdapter.set(adapterKey, registry);
  registryByIdentity.set(identity, registry);
  return registry;
};
