import { hasDurableHooksConfigured } from "../../hooks/durable-hooks-fragment";
import { migrate, type AnyFragnoInstantiatedDatabaseFragment } from "../../mod";
import {
  createDurableHooksProcessor,
  type DurableHooksDispatcherDurableObjectHandler,
  type DurableHooksDispatcherDurableObjectState,
} from "./index";

type CreateDispatcherContext<TEnv> = {
  hookFragments: readonly AnyFragnoInstantiatedDatabaseFragment[];
  state: DurableHooksDispatcherDurableObjectState;
  env: TEnv;
  onProcessError?: (error: unknown) => void;
};

type CommonHostOptions<TEnv, TSource, TRuntime> = {
  /** Human-readable runtime name used in diagnostics. */
  name?: string;
  /** Durable Object state subset used for hook alarms and passed to `createRuntime()`. */
  state: DurableHooksDispatcherDurableObjectState;
  /** Worker environment bindings passed to `createRuntime()` and hook dispatcher factories. */
  env: TEnv;
  /**
   * Builds the runtime for a source.
   *
   * Callers should invoke `initialize()` from their Durable Object's `blockConcurrencyWhile()`
   * callback and store the returned runtime on the Durable Object instance.
   */
  createRuntime: (
    source: TSource,
    context: FragmentDurableObjectHostContext<TEnv>,
  ) => TRuntime | Promise<TRuntime>;
  /**
   * Selects fragments that should participate in durable hook processing.
   *
   * Defaults to all migration fragments with durable hooks configured. Return an empty array
   * to disable hook dispatcher creation for a runtime that still needs migration.
   */
  getHookFragments?: (
    runtime: TRuntime,
    migrationFragments: readonly AnyFragnoInstantiatedDatabaseFragment[],
  ) => readonly AnyFragnoInstantiatedDatabaseFragment[];
  /** Allows multi-fragment runtimes to replace raw fragments with hosted fragments. */
  hostRuntime?: (runtime: TRuntime, context: FragmentDurableObjectRuntimeHostContext) => TRuntime;
  /** Optional request mounts used by `host.fetch(...)`. */
  mounts?: readonly FragmentDurableObjectMount<TRuntime>[];
  /** Called when runtime creation or migration fails. The original error is re-thrown. */
  onMigrationError?: (error: unknown) => void;
  /**
   * Called when durable hook dispatcher creation fails.
   *
   * Dispatcher creation failures do not fail `initialize()`; the runtime remains usable without
   * alarm-backed hook processing.
   */
  onDispatcherError?: (error: unknown) => void;
  /** Called by the durable hook dispatcher when processing or alarm scheduling fails. */
  onProcessError?: (error: unknown) => void;
  /** @internal Override low-level operations in tests or advanced integrations. */
  operations?: FragmentDurableObjectHostOperations<TEnv>;
};

type SingleFragmentHostOptions<
  TEnv,
  TSource,
  TFragment extends AnyFragnoInstantiatedDatabaseFragment,
> = CommonHostOptions<TEnv, TSource, TFragment> & {
  /**
   * Selects the database fragments that must be migrated before the runtime is returned.
   *
   * Single-fragment runtimes default to `[runtime]`. Multi-fragment runtimes must provide this.
   */
  getMigrationFragments?: (runtime: TFragment) => readonly AnyFragnoInstantiatedDatabaseFragment[];
};

type MultiFragmentHostOptions<TEnv, TSource, TRuntime> = CommonHostOptions<
  TEnv,
  TSource,
  TRuntime
> & {
  /** Selects the database fragments that must be migrated before the runtime is returned. */
  getMigrationFragments: (runtime: TRuntime) => readonly AnyFragnoInstantiatedDatabaseFragment[];
};

const methodsThatNotifyHooks = new Set<PropertyKey>([
  "callRoute",
  "callRouteRaw",
  "callServices",
  "handler",
]);

const isFetchTarget = (value: unknown): value is FragmentDurableObjectFetchTarget => {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "handler") === "function"
  );
};

const createHostedFragment = <TFragment extends AnyFragnoInstantiatedDatabaseFragment>(
  fragment: TFragment,
  dispatcher: DurableHooksDispatcherDurableObjectHandler | null,
): TFragment => {
  const methodCache = new Map<PropertyKey, unknown>();

  const notifyHooks = async () => {
    await dispatcher?.notify?.({ source: "request" });
  };

  return new Proxy(fragment, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }

      if (methodCache.has(property)) {
        return methodCache.get(property);
      }

      const boundMethod = value.bind(target) as (...args: unknown[]) => unknown;
      if (!methodsThatNotifyHooks.has(property)) {
        methodCache.set(property, boundMethod);
        return boundMethod;
      }

      const methodWithHookNotification = async (...args: unknown[]) => {
        try {
          return await boundMethod(...args);
        } finally {
          await notifyHooks();
        }
      };

      methodCache.set(property, methodWithHookNotification);
      return methodWithHookNotification;
    },
  });
};

/** Context passed to runtime factories managed by a fragment Durable Object host. */
export type FragmentDurableObjectHostContext<TEnv> = {
  /** Durable Object state subset required by migrations and durable hook alarm scheduling. */
  state: DurableHooksDispatcherDurableObjectState;
  /** Worker environment bindings for the Durable Object instance. */
  env: TEnv;
};

export type FragmentDurableObjectRuntimeHostContext = {
  /** Wraps a fragment so direct `callRoute`/`callServices` calls notify durable hooks. */
  hostFragment: <TFragment extends AnyFragnoInstantiatedDatabaseFragment>(
    fragment: TFragment,
  ) => TFragment;
};

export type FragmentDurableObjectFetchContext = {
  waitUntil?: (promise: Promise<unknown>) => void;
};

export type FragmentDurableObjectFetchTarget = {
  handler: (
    request: Request,
    context?: FragmentDurableObjectFetchContext,
  ) => Response | Promise<Response>;
};

export type FragmentDurableObjectMountMatchInput = {
  request: Request;
  url: URL;
  pathname: string;
};

export type FragmentDurableObjectMount<TRuntime> = {
  id: string;
  /** If omitted, the mount acts as a fallback. */
  match?: (input: FragmentDurableObjectMountMatchInput) => boolean;
  target: (runtime: TRuntime) => FragmentDurableObjectFetchTarget | null | undefined;
};

export type ResolvedFragmentDurableObjectMount = {
  id: string;
  handle: (context?: FragmentDurableObjectFetchContext) => Promise<Response>;
};

/** Low-level operations used by the fragment Durable Object host. */
export type FragmentDurableObjectHostOperations<TEnv> = {
  /** Migrates one database fragment before the hosted runtime is returned. Defaults to `migrate`. */
  migrateFragment?: (fragment: AnyFragnoInstantiatedDatabaseFragment) => Promise<void>;
  /**
   * Creates the dispatcher used for durable hook alarms and post-call hook notifications.
   *
   * Defaults to `createDurableHooksProcessor(hookFragments)(state, env)`.
   */
  createDispatcher?: (
    context: CreateDispatcherContext<TEnv>,
  ) => DurableHooksDispatcherDurableObjectHandler | null;
};

/** Options for creating a reusable Fragno runtime host inside a Cloudflare Durable Object. */
export type FragmentDurableObjectHostOptions<TEnv, TSource, TRuntime> =
  TRuntime extends AnyFragnoInstantiatedDatabaseFragment
    ? SingleFragmentHostOptions<TEnv, TSource, TRuntime>
    : MultiFragmentHostOptions<TEnv, TSource, TRuntime>;

/** Runtime lifecycle facade used by a Cloudflare Durable Object class. */
export type FragmentDurableObjectHost<TSource, TRuntime> = {
  /**
   * Creates, migrates, and returns a hosted runtime for `source`.
   *
   * Call this from the Durable Object's `blockConcurrencyWhile()` callback before storing
   * the runtime on the Durable Object instance.
   */
  initialize: (source: TSource) => Promise<TRuntime>;
  /** Resolves the mount that would handle a request for a hosted runtime. */
  resolveMount: (runtime: TRuntime, request: Request) => ResolvedFragmentDurableObjectMount | null;
  /** Dispatches a request to the matching mounted fragment, or the runtime itself. */
  fetch: (
    runtime: TRuntime,
    request: Request,
    context?: FragmentDurableObjectFetchContext,
  ) => Promise<Response>;
  /** Runs the durable-hook alarm handler for the current dispatcher, if hooks are enabled. */
  alarm: () => Promise<void>;
};

/**
 * Creates a generic lifecycle host for Fragno fragments running inside a Durable Object.
 *
 * The host owns migration, durable hook dispatcher creation, alarm forwarding, and automatic hook
 * notifications for direct fragment calls. It does not cache runtimes; the Durable Object owns the
 * runtime field and the `blockConcurrencyWhile()` boundary around initialization.
 */
export function createFragmentDurableObjectHost<
  TEnv,
  TSource,
  TFragment extends AnyFragnoInstantiatedDatabaseFragment,
>(
  options: SingleFragmentHostOptions<TEnv, TSource, TFragment>,
): FragmentDurableObjectHost<TSource, TFragment>;
export function createFragmentDurableObjectHost<TEnv, TSource, TRuntime>(
  options: MultiFragmentHostOptions<TEnv, TSource, TRuntime>,
): FragmentDurableObjectHost<TSource, TRuntime>;
export function createFragmentDurableObjectHost<TEnv, TSource, TRuntime>(
  options:
    | SingleFragmentHostOptions<TEnv, TSource, AnyFragnoInstantiatedDatabaseFragment>
    | MultiFragmentHostOptions<TEnv, TSource, TRuntime>,
): FragmentDurableObjectHost<TSource, TRuntime> {
  let dispatcher: DurableHooksDispatcherDurableObjectHandler | null = null;

  const getMigrationFragments = options.getMigrationFragments as
    | ((runtime: TRuntime) => readonly AnyFragnoInstantiatedDatabaseFragment[])
    | undefined;
  const getHookFragments = options.getHookFragments as
    | ((
        runtime: TRuntime,
        migrationFragments: readonly AnyFragnoInstantiatedDatabaseFragment[],
      ) => readonly AnyFragnoInstantiatedDatabaseFragment[])
    | undefined;
  const hostRuntime = options.hostRuntime as
    | ((runtime: TRuntime, context: FragmentDurableObjectRuntimeHostContext) => TRuntime)
    | undefined;
  const mounts = options.mounts as readonly FragmentDurableObjectMount<TRuntime>[] | undefined;
  const usesSingleFragmentDefault = !getMigrationFragments;

  const resolveMigrationFragments = (runtime: TRuntime) => {
    if (getMigrationFragments) {
      return getMigrationFragments(runtime);
    }

    return [runtime as AnyFragnoInstantiatedDatabaseFragment];
  };

  const resolveHookFragments = (
    runtime: TRuntime,
    migrationFragments: readonly AnyFragnoInstantiatedDatabaseFragment[],
  ) => {
    return (
      getHookFragments?.(runtime, migrationFragments) ??
      migrationFragments.filter(hasDurableHooksConfigured)
    );
  };

  const createDispatcher = (hookFragments: readonly AnyFragnoInstantiatedDatabaseFragment[]) => {
    if (hookFragments.length === 0) {
      return null;
    }

    try {
      if (options.operations?.createDispatcher) {
        return options.operations.createDispatcher({
          hookFragments,
          state: options.state,
          env: options.env,
          onProcessError: options.onProcessError,
        });
      }

      const createProcessor = createDurableHooksProcessor<TEnv>(hookFragments, {
        onProcessError: options.onProcessError,
      });
      return createProcessor(options.state, options.env);
    } catch (error) {
      options.onDispatcherError?.(error);
      return null;
    }
  };

  const createHostedRuntime = (
    runtime: TRuntime,
    runtimeDispatcher: DurableHooksDispatcherDurableObjectHandler | null,
  ): TRuntime => {
    const hostFragment = <TFragment extends AnyFragnoInstantiatedDatabaseFragment>(
      fragment: TFragment,
    ): TFragment => createHostedFragment(fragment, runtimeDispatcher);

    if (hostRuntime) {
      return hostRuntime(runtime, { hostFragment });
    }

    if (!usesSingleFragmentDefault) {
      return runtime;
    }

    return hostFragment(runtime as AnyFragnoInstantiatedDatabaseFragment) as TRuntime;
  };

  const migrateFragments = async (fragments: readonly AnyFragnoInstantiatedDatabaseFragment[]) => {
    const migrateFragment = options.operations?.migrateFragment ?? migrate;
    for (const fragment of fragments) {
      await migrateFragment(fragment);
    }
  };

  const initialize = async (source: TSource): Promise<TRuntime> => {
    try {
      const runtime = (await options.createRuntime(source, {
        state: options.state,
        env: options.env,
      })) as TRuntime;
      const migrationFragments = resolveMigrationFragments(runtime);

      await migrateFragments(migrationFragments);

      const hookFragments = resolveHookFragments(runtime, migrationFragments);
      const nextDispatcher = createDispatcher(hookFragments);
      const hostedRuntime = createHostedRuntime(runtime, nextDispatcher);

      dispatcher = nextDispatcher;

      return hostedRuntime;
    } catch (error) {
      options.onMigrationError?.(error);
      throw error;
    }
  };

  const resolveMount = (
    runtime: TRuntime,
    request: Request,
  ): ResolvedFragmentDurableObjectMount | null => {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const mountInput = { request, url, pathname };

    if (mounts) {
      for (const mount of mounts) {
        if (mount.match && !mount.match(mountInput)) {
          continue;
        }

        const mountTarget = mount.target(runtime);
        if (!mountTarget) {
          continue;
        }

        return {
          id: mount.id,
          handle: async (context) => await mountTarget.handler(request, context),
        };
      }
    }

    const target = runtime as unknown;
    if (!isFetchTarget(target)) {
      return null;
    }

    return {
      id: "default",
      handle: async (context) => await target.handler(request, context),
    };
  };

  return {
    initialize,
    resolveMount,
    fetch: async (runtime, request, context) => {
      const mount = resolveMount(runtime, request);
      if (!mount) {
        return new Response("No fragment Durable Object mount matched request.", {
          status: 404,
        });
      }

      return await mount.handle(context);
    },
    alarm: async () => {
      await dispatcher?.alarm?.();
    },
  };
}
