import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";
import type { FragmentDurableObjectHostOperations } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";

import type { Storage } from "@earendil-works/pi-durable";

import type { AutomationSourceReader } from "@/fragno/automation/automation-source";
import {
  piAgentObjectName,
  type PiAgent,
  type PiAgentAddress,
  type PiAvailableModel,
} from "@/fragno/pi/agent/pi-agent-contract";
import type { CreateSandboxRuntimeProviders } from "@/sandbox/contracts";

import { createInMemoryAuthDatabase } from "../../workers/in-memory-auth-database";
import { noOpBackofficeConfiguredObjectLifecycle } from "../../workers/lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "../../workers/lib/backoffice-object-implementation";
import type { PiObject } from "../../workers/pi-object";
import type { BackofficeRuntimeEnv } from "./backoffice-runtime-env";
import type { BackofficeTelemetry } from "./backoffice-telemetry";
import { createDurableObjectDatabaseAdapterScope } from "./database-adapters";
import {
  createAuthorizedBackofficeObjectRequest,
  removeBackofficeInternalContextHeader,
} from "./internal-object-request";
import {
  InMemoryDurableObjectState,
  LocalDurableObjectNamespace,
  ProcessLocalObjectExecutionCoordinator,
  type BackofficeDurableObjectState,
  type BackofficeObjectExecutionCoordinator,
  type LocalDurableObjectFactory,
  type LocalDurableObjectInstance,
} from "./local-durable-objects";
import { createNodeBackofficeObjectImplementation } from "./node/node-object-implementation";
import { createSqliteAuthDatabase } from "./node/sqlite-auth-database";
import { SqliteDurableObjectState } from "./node/sqlite-durable-object-state";
import { SqliteObjectCoordination } from "./node/sqlite-object-coordination";
import type { SqliteBackofficeObjectStorage } from "./node/sqlite-object-storage";
import type {
  BackofficeObjectAddress,
  BackofficeObjectBinding,
  BackofficeObjectBindingName,
  BackofficeObjectFactory,
  BackofficeObjectHandle,
  BackofficeObjectHttp,
} from "./object-registry";
import { assertBackofficeObjectAddressAllowed } from "./object-registry";
import { encodeBackofficeObjectAddress } from "./object-registry";
import {
  parseAuthEmailVerificationRuntimeConfig,
  parseBooleanEnv,
  parseSignUpAccessCodesRequired,
  type BackofficeRuntimeConfig,
  type BackofficeRuntimeServices,
} from "./runtime-services";

export type LocalObjectBindingName = BackofficeObjectBindingName | "PI";

export type LocalBackofficeObjectFactoryInput = {
  id: DurableObjectId;
  name: string;
  state: Parameters<LocalDurableObjectFactory<unknown>>[0]["state"];
  env: BackofficeRuntimeEnv;
  runtime: BackofficeRuntimeServices;
  implementation: BackofficeObjectImplementation;
  nowEpochMs: () => number;
  readAutomationSource?: LocalObjectFactoryOptions["readAutomationSource"];
  sqliteDataDirectory?: string;
  readonly createSandboxProviders: CreateSandboxRuntimeProviders;
  readonly getAuthDatabase: () => LocalAuthDatabase;
  readonly getPiAgent: (address: PiAgentAddress) => PiAgent;
  readonly piAgentIdFromConfig: (config: PiAgentConfig) => DurableObjectId;
  readonly openPiSessionStore: () => Promise<Storage>;
  readonly piAvailableModels: readonly PiAvailableModel[] | null;
};

export type LocalBackofficeObjectFactory<TObject> = (
  input: LocalBackofficeObjectFactoryInput,
) => TObject;

/**
 * The objects a local runtime loads. Tests list only the objects they use, so they do not import
 * every object implementation and its SDKs.
 *
 * `null` declares that the runtime has no such object: it reports the binding as unconfigured, as a
 * deployment without it would. Unlisted bindings report as configured but fail when used, so a
 * missing object fails loudly instead of silently switching its feature off.
 */
export type LocalBackofficeObjects = Partial<
  Record<LocalObjectBindingName, LocalBackofficeObjectFactory<unknown> | null>
>;

export type LocalObjectFactoryOptions = {
  runtimeEnv: BackofficeRuntimeEnv;
  telemetry: BackofficeTelemetry;
  getRuntimeServices: () => BackofficeRuntimeServices;
  createFragmentHostOperations?: (
    objectId: string,
  ) => FragmentDurableObjectHostOperations<BackofficeRuntimeEnv> | null;
  clearDurableHooks: (objectId: string) => Promise<void>;
  readAutomationSource?: AutomationSourceReader;
  objects: LocalBackofficeObjects;
  piAvailableModels?: readonly PiAvailableModel[];
  /** Whether the PI_MANAGER factory runs Workers AI; local runtimes have no `AI` binding. */
  workersAi?: boolean;
  createSandboxProviders?: CreateSandboxRuntimeProviders;
  sqlite?: { directory: string; storage: SqliteBackofficeObjectStorage };
};

type NamespaceMap = Record<string, LocalDurableObjectNamespace<unknown>>;

type LocalAuthDatabase = ReturnType<typeof createInMemoryAuthDatabase>;

type LocalAuthDatabases = {
  readonly byState: WeakMap<BackofficeDurableObjectState, LocalAuthDatabase>;
  readonly owned: Set<LocalAuthDatabase>;
};

function getLocalAuthDatabase(
  databases: LocalAuthDatabases,
  state: BackofficeDurableObjectState,
  sqliteDataDirectory: string | undefined,
  nowEpochMs: () => number,
): LocalAuthDatabase {
  const existing = databases.byState.get(state);
  if (existing) {
    return existing;
  }
  const database = sqliteDataDirectory
    ? createSqliteAuthDatabase(sqliteDataDirectory, nowEpochMs)
    : createInMemoryAuthDatabase(nowEpochMs);
  databases.byState.set(state, database);
  databases.owned.add(database);
  return database;
}

export class LocalObjectFactory implements BackofficeObjectFactory {
  readonly env: BackofficeRuntimeEnv;

  #namespaces: NamespaceMap = {};
  readonly #getRuntimeServices: () => BackofficeRuntimeServices;
  readonly #telemetry: BackofficeTelemetry;
  readonly #createFragmentHostOperations: NonNullable<
    LocalObjectFactoryOptions["createFragmentHostOperations"]
  >;
  readonly #readAutomationSource?: LocalObjectFactoryOptions["readAutomationSource"];
  readonly #objects: LocalBackofficeObjects;
  readonly #piAvailableModels: readonly PiAvailableModel[] | null;
  readonly #workersAi: boolean;
  readonly #createSandboxProviders: CreateSandboxRuntimeProviders;
  readonly #sqlite?: LocalObjectFactoryOptions["sqlite"];
  readonly #executionCoordinator: BackofficeObjectExecutionCoordinator;
  readonly #sqliteCoordination: SqliteObjectCoordination | null;
  readonly #clearDurableHooks: (objectId: string) => Promise<void>;
  readonly #authDatabases: LocalAuthDatabases = {
    byState: new WeakMap(),
    owned: new Set(),
  };
  readonly #piSessionStores = new Map<string, Promise<Storage>>();
  /** Unlisted bindings that were used; callers may have caught the error and degraded. */
  readonly #unloadedUses = new Set<string>();
  #timeOffsetMs = 0;
  readonly #drainTimeEpochMs = new AsyncLocalStorage<{
    epochMs: number;
    active: boolean;
  }>();

  constructor(options: LocalObjectFactoryOptions) {
    this.env = options.runtimeEnv;
    this.#getRuntimeServices = options.getRuntimeServices;
    this.#telemetry = options.telemetry;
    this.#createFragmentHostOperations = options.createFragmentHostOperations ?? (() => null);
    this.#readAutomationSource = options.readAutomationSource;
    this.#objects = options.objects;
    this.#piAvailableModels = options.piAvailableModels ?? null;
    this.#workersAi = options.workersAi ?? false;
    this.#createSandboxProviders = options.createSandboxProviders ?? (() => ({}));
    this.#sqlite = options.sqlite;
    this.#sqliteCoordination = options.sqlite
      ? new SqliteObjectCoordination(options.sqlite.storage)
      : null;
    this.#executionCoordinator = new ProcessLocalObjectExecutionCoordinator();
    this.#clearDurableHooks = options.clearDurableHooks;
    this.#registerNamespaces();
  }

  hasInstance(address: BackofficeObjectAddress): boolean {
    assertBackofficeObjectAddressAllowed(address);
    const namespace = this.#namespaces[address.binding];
    return namespace?.has(namespace.idFromName(encodeBackofficeObjectAddress(address))) ?? false;
  }

  async restart(address: BackofficeObjectAddress): Promise<void> {
    assertBackofficeObjectAddressAllowed(address);
    const namespace = this.#namespaces[address.binding];
    if (!namespace) {
      throw this.#missingBindingError(address.binding);
    }
    const id = namespace.idFromName(encodeBackofficeObjectAddress(address));
    await namespace.restart(id);
  }

  get<TCommands>(
    binding: BackofficeObjectBinding<TCommands>,
    address: BackofficeObjectAddress,
  ): BackofficeObjectHandle<TCommands> {
    if (address.binding !== binding.name) {
      throw new Error(
        `Backoffice object address binding ${address.binding} does not match requested binding ${binding.name}.`,
      );
    }
    assertBackofficeObjectAddressAllowed(address);
    if (!this.#namespaces[binding.name] && this.#isConfigured(binding.name)) {
      return this.#unloadedHandle<TCommands>(binding.name);
    }
    const namespace = this.#namespace<TCommands>(binding);
    const encodedName = encodeBackofficeObjectAddress(address);
    const id = namespace.idFromName(encodedName);
    const stub = namespace.get(id) as TCommands & {
      fetch(request: Request): Promise<Response>;
    };
    const http: BackofficeObjectHttp & { readonly id: DurableObjectId } = {
      // Match Cloudflare handles so isolate-local caches behave the same in scenarios.
      id,
      fetch: async (request) => await stub.fetch(removeBackofficeInternalContextHeader(request)),
      fetchAuthorized: async (request, context) =>
        await stub.fetch(
          await createAuthorizedBackofficeObjectRequest({
            request,
            address,
            context: {
              execution: context.execution,
              propagationContext: context.propagationContext ?? null,
            },
            env: this.env as unknown as CloudflareEnv,
            nowEpochMs: this.now(),
          }),
        ),
    };
    return { commands: stub, http };
  }

  piAgent(agent: PiAgentAddress): Pick<BackofficeObjectHttp, "fetchAuthorized"> {
    return {
      fetchAuthorized: async (request, context) => {
        const agents = this.#namespaces.PI as LocalDurableObjectNamespace<PiObject>;
        return await agents.get(agents.idFromName(piAgentObjectName(agent))).fetch(
          await createAuthorizedBackofficeObjectRequest({
            request,
            address: { binding: "PI", agent },
            context: {
              execution: context.execution,
              propagationContext: context.propagationContext ?? null,
            },
            env: this.env as unknown as CloudflareEnv,
            nowEpochMs: this.now(),
          }),
        );
      },
    };
  }

  async restorePersistedInstances(): Promise<void> {
    for (const id of this.#sqlite?.storage.objectIds() ?? []) {
      const persistedObject = this.#resolvePersistedObject(id);
      if (persistedObject) {
        await persistedObject.namespace.restorePersisted(persistedObject.durableObjectId);
      }
    }
  }

  async discoverPersistedInstances(): Promise<void> {
    const objectIds = this.#sqlite?.storage.objectIds() ?? [];
    const discoveries = await Promise.allSettled(
      objectIds.map(async (id) => {
        const persistedObject = this.#resolvePersistedObject(id);
        if (persistedObject) {
          await persistedObject.namespace.discoverPersisted(persistedObject.durableObjectId);
        }
      }),
    );
    const failures = discoveries.flatMap((result, index) =>
      result.status === "rejected"
        ? [
            new Error(`Persisted Backoffice object discovery failed for ${objectIds[index]}.`, {
              cause: result.reason,
            }),
          ]
        : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more persisted Backoffice objects failed discovery.",
      );
    }
  }

  instances(): LocalDurableObjectInstance[] {
    return Object.values(this.#namespaces).flatMap((namespace) => namespace.instances());
  }

  async drainWaitUntil(): Promise<void> {
    await this.#runAtCurrentTime(async () => {
      const results = await Promise.all(
        Object.values(this.#namespaces).map(async (namespace) => await namespace.drainWaitUntil()),
      );
      if (results.some(Boolean)) {
        await Promise.resolve();
      }
    });
  }

  async drainBackground(): Promise<void> {
    await this.#runAtCurrentTime(async () => {
      await Promise.all(
        Object.values(this.#namespaces).map(async (namespace) => {
          await namespace.drainBackground();
        }),
      );
    });
  }

  now(): number {
    const drainTime = this.#drainTimeEpochMs.getStore();
    return drainTime?.active ? drainTime.epochMs : Date.now() + this.#timeOffsetMs;
  }

  advanceTime(ms: number): number {
    this.#timeOffsetMs += ms;
    return this.now();
  }

  async drainAlarms(): Promise<void> {
    const now = this.now();
    const due = Object.values(this.#namespaces).flatMap((namespace) =>
      namespace.instances().flatMap((instance) => {
        const alarm = instance.state.dueAlarm(now);
        return alarm ? [{ namespace, instance, alarm }] : [];
      }),
    );
    const deliveries = await this.#runAtCurrentTime(
      async () =>
        await Promise.allSettled(
          due.map(async ({ namespace, instance, alarm }) => {
            await namespace.deliverAlarm(instance, alarm, now);
          }),
        ),
    );
    const failures = deliveries.flatMap((result, index) =>
      result.status === "rejected"
        ? [
            new Error(`Local Backoffice object alarm failed for ${due[index].instance.name}.`, {
              cause: result.reason,
            }),
          ]
        : [],
    );

    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more local Backoffice object alarms failed.");
    }
  }

  async cleanup(): Promise<void> {
    await this.#executionCoordinator.waitForIdle();
    await this.#sqliteCoordination?.waitForIdle();
    const agents = this.#namespaces.PI as LocalDurableObjectNamespace<PiObject> | undefined;
    await Promise.all((agents?.instances() ?? []).map(({ object }) => object.close()));
    await Promise.all(
      [...this.#piSessionStores.values()].map(async (storage) =>
        (await storage).close(BACKGROUND_CONTEXT),
      ),
    );
    this.#piSessionStores.clear();
    await Promise.all([...this.#authDatabases.owned].map(async (database) => database.destroy()));
    this.#authDatabases.owned.clear();
    if (this.#unloadedUses.size > 0) {
      const bindings = [...this.#unloadedUses].sort().join(", ");
      this.#unloadedUses.clear();
      throw new Error(
        `Objects not loaded in this runtime were used: ${bindings}. Add them to objects, or set them to null to run without them.`,
      );
    }
  }

  createRuntimeConfig(): BackofficeRuntimeConfig {
    return createLocalBackofficeRuntimeConfig(this.env, this.#objects, this.#workersAi);
  }

  #registerNamespaces() {
    for (const [bindingName, factory] of Object.entries(this.#objects)) {
      if (factory) {
        this.#register({ name: bindingName as LocalObjectBindingName }, factory);
      }
    }
  }

  #register<TObject>(
    binding: { name: LocalObjectBindingName },
    factory: LocalBackofficeObjectFactory<TObject>,
  ) {
    this.#namespaces[binding.name] = new LocalDurableObjectNamespace({
      name: binding.name,
      executionCoordinator: this.#executionCoordinator,
      createState: (id) =>
        this.#sqlite && this.#sqliteCoordination
          ? new SqliteDurableObjectState(id, this.#sqlite.storage, this.#sqliteCoordination)
          : new InMemoryDurableObjectState(id),
      createObject: (input) => {
        const baseRuntime = this.#getRuntimeServices();
        const state = input.state;
        const runtime = {
          ...baseRuntime,
          adapters: baseRuntime.adapters.forScope(
            createDurableObjectDatabaseAdapterScope(input.state as unknown as DurableObjectState),
          ),
        };
        const configuredObjectLifecycle =
          state instanceof SqliteDurableObjectState
            ? {
                registerRefresh: (refresh: () => Promise<void>) => {
                  state.registerRuntimeRefresh(refresh);
                },
                clearDurableHooks: () => this.#clearDurableHooks(String(input.id)),
              }
            : noOpBackofficeConfiguredObjectLifecycle;
        const implementation = createNodeBackofficeObjectImplementation({
          state,
          env: this.env,
          runtime,
          telemetry: this.#telemetry,
          fragmentHostOperations: this.#createFragmentHostOperations(String(input.id)) ?? undefined,
          configuredObjectLifecycle,
        });

        return factory({
          ...input,
          env: this.env,
          runtime,
          implementation,
          nowEpochMs: () => this.now(),
          readAutomationSource: this.#readAutomationSource,
          sqliteDataDirectory: this.#sqlite?.directory,
          createSandboxProviders: this.#createSandboxProviders,
          getAuthDatabase: () =>
            getLocalAuthDatabase(this.#authDatabases, input.state, this.#sqlite?.directory, () =>
              this.now(),
            ),
          getPiAgent: (config) => {
            const agents = this.#namespaces.PI as LocalDurableObjectNamespace<PiObject>;
            return agents.get(agents.idFromName(piAgentObjectName(config)));
          },
          piAgentIdFromConfig: (config) =>
            this.#namespaces.PI.idFromName(piAgentObjectName(config)),
          openPiSessionStore: () => this.#openPiSessionStore(String(input.id)),
          piAvailableModels: this.#piAvailableModels,
        });
      },
    }) as LocalDurableObjectNamespace<unknown>;
  }

  #openPiSessionStore(objectId: string): Promise<Storage> {
    const existing = this.#piSessionStores.get(objectId);
    if (existing) {
      return existing;
    }
    const filename = this.#sqlite
      ? path.join(
          this.#sqlite.directory,
          `pi-agent-${createHash("sha256").update(objectId).digest("hex")}.sqlite`,
        )
      : ":memory:";
    const storage = import("@earendil-works/pi-durable/storage/sqlite/node").then(
      ({ openNodeSqliteStorage }) => openNodeSqliteStorage(filename),
    );
    this.#piSessionStores.set(objectId, storage);
    return storage;
  }

  #namespace<TObject>(
    binding: BackofficeObjectBinding<TObject>,
  ): LocalDurableObjectNamespace<TObject> {
    const namespace = this.#namespaces[binding.name];
    if (!namespace) {
      throw this.#missingBindingError(binding.name);
    }

    return namespace as LocalDurableObjectNamespace<TObject>;
  }

  #isConfigured(bindingName: BackofficeObjectBindingName) {
    return this.#objects[bindingName] !== null;
  }

  /**
   * Runtime contexts acquire handles for every configured binding up front, so an unlisted binding
   * fails when it is used, not when its handle is created.
   */
  #unloadedHandle<TCommands>(
    bindingName: BackofficeObjectBindingName,
  ): BackofficeObjectHandle<TCommands> {
    const fail = () => {
      this.#unloadedUses.add(bindingName);
      throw this.#missingBindingError(bindingName);
    };
    const commands = new Proxy(
      {},
      {
        // Awaiting or inspecting a handle is not a use of its object.
        get: (_target, property) =>
          property === "then" || typeof property === "symbol" ? undefined : fail,
      },
    ) as TCommands;
    return { commands, http: { fetch: async () => fail(), fetchAuthorized: async () => fail() } };
  }

  #missingBindingError(bindingName: string) {
    return new Error(
      this.#objects[bindingName as LocalObjectBindingName] === null
        ? `Local Backoffice object binding ${bindingName} is unconfigured in this runtime; check config.bindings before using it.`
        : `Local Backoffice object binding ${bindingName} is not loaded in this runtime. Add it to objects, or set it to null to run without it.`,
    );
  }

  #resolvePersistedObject(id: string) {
    const separator = id.indexOf(":");
    if (separator <= 0 || separator === id.length - 1) {
      throw new Error(`Malformed persisted Backoffice object identity: ${id}`);
    }
    const binding = id.slice(0, separator) as BackofficeObjectBindingName;
    const namespace = this.#namespaces[binding];
    if (!namespace) {
      return null;
    }
    return {
      namespace,
      durableObjectId: namespace.idFromName(id.slice(separator + 1)),
    };
  }

  async #runAtCurrentTime<T>(callback: () => Promise<T>): Promise<T> {
    const drainTime = {
      epochMs: Date.now() + this.#timeOffsetMs,
      active: true,
    };
    try {
      return await this.#drainTimeEpochMs.run(drainTime, callback);
    } finally {
      drainTime.active = false;
    }
  }
}

/** The configuration of a runtime that hosts `objects` outside Cloudflare. */
export function createLocalBackofficeRuntimeConfig(
  env: BackofficeRuntimeEnv,
  objects: LocalBackofficeObjects,
  workersAi: boolean,
): BackofficeRuntimeConfig {
  const isConfigured = (bindingName: BackofficeObjectBindingName) => objects[bindingName] !== null;
  return {
    ...(env.DOCS_PUBLIC_BASE_URL?.trim()
      ? { docsPublicBaseUrl: env.DOCS_PUBLIC_BASE_URL.trim() }
      : {}),
    // Local sandboxes run on the deployed bridge, which forwards its intercepted origin to the
    // deployed Backoffice, so they reach this runtime only at a public URL such as a tunnel.
    sandboxBackofficeBaseUrl: env.DOCS_PUBLIC_BASE_URL?.trim() || null,
    // Sandboxes run in a deployed bridge, which always has containers.
    sandboxContainers: true,
    authEmailVerification: parseAuthEmailVerificationRuntimeConfig({
      enabled: env.AUTH_EMAIL_VERIFICATION_ENABLED,
      publicBaseUrl: env.DOCS_PUBLIC_BASE_URL,
    }),
    signUpAccessCodesRequired: parseSignUpAccessCodesRequired(env.SIGN_UP_ACCESS_CODES_REQUIRED),
    localEmailLog: parseBooleanEnv("LOCAL_EMAIL_LOG", env.LOCAL_EMAIL_LOG),
    workersAi: workersAi,
    bindings: {
      api: isConfigured("API"),
      auth: isConfigured("AUTH"),
      automations: isConfigured("AUTOMATIONS"),
      piManager: isConfigured("PI_MANAGER"),
      billing: isConfigured("BILLING"),
      marketplace: isConfigured("MARKETPLACE"),
      telegram: isConfigured("TELEGRAM"),
      otp: isConfigured("OTP"),
      resend: isConfigured("RESEND"),
      mcp: isConfigured("MCP"),
      projectConnector: isConfigured("PROJECT_CONNECTOR"),
      upload: isConfigured("UPLOAD"),
      blobs: isConfigured("BLOBS"),
      github: isConfigured("GITHUB"),
      githubWebhookRouter: isConfigured("GITHUB_WEBHOOK_ROUTER"),
      cloudflare: isConfigured("CLOUDFLARE"),
      sandbox: isConfigured("SANDBOX"),
    },
  };
}
