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
  host: FragmentDurableObjectHost<TSource, TRuntime>;
  createSource: (scope: BackofficeRoutableScope) => TSource;
};

export type ScopedFragmentDurableObjectRuntime<TRuntime> = {
  init(scope: BackofficeContextScope): void;
  /**
   * Restores the owner scope and runtime after a cold start.
   *
   * Call this inside the DO constructor's `state.blockConcurrencyWhile(...)` callback so requests
   * and alarms cannot observe the object before its durable-hook dispatcher is ready.
   */
  initializeFromStoredOwnerScope(): Promise<void>;
  requireOwnerScope(): BackofficeRoutableScope;
  getRuntime(): Promise<TRuntime>;
  alarm(): Promise<void>;
};

export function createScopedFragmentDurableObjectRuntime<TSource, TRuntime>({
  name,
  state,
  host,
  createSource,
}: ScopedFragmentDurableObjectOptions<
  TSource,
  TRuntime
>): ScopedFragmentDurableObjectRuntime<TRuntime> {
  const ownerScopeKey = `${name.toLowerCase()}-owner-scope`;
  let ownerScope: BackofficeRoutableScope | null = null;
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
    init(scope) {
      const parsedScope = storedOwnerScopeSchema.parse(scope);
      if (ownerScope && !backofficeContextScopesEqual(ownerScope, parsedScope)) {
        throw new Error(`${name} object scope does not match object address scope.`);
      }
      ownerScope = parsedScope;
    },
    async initializeFromStoredOwnerScope() {
      const storedScope = await state.storage.get(ownerScopeKey);
      if (storedScope === undefined) {
        return;
      }

      ownerScope = storedOwnerScopeSchema.parse(storedScope);
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
