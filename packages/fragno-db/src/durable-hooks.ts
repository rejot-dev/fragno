import type { DatabaseAdapter } from "./adapters/adapters";
import type { InternalFragmentInstance } from "./fragments/internal-fragment";
import { getDurableHooksToken } from "./hooks/durable-hooks-fragment";
import { getDurableHooksRuntimeByToken } from "./hooks/durable-hooks-runtime";
import type { DurableHookPropagationContext, HookStatus } from "./hooks/hooks";
import { getInternalFragment } from "./internal/adapter-registry";
import type { AnyFragnoInstantiatedDatabaseFragment } from "./mod";
import type { FragnoId } from "./schema/create";

export type { AnyFragnoInstantiatedDatabaseFragment };

export type DurableHookStatus = HookStatus;
export type {
  DurableHookAttempt,
  DurableHookEnqueueInfo,
  DurableHookPropagationContext,
  DurableHooksInstrumentation,
} from "./hooks/hooks";

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
  propagationContext: DurableHookPropagationContext | null;
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
  const durableHooksToken = getDurableHooksToken(fragment);
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
