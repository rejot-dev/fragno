import type { DatabaseAdapter } from "../adapters/adapters";
import type { MutationOperation } from "../query/unit-of-work/unit-of-work";
import type { AnySchema } from "../schema/create";
import type { OutboxConfig } from "../outbox/outbox";

export type OutboxState = {
  config: OutboxConfig;
  enabledSchemaKeys: Set<string>;
  enabledFragments: Set<string>;
};

type AdapterKey = DatabaseAdapter<unknown>;

const outboxStateByAdapter = new WeakMap<AdapterKey, OutboxState>();

const getOperationNamespaceKey = (operation: MutationOperation<AnySchema>): string =>
  operation.namespace ?? operation.schema.name;

const createOutboxState = (): OutboxState => {
  const enabledSchemaKeys = new Set<string>();
  const enabledFragments = new Set<string>();
  const config: OutboxConfig = {
    enabled: false,
    shouldInclude: (operation) => enabledSchemaKeys.has(getOperationNamespaceKey(operation)),
  };

  return { config, enabledSchemaKeys, enabledFragments };
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
