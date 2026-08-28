import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { z } from "zod";

import {
  backofficeContextScopesEqual,
  type BackofficeContextScope,
} from "@/backoffice-runtime/context";
import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";

import type { BackofficeObjectState } from "./backoffice-fragment-durable-object";

const storedOwnerScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("org"), orgId: z.string().trim().min(1) }),
  z.object({
    kind: z.literal("project"),
    orgId: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
  }),
  z.object({ kind: z.literal("user"), userId: z.string().trim().min(1) }),
]);

type ScopedFragmentDurableObjectOptions<TSource, TRuntime> = {
  name: string;
  state: BackofficeObjectState;
  ownerScope: BackofficeContextScope | null;
  host: FragmentDurableObjectHost<TSource, TRuntime>;
  createSource: (scope: BackofficeRoutableScope) => TSource;
};

export type ScopedFragmentDurableObjectRuntime<TRuntime> = {
  /**
   * Initializes from the named object identity or restores a legacy persisted owner scope.
   *
   * Call this inside the DO constructor's `state.blockConcurrencyWhile(...)` callback so requests
   * and alarms cannot observe the object before its durable-hook dispatcher is ready.
   */
  initializeFromOwnerScope(): Promise<void>;
  requireOwnerScope(): BackofficeRoutableScope;
  getRuntime(): Promise<TRuntime>;
  alarm(): Promise<void>;
};

export function createScopedFragmentDurableObjectRuntime<TSource, TRuntime>({
  name,
  state,
  ownerScope: initialOwnerScope,
  host,
  createSource,
}: ScopedFragmentDurableObjectOptions<
  TSource,
  TRuntime
>): ScopedFragmentDurableObjectRuntime<TRuntime> {
  const ownerScopeKey = `${name.toLowerCase()}-owner-scope`;
  let ownerScope = initialOwnerScope ? storedOwnerScopeSchema.parse(initialOwnerScope) : null;
  let runtime: TRuntime | null = null;
  let initialization: Promise<TRuntime> | null = null;

  const initializeForOwnerScope = async (
    scope: BackofficeRoutableScope,
    persistScope: boolean,
  ): Promise<TRuntime> => {
    if (runtime) {
      return runtime;
    }

    initialization ??= (async () => {
      if (persistScope) {
        await state.storage.put(ownerScopeKey, scope);
      }
      const initialized = await host.initialize(createSource(scope));
      runtime = initialized;
      return initialized;
    })();

    return await initialization;
  };

  const requireOwnerScope = (): BackofficeRoutableScope => {
    if (!ownerScope) {
      throw new Error(`${name} object has not been initialized with scope metadata.`);
    }
    return ownerScope;
  };

  return {
    async initializeFromOwnerScope() {
      const storedScopeValue = await state.storage.get(ownerScopeKey);
      const storedScope =
        storedScopeValue === undefined ? null : storedOwnerScopeSchema.parse(storedScopeValue);

      if (ownerScope) {
        if (storedScope && !backofficeContextScopesEqual(ownerScope, storedScope)) {
          throw new Error(`${name} object scope does not match persisted owner scope.`);
        }
        await initializeForOwnerScope(ownerScope, storedScope === null);
        return;
      }
      if (!storedScope) {
        return;
      }

      ownerScope = storedScope;
      await initializeForOwnerScope(ownerScope, false);
    },
    requireOwnerScope,
    async getRuntime() {
      return await initializeForOwnerScope(requireOwnerScope(), true);
    },
    async alarm() {
      if (!runtime) {
        throw new Error(`${name} alarm cannot run without persisted owner scope metadata.`);
      }
      await host.alarm();
    },
  };
}
