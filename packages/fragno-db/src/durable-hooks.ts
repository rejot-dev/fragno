import type { DatabaseAdapter } from "./adapters/adapters";
import type { InternalFragmentInstance } from "./fragments/internal-fragment";
import type { HookStatus } from "./hooks/hooks";
import { getDurableHooksRuntimeByToken } from "./hooks/durable-hooks-runtime";
import { getInternalFragment } from "./internal/adapter-registry";
import type { FragnoId } from "./schema/create";
import type { AnyFragnoInstantiatedDatabaseFragment } from "./mod";

export type { AnyFragnoInstantiatedDatabaseFragment };

export type DurableHookStatus = HookStatus;

export type DurableHookRecord = {
  id: FragnoId;
  namespace: string;
  hookName: string;
  payload: unknown;
  status: DurableHookStatus;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: Date | null;
  nextRetryAt: Date | null;
  createdAt: Date;
  error: string | null;
  nonce: string;
};

export type DurableHooksService = InternalFragmentInstance["services"]["hookService"];

export type DurableHooksAccessor = {
  namespace: string;
  hooksEnabled: boolean;
  hookService: DurableHooksService;
};

export function getDurableHooksService(
  fragment: AnyFragnoInstantiatedDatabaseFragment,
): DurableHooksAccessor {
  const internal = fragment.$internal as { durableHooksToken?: object } | undefined;
  const durableHooksToken = internal?.durableHooksToken;
  const runtime = durableHooksToken ? getDurableHooksRuntimeByToken(durableHooksToken) : undefined;
  const deps = fragment.$internal?.deps as
    | {
        databaseAdapter?: DatabaseAdapter<unknown>;
        namespace?: string | null;
        schema?: { name?: string };
      }
    | undefined;

  if (!deps?.databaseAdapter) {
    throw new Error("Database adapter is missing for durable hooks.");
  }

  const namespace = runtime?.config.namespace ?? deps.namespace ?? deps.schema?.name ?? "";
  if (!namespace) {
    throw new Error("Durable hooks namespace is missing.");
  }

  const hookAdapter = deps.databaseAdapter.getHookProcessingAdapter?.() ?? deps.databaseAdapter;
  const internalFragment = runtime?.config.internalFragment ?? getInternalFragment(hookAdapter);

  return {
    namespace,
    hooksEnabled: Boolean(durableHooksToken),
    hookService: internalFragment.services.hookService,
  };
}
