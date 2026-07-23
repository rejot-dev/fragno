import type { DatabaseAdapter } from "../adapters/adapters";
import type { OutboxConfig } from "../outbox/outbox";
import type { MutationOperation } from "../query/unit-of-work/unit-of-work";
import type { AnySchema } from "../schema/create";

export type OutboxState = {
  config: OutboxConfig;
  enabledSchemaKeys: Set<string>;
  enabledTablesBySchemaKey: Map<string, Set<string>>;
  enabledFragments: Set<string>;
};

type AdapterKey = DatabaseAdapter<unknown>;

const outboxStateByAdapter = new WeakMap<AdapterKey, OutboxState>();

const getOperationNamespaceKey = (operation: MutationOperation<AnySchema>): string =>
  operation.namespace ?? operation.schema.name;

const createOutboxState = (): OutboxState => {
  const enabledSchemaKeys = new Set<string>();
  const enabledTablesBySchemaKey = new Map<string, Set<string>>();
  const enabledFragments = new Set<string>();
  const config: OutboxConfig = {
    enabled: false,
    shouldInclude: (operation) => {
      const schemaKey = getOperationNamespaceKey(operation);
      if (!enabledSchemaKeys.has(schemaKey)) {
        return false;
      }

      const enabledTables = enabledTablesBySchemaKey.get(schemaKey);
      return enabledTables === undefined || enabledTables.has(operation.table);
    },
  };

  return { config, enabledSchemaKeys, enabledTablesBySchemaKey, enabledFragments };
};

export const enableOutboxForSchema = (
  state: OutboxState,
  schemaKey: string,
  tables: readonly string[] | undefined,
): void => {
  const wasAlreadyEnabled = state.enabledSchemaKeys.has(schemaKey);
  const existingTables = state.enabledTablesBySchemaKey.get(schemaKey);
  state.enabledSchemaKeys.add(schemaKey);
  state.config.enabled = true;

  if (tables === undefined) {
    state.enabledTablesBySchemaKey.delete(schemaKey);
    return;
  }

  if (wasAlreadyEnabled && existingTables === undefined) {
    return;
  }

  const enabledTables = existingTables ?? new Set<string>();
  for (const table of tables) {
    enabledTables.add(table);
  }
  state.enabledTablesBySchemaKey.set(schemaKey, enabledTables);
};

export const getOutboxStateForAdapter = (adapter: AdapterKey): OutboxState => {
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
): OutboxConfig => getOutboxStateForAdapter(adapter as AdapterKey).config;
