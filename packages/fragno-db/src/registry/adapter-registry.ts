import type { DatabaseAdapter } from "../adapters/adapters";

export type AdapterSchemaInfo = {
  name: string;
  namespace: string | null;
  version: number;
  tables: string[];
};

export type AdapterFragmentInfo = {
  name: string;
  mountRoute: string;
};

export interface AdapterRegistry {
  registerSchema: (schema: AdapterSchemaInfo) => void;
  registerFragment: (fragment: AdapterFragmentInfo) => void;
  listSchemas: () => AdapterSchemaInfo[];
  listFragments: () => AdapterFragmentInfo[];
}

type AdapterRegistryState = {
  schemas: Map<string, AdapterSchemaInfo>;
  fragments: Map<string, AdapterFragmentInfo>;
};

const registryByAdapter = new WeakMap<DatabaseAdapter, AdapterRegistryState>();

const createRegistryState = (): AdapterRegistryState => ({
  schemas: new Map<string, AdapterSchemaInfo>(),
  fragments: new Map<string, AdapterFragmentInfo>(),
});

const schemaKey = (schema: AdapterSchemaInfo): string => {
  const namespaceKey = schema.namespace ?? "";
  return `${namespaceKey}:${schema.name}`;
};

const sortSchemas = (schemas: AdapterSchemaInfo[]): AdapterSchemaInfo[] =>
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

const sortFragments = (fragments: AdapterFragmentInfo[]): AdapterFragmentInfo[] =>
  fragments.sort((a, b) => a.name.localeCompare(b.name));

export const getAdapterRegistry = (adapter: DatabaseAdapter): AdapterRegistry => {
  let state = registryByAdapter.get(adapter);
  if (!state) {
    state = createRegistryState();
    registryByAdapter.set(adapter, state);
  }

  return {
    registerSchema: (schema) => {
      state.schemas.set(schemaKey(schema), { ...schema, tables: [...schema.tables] });
    },
    registerFragment: (fragment) => {
      state.fragments.set(fragment.name, { ...fragment });
    },
    listSchemas: () => sortSchemas([...state.schemas.values()]),
    listFragments: () => sortFragments([...state.fragments.values()]),
  };
};

type SettingsService = {
  get: (namespace: string, key: string) => unknown;
  set: (namespace: string, key: string, value: string) => unknown;
};

type HandlerTx = () => {
  withServiceCalls: (callback: () => readonly (unknown | undefined)[]) => {
    transform: (fn: (result: { serviceResult: readonly (unknown | undefined)[] }) => unknown) => {
      execute: () => Promise<unknown>;
    };
    execute: () => Promise<unknown>;
  };
};

export const resolveAdapterIdentity = async (config: {
  handlerTx: unknown;
  settingsService: SettingsService;
  randomUuid: () => string;
  settingsNamespace: string;
  identityKey: string;
}): Promise<string | undefined> => {
  const handlerTx = config.handlerTx as HandlerTx;
  const readIdentity = async (): Promise<string | undefined> =>
    handlerTx()
      .withServiceCalls(
        () => [config.settingsService.get(config.settingsNamespace, config.identityKey)] as const,
      )
      .transform(({ serviceResult: [result] }) => (result as { value?: string } | undefined)?.value)
      .execute() as Promise<string | undefined>;

  let identity = await readIdentity();
  if (!identity) {
    const generated = config.randomUuid();
    try {
      await handlerTx()
        .withServiceCalls(
          () =>
            [
              config.settingsService.set(config.settingsNamespace, config.identityKey, generated),
            ] as const,
        )
        .execute();
    } catch {
      // Ignore write errors and fall through to re-read.
    }
    identity = await readIdentity();
  }

  return identity;
};
