import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectFetchContext,
  type FragmentDurableObjectHost,
  type FragmentDurableObjectHostContext,
  type FragmentDurableObjectMount,
  type FragmentDurableObjectRuntimeHostContext,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import type { AnyFragnoInstantiatedDatabaseFragment } from "@fragno-dev/db/durable-hooks";

import {
  createDurableHookRepository,
  createDurableHookRepositoryRpcTarget,
  createEmptyDurableHookRepository,
  type DurableHookQueueOptions,
  type DurableHookRepository,
} from "@/fragno/durable-hooks";

/**
 * Current in-memory state for a config-backed Fragment Durable Object.
 *
 * Terms used by this helper:
 * - `stored`: the full admin/config record persisted in Durable Object storage.
 *   This can include UI-only or setup-only fields such as `createdAt`, `updatedAt`,
 *   webhook base URLs, masked-secret metadata, etc.
 * - `source`: the subset/shape of `stored` that is actually used to create the Fragno
 *   runtime. Changes to `stored` that do not change `source` should not force a
 *   fragment rebuild or migration.
 * - `runtime`: the migrated hosted fragment or multi-fragment runtime returned by
 *   `createRuntime(source, ...)`.
 */
export type BackofficeFragmentRuntimeState<TStored, TSource, TRuntime> =
  | {
      /** The Durable Object has no usable fragment runtime. `stored` may still contain partial config. */
      configured: false;
      /** Last loaded persisted config, or `null` when no config is stored. */
      stored: TStored | null;
    }
  | {
      /** The Durable Object has a migrated runtime ready for RPC/fetch/alarm handling. */
      configured: true;
      /** Full persisted config record. */
      stored: TStored;
      /** Runtime input derived from `stored`; see `toSource` on the options type. */
      source: TSource;
      /** Hosted runtime returned by the core fragment Durable Object host. */
      runtime: TRuntime;
      /** Stable identifier for the current `source`, used to skip redundant rebuilds. */
      fingerprint: string;
    };

type ConfiguredRuntimeState<TStored, TSource, TRuntime> = Extract<
  BackofficeFragmentRuntimeState<TStored, TSource, TRuntime>,
  { configured: true }
>;

/**
 * Backoffice-specific layer on top of the generic Fragno Cloudflare DO host.
 *
 * This helper assumes a common pattern used by backoffice fragment DOs:
 *
 * 1. Load an admin/config record from Durable Object storage.
 * 2. Decide whether that record is complete enough to run the fragment.
 * 3. Derive the runtime input (`source`) from the stored record.
 * 4. Create/migrate a Fragno runtime with the generic `createFragmentDurableObjectHost`.
 * 5. Reuse the runtime while the derived `source` fingerprint is unchanged.
 *
 * Organisation binding is always enabled. Configured stored records must expose a string `orgId`,
 * admin updates can use `assertSameOrg(...)`, and `fetch(...)` rejects `?orgId=` mismatches with a
 * standard 409 `ORG_ID_MISMATCH` response.
 */
export type BackofficeDurableHookDependencies = {
  createRepository: typeof createDurableHookRepository;
  createRpcTarget: <TOptions extends DurableHookQueueOptions = DurableHookQueueOptions>(
    repository: DurableHookRepository<TOptions>,
  ) => DurableHookRepository<TOptions>;
  createEmptyRepository: typeof createEmptyDurableHookRepository;
};

const defaultDurableHookDependencies: BackofficeDurableHookDependencies = {
  createRepository: createDurableHookRepository,
  createRpcTarget: createDurableHookRepositoryRpcTarget,
  createEmptyRepository: createEmptyDurableHookRepository,
};

export type BackofficeOutboxItem = {
  id: string;
  type: string;
  createdAt: string;
  dispatchedAt?: string;
  attempts?: number;
  lastError?: string;
};

export type BackofficeFragmentDurableObjectOptions<
  TStored,
  TSource,
  TRuntime,
  TOutbox extends BackofficeOutboxItem = BackofficeOutboxItem,
> = {
  /** Human-readable fragment/DO name used in logs, errors, and default messages. */
  name: string;
  /** The Durable Object state from the class constructor. */
  state: DurableObjectState;
  /** The Worker environment from the class constructor. */
  env: CloudflareEnv;
  /** Storage key for the persisted config. Defaults to `${name.toLowerCase()}-config`. */
  configKey?: string;
  /** Storage key for the persisted outbox. Defaults to `${name.toLowerCase()}-outbox`. */
  outboxKey?: string;
  /** Parse/validate raw storage data. Defaults to a plain cast from unknown to `TStored`. */
  parseStored?: (raw: unknown) => TStored;
  /**
   * Returns whether the stored config can produce a runtime.
   *
   * Defaults to `stored !== null`. Override for fragments that allow partial/incomplete stored
   * config, like Pi requiring both an API key and at least one harness.
   */
  isConfigured?: (stored: TStored | null) => stored is TStored;
  /**
   * Derives the runtime input from the full stored config.
   *
   * `source` is intentionally narrower than `stored`: it should contain only values that affect
   * fragment runtime construction/migration. Example: Telegram stores `webhookBaseUrl`, `createdAt`,
   * and `updatedAt`, but only `botToken`, `webhookSecretToken`, `botUsername`, and `apiBaseUrl` are
   * needed to create the Telegram fragment. Keeping those storage-only fields out of `source` avoids
   * unnecessary rebuilds/migrations when they change.
   *
   * Defaults to identity, so `TSource` can be omitted when the whole stored config is the runtime
   * input.
   */
  toSource?: (stored: TStored) => TSource;
  /**
   * Stable fingerprint for the derived runtime input.
   *
   * If the fingerprint is unchanged, `initializeFromStored` updates `stored` but reuses the current
   * migrated runtime. Defaults to `JSON.stringify(source)`.
   */
  fingerprint?: (source: TSource, stored: TStored) => string;
  /** Builds the raw fragment or multi-fragment runtime from the derived `source`. */
  createRuntime: (
    source: TSource,
    context: FragmentDurableObjectHostContext<CloudflareEnv>,
  ) => TRuntime | Promise<TRuntime>;
  /** Single-fragment runtimes can omit this; multi-fragment runtimes should provide it. */
  getMigrationFragments?: (runtime: TRuntime) => readonly AnyFragnoInstantiatedDatabaseFragment[];
  /** Override durable-hook repository construction. Intended for tests that need lightweight repositories. */
  durableHooks?: BackofficeDurableHookDependencies;
  /** Override which migrated fragments participate in durable-hook alarm processing. */
  getHookFragments?: (
    runtime: TRuntime,
    migrationFragments: readonly AnyFragnoInstantiatedDatabaseFragment[],
  ) => readonly AnyFragnoInstantiatedDatabaseFragment[];
  /** Wrap fragments inside a multi-fragment runtime so direct `callRoute`/`callServices` notify hooks. */
  hostRuntime?: (runtime: TRuntime, context: FragmentDurableObjectRuntimeHostContext) => TRuntime;
  /** Override how the persisted config's organisation id is read. Defaults to top-level `stored.orgId`. */
  getStoredOrgId?: (stored: TStored) => string | null;
  /** Request routing table for multi-fragment runtimes. Omit for a single fragment with `handler`. */
  mounts?: readonly FragmentDurableObjectMount<TRuntime>[];
  /** Minimal persisted outbox support. Items are stored separately from config. */
  outbox?: {
    dispatch: (item: TOutbox, context: { env: CloudflareEnv; stored: TStored }) => Promise<void>;
    retryDelayMs?: number;
  };
};

/** Runtime controller returned to an individual backoffice Durable Object class. */
export type BackofficeFragmentDurableObject<
  TStored,
  TSource,
  TRuntime,
  TOutbox extends BackofficeOutboxItem = BackofficeOutboxItem,
> = {
  /** Load and parse the stored config from DO storage. Does not initialize the runtime. */
  loadStored: () => Promise<TStored | null>;
  /**
   * Initialize or refresh the hosted runtime from a stored config record.
   *
   * Call this inside the DO constructor's `state.blockConcurrencyWhile(...)` callback and after
   * admin config updates. The helper skips rebuild/migration when the derived source fingerprint is
   * unchanged.
   */
  initializeFromStored: (
    stored: TStored | null,
  ) => Promise<BackofficeFragmentRuntimeState<TStored, TSource, TRuntime>>;
  /** Persist a new config record, then initialize/refresh the runtime from it. */
  storeAndInitialize: (
    stored: TStored,
  ) => Promise<BackofficeFragmentRuntimeState<TStored, TSource, TRuntime>>;
  /** Delete the persisted config and mark the runtime unconfigured. */
  clearConfig: () => Promise<BackofficeFragmentRuntimeState<TStored, TSource, TRuntime>>;
  /** Return the current cached runtime state without doing storage I/O. */
  getState: () => BackofficeFragmentRuntimeState<TStored, TSource, TRuntime>;
  /** Return the configured runtime state, or `null` if this DO is not currently configured. */
  getConfigured: () => ConfiguredRuntimeState<TStored, TSource, TRuntime> | null;
  /** Return the configured runtime state, or throw when this DO is not currently configured. */
  requireConfigured: (message?: string) => ConfiguredRuntimeState<TStored, TSource, TRuntime>;
  /** Resolve the org id by reading and trimming `stored.orgId`. */
  getStoredOrgId: (stored: TStored | null) => string | null;
  /** Throw if an admin update attempts to bind this DO to a different org. */
  assertSameOrg: (stored: TStored | null, orgId: string) => void;
  /** Persist an outbox item and schedule alarm processing. */
  dispatch: (item: TOutbox) => Promise<void>;
  /** Forward the Durable Object alarm to the current durable-hooks dispatcher, if any, then process outbox. */
  alarm: () => Promise<void>;
  /** Fetch through the configured runtime/mounts, including not-configured and org-bound checks. */
  fetch: (request: Request, context?: FragmentDurableObjectFetchContext) => Promise<Response>;
  /**
   * Return durable hook accessors for a selected fragment.
   *
   * Multi-fragment runtimes choose the target fragment with `selectFragment`; single-fragment
   * runtimes usually return `state.runtime`.
   */
  getDurableHookRepository: <TOptions extends DurableHookQueueOptions>(
    selectFragment: (
      state: ConfiguredRuntimeState<TStored, TSource, TRuntime>,
      options: TOptions | undefined,
    ) => AnyFragnoInstantiatedDatabaseFragment,
    parseOptions?: (options: TOptions | undefined) => TOptions | undefined,
  ) => DurableHookRepository<TOptions>;
};

const defaultConfigKey = (name: string) => `${name.toLowerCase()}-config`;

const defaultNotConfiguredResponse = (name: string) =>
  Response.json(
    {
      message: `${name} is not configured for this organisation.`,
      code: "NOT_CONFIGURED",
    },
    { status: 400 },
  );

const defaultOrgMismatchResponse = (name: string, expectedOrgId: string, orgId: string) =>
  Response.json(
    {
      message: `${name} Durable Object is bound to organisation "${expectedOrgId}" and cannot serve requests for organisation "${orgId}".`,
      code: "ORG_ID_MISMATCH",
      expectedOrgId,
      orgId,
    },
    { status: 409 },
  );

const readDefaultOrgId = (stored: unknown) => {
  if (!stored || typeof stored !== "object" || !("orgId" in stored)) {
    return null;
  }

  const orgId = (stored as { orgId?: unknown }).orgId;
  return typeof orgId === "string" && orgId.trim() ? orgId.trim() : null;
};

export function createBackofficeFragmentDurableObject<
  TStored,
  TSource = TStored,
  TRuntime = never,
  TOutbox extends BackofficeOutboxItem = BackofficeOutboxItem,
>(
  options: BackofficeFragmentDurableObjectOptions<TStored, TSource, TRuntime, TOutbox>,
): BackofficeFragmentDurableObject<TStored, TSource, TRuntime, TOutbox> {
  const configKey = options.configKey ?? defaultConfigKey(options.name);
  const outboxKey = options.outboxKey ?? `${options.name.toLowerCase()}-outbox`;
  const isConfigured =
    options.isConfigured ?? ((stored: TStored | null): stored is TStored => stored !== null);
  const toSource = options.toSource ?? ((stored: TStored) => stored as unknown as TSource);
  const fingerprint =
    options.fingerprint ??
    ((source: TSource) => {
      try {
        return JSON.stringify(source);
      } catch {
        return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      }
    });
  const durableHooks = options.durableHooks ?? defaultDurableHookDependencies;

  const scheduleOutboxAlarm = async (delayMs: number = 0) => {
    const now = Date.now();
    const alarmAt = now + delayMs;
    const existingAlarm = await options.state.storage.getAlarm?.();
    if (existingAlarm === undefined || existingAlarm === null || existingAlarm > alarmAt) {
      await options.state.storage.setAlarm(alarmAt);
    }
  };

  const fragmentHost = createFragmentDurableObjectHost({
    name: options.name,
    state: options.state,
    env: options.env,
    createRuntime: options.createRuntime,
    getMigrationFragments: options.getMigrationFragments,
    getHookFragments: options.getHookFragments,
    hostRuntime: options.hostRuntime,
    mounts: options.mounts,
    onProcessError: (error: unknown) => {
      console.error(`${options.name} hook processor error`, error);
    },
    onDispatcherError: (error: unknown) => {
      console.warn(`${options.name} hook processor disabled`, error);
    },
  } as never) as unknown as FragmentDurableObjectHost<TSource, TRuntime>;

  let current: BackofficeFragmentRuntimeState<TStored, TSource, TRuntime> = {
    configured: false,
    stored: null,
  };
  let initializing: Promise<BackofficeFragmentRuntimeState<TStored, TSource, TRuntime>> | null =
    null;
  let initializingFingerprint: string | null = null;

  const getStoredOrgId = (stored: TStored | null) => {
    if (!stored) {
      return null;
    }

    return options.getStoredOrgId ? options.getStoredOrgId(stored) : readDefaultOrgId(stored);
  };

  const requireStoredOrgId = (stored: TStored) => {
    const orgId = getStoredOrgId(stored);
    if (!orgId) {
      throw new Error(`Stored ${options.name} config is missing an organisation id.`);
    }
    return orgId;
  };

  const assertSameOrg = (stored: TStored | null, orgId: string) => {
    const expectedOrgId = getStoredOrgId(stored);
    if (!expectedOrgId || expectedOrgId === orgId) {
      return;
    }

    throw new Error(
      `${options.name} Durable Object is already bound to organisation "${expectedOrgId}".`,
    );
  };

  const loadStored = async () => {
    const raw = await options.state.storage.get<unknown>(configKey);
    if (raw === undefined || raw === null) {
      return null;
    }

    return options.parseStored ? options.parseStored(raw) : (raw as TStored);
  };

  const initializeFromStored = async (stored: TStored | null) => {
    if (!isConfigured(stored)) {
      current = { configured: false, stored };
      await ensurePendingOutboxAlarm();
      return current;
    }

    requireStoredOrgId(stored);

    const source = toSource(stored);
    const nextFingerprint = fingerprint(source, stored);

    if (current.configured && current.fingerprint === nextFingerprint) {
      current = { ...current, stored, source };
      await ensurePendingOutboxAlarm();
      return current;
    }

    if (initializing && initializingFingerprint === nextFingerprint) {
      return initializing;
    }

    initializingFingerprint = nextFingerprint;
    initializing = fragmentHost
      .initialize(source)
      .then(async (runtime) => {
        current = {
          configured: true,
          stored,
          source,
          runtime,
          fingerprint: nextFingerprint,
        };
        await ensurePendingOutboxAlarm();
        return current;
      })
      .catch((error) => {
        console.log(`${options.name} migration failed`, { error });
        throw error;
      })
      .finally(() => {
        initializing = null;
        initializingFingerprint = null;
      });

    return initializing;
  };

  const getDurableHookRepository = <TOptions extends DurableHookQueueOptions>(
    selectFragment: (
      state: ConfiguredRuntimeState<TStored, TSource, TRuntime>,
      options: TOptions | undefined,
    ) => AnyFragnoInstantiatedDatabaseFragment,
    parseOptions?: (options: TOptions | undefined) => TOptions | undefined,
  ): DurableHookRepository<TOptions> => {
    if (!current.configured) {
      return durableHooks.createEmptyRepository();
    }

    const repository = durableHooks.createRepository<TOptions>((queueOptions) =>
      selectFragment(
        current as ConfiguredRuntimeState<TStored, TSource, TRuntime>,
        parseOptions?.(queueOptions) ?? queueOptions,
      ),
    );

    return durableHooks.createRpcTarget<TOptions>({
      getHookQueue: async (options) =>
        await repository.getHookQueue(parseOptions?.(options) ?? options),
      getHook: async (hookId, options) =>
        await repository.getHook(hookId, parseOptions?.(options) ?? options),
    });
  };

  const outboxItemKeyPrefix = `${outboxKey}:`;
  const getOutboxItemKey = (id: string) => `${outboxItemKeyPrefix}${id}`;

  const loadOutboxItems = async (): Promise<TOutbox[]> => {
    if (typeof options.state.storage.list !== "function") {
      return [];
    }

    return [
      ...(await options.state.storage.list<TOutbox>({ prefix: outboxItemKeyPrefix })).values(),
    ];
  };

  const ensurePendingOutboxAlarm = async () => {
    if (!options.outbox) {
      return;
    }

    const items = await loadOutboxItems();
    if (items.some((item) => !item.dispatchedAt)) {
      await scheduleOutboxAlarm(0);
    }
  };

  const processOutbox = async () => {
    if (!options.outbox) {
      return;
    }

    const stored = await loadStored();
    if (!stored) {
      return;
    }

    const items = await loadOutboxItems();
    const pending = items.filter((item) => !item.dispatchedAt);
    if (!pending.length) {
      return;
    }

    let shouldRetry = false;

    for (const item of pending) {
      try {
        await options.outbox.dispatch(item, { env: options.env, stored });
        await options.state.storage.put(getOutboxItemKey(item.id), {
          ...item,
          dispatchedAt: new Date().toISOString(),
          lastError: undefined,
        });
      } catch (error) {
        const lastError = error instanceof Error ? error.message : String(error);
        await options.state.storage.put(getOutboxItemKey(item.id), {
          ...item,
          attempts: (item.attempts ?? 0) + 1,
          lastError,
        });
        shouldRetry = true;
      }
    }

    if (shouldRetry) {
      await scheduleOutboxAlarm(options.outbox?.retryDelayMs ?? 30_000);
    }
  };

  const assertRequestOrgMatches = (request: Request) => {
    if (!current.configured) {
      return null;
    }

    const expectedOrgId = getStoredOrgId(current.stored);
    const orgId = new URL(request.url).searchParams.get("orgId")?.trim();

    if (!expectedOrgId || !orgId || expectedOrgId === orgId) {
      return null;
    }

    return defaultOrgMismatchResponse(options.name, expectedOrgId, orgId);
  };

  return {
    loadStored,
    initializeFromStored,
    async storeAndInitialize(stored) {
      // Callers must invoke this from inside state.blockConcurrencyWhile(...), so the storage write
      // and runtime replacement are observed as one initialization/update boundary by the DO.
      await options.state.storage.put(configKey, stored);
      return await initializeFromStored(stored);
    },
    async clearConfig() {
      const outboxItemKeys = [
        ...(await options.state.storage.list<TOutbox>({ prefix: outboxItemKeyPrefix })).keys(),
      ];
      await options.state.storage.delete([configKey, outboxKey, ...outboxItemKeys]);
      return await initializeFromStored(null);
    },
    getState: () => current,
    getConfigured: () => (current.configured ? current : null),
    requireConfigured(message = `${options.name} is unavailable.`) {
      if (!current.configured) {
        throw new Error(message);
      }
      return current;
    },
    getStoredOrgId,
    assertSameOrg,
    async dispatch(item) {
      if (!options.outbox) {
        throw new Error(`${options.name} outbox is not configured.`);
      }
      await options.state.storage.put(getOutboxItemKey(item.id), item);
      await scheduleOutboxAlarm(0);
    },
    alarm: async () => {
      let fragmentAlarmError: unknown;

      if (current.configured) {
        try {
          await fragmentHost.alarm();
        } catch (error) {
          fragmentAlarmError = error;
        }
      }

      await processOutbox();

      if (fragmentAlarmError) {
        throw fragmentAlarmError;
      }
    },
    async fetch(request, context) {
      if (!current.configured) {
        return defaultNotConfiguredResponse(options.name);
      }

      const orgMismatchResponse = assertRequestOrgMatches(request);
      if (orgMismatchResponse) {
        return orgMismatchResponse;
      }

      return await fragmentHost.fetch(current.runtime, request, {
        waitUntil: options.state.waitUntil.bind(options.state),
        ...context,
      });
    },
    getDurableHookRepository,
  };
}
