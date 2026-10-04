import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { FragmentDurableObjectHostOperations } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";

import type { Storage } from "@earendil-works/pi-durable";

import type { AutomationSourceReader } from "@/fragno/automation/automation-source";
import {
  piAgentObjectName,
  type PiAgent,
  type PiAgentConfig,
  type PiAvailableModel,
} from "@/fragno/pi-manager/pi-agent-contract";
import type { CreateSandboxRuntimeProviders } from "@/sandbox/contracts";

import { InMemoryApiObject } from "../../workers/api.do";
import { InMemoryAuthObject } from "../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../workers/automations.do";
import { InMemoryBillingObject } from "../../workers/billing.do";
import { InMemoryCloudflareObject } from "../../workers/cloudflare.do";
import { InMemoryFormsObject } from "../../workers/forms.do";
import { InMemoryGitHubWebhookRouterObject } from "../../workers/github-webhook-router.do";
import { InMemoryGitHubObject } from "../../workers/github.do";
import { createInMemoryAuthDatabase } from "../../workers/in-memory-auth-database";
import { noOpBackofficeConfiguredObjectLifecycle } from "../../workers/lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "../../workers/lib/backoffice-object-implementation";
import {
  createPiDurableHarnessOptions,
  createPiDurableModels,
  listSupportedPiDurableModels,
} from "../../workers/lib/pi-durable-harness-options";
import { InMemoryMarketplaceObject } from "../../workers/marketplace.do";
import { InMemoryMcpObject } from "../../workers/mcp.do";
import { InMemoryOtpObject } from "../../workers/otp.do";
import { InMemoryPiManagerObject } from "../../workers/pi-manager.do";
import { InMemoryPiObject } from "../../workers/pi.do";
import { InMemoryProjectConnectorObject } from "../../workers/project-connector.do";
import { InMemoryResendObject } from "../../workers/resend.do";
import { InMemoryReson8Object } from "../../workers/reson8.do";
import { InMemorySandboxManagerObject } from "../../workers/sandbox-manager.do";
import { InMemoryTelegramObject } from "../../workers/telegram.do";
import { InMemoryUploadObject } from "../../workers/upload.do";
import type { BackofficeRuntimeEnv } from "./backoffice-runtime-env";
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
  parseSignUpInvitationsEnabled,
  type BackofficeRuntimeConfig,
  type BackofficeRuntimeServices,
} from "./runtime-services";

type LocalObjectBindingName = BackofficeObjectBindingName | "PI";

export type LocalBackofficeObjectFactory<TObject> = (input: {
  id: DurableObjectId;
  name: string;
  state: Parameters<LocalDurableObjectFactory<TObject>>[0]["state"];
  env: BackofficeRuntimeEnv;
  runtime: BackofficeRuntimeServices;
  implementation: BackofficeObjectImplementation;
  nowEpochMs: () => number;
  readAutomationSource?: LocalObjectFactoryOptions["readAutomationSource"];
  sqliteDataDirectory?: string;
  readonly createSandboxProviders: CreateSandboxRuntimeProviders;
  readonly getAuthDatabase: () => LocalAuthDatabase;
  readonly getPiAgent: (config: PiAgentConfig) => PiAgent;
  readonly piAgentIdFromConfig: (config: PiAgentConfig) => DurableObjectId;
  readonly openPiSessionStore: () => Promise<Storage>;
  readonly piAvailableModels: readonly PiAvailableModel[] | null;
}) => TObject;

export type LocalObjectFactoryOverrides = Partial<
  Record<LocalObjectBindingName, LocalBackofficeObjectFactory<unknown>>
>;

export type LocalObjectFactoryOptions = {
  runtimeEnv: BackofficeRuntimeEnv;
  getRuntimeServices: () => BackofficeRuntimeServices;
  createFragmentHostOperations?: (
    objectId: string,
  ) => FragmentDurableObjectHostOperations<BackofficeRuntimeEnv> | null;
  clearDurableHooks: (objectId: string) => Promise<void>;
  readAutomationSource?: AutomationSourceReader;
  objectFactories?: LocalObjectFactoryOverrides;
  piAvailableModels?: readonly PiAvailableModel[];
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

class UnavailableLocalDurableObject {
  async fetch() {
    return Response.json({ message: "Not configured", code: "NOT_CONFIGURED" }, { status: 400 });
  }

  async alarm() {}

  async getAdminConfig() {
    return { configured: false };
  }

  async resetAdminConfig() {
    return { configured: false };
  }

  async setAdminConfig() {
    return { configured: false };
  }

  async queueEmail() {
    throw new Error("Resend is not configured.");
  }

  async getDurableHookQueue() {
    return {
      configured: false,
      hooksEnabled: false,
      namespace: null,
      items: [],
      cursor: undefined,
      hasNextPage: false,
    };
  }

  async getDurableHook() {
    return null;
  }

  async getUserAuthorityFacts() {
    return {
      active: false,
      role: null,
      organizationMember: false,
    } as const;
  }

  async getAllOrganizations() {
    return [];
  }

  async getOrganizationBySlug() {
    return null;
  }

  async hasOrganizationMember() {
    return false;
  }

  async getDevOrganizations() {
    return [];
  }

  async ensureAdminConfig() {
    return { configured: false };
  }

  async redeliverFailedInstallationWebhooks() {}

  async resolveProjectForExecution() {
    return null;
  }

  async listSandboxInstances() {
    return [];
  }

  async getSandboxInstance() {
    return null;
  }

  async requestSandboxInstance() {
    throw new Error("Automations is not configured.");
  }

  async requestSandboxInstanceStop() {
    return null;
  }

  async requestStaticMarketplacePublications() {
    throw new Error("Automations is not configured.");
  }

  async requestMarketplaceIngestion() {
    throw new Error("Automations is not configured.");
  }

  async restartMarketplaceIngestion() {
    throw new Error("Automations is not configured.");
  }

  async getMarketplaceIngestion() {
    return null;
  }

  async listMarketplaceIngestions() {
    return [];
  }

  async getRuntimeStatus() {
    return { status: "stopped" };
  }

  async getRealtimeOriginDiagnostic() {
    return null;
  }
}

const createUnavailableLocalObject = () => new UnavailableLocalDurableObject();

const localObjectFactories = {
  API: ({ state, env, runtime, implementation }) =>
    new InMemoryApiObject({
      state,
      env,
      runtime,
      implementation,
    }),
  AUTH: ({ state, env, runtime, getAuthDatabase }) =>
    new InMemoryAuthObject({
      state,
      env: env as never,
      runtime,
      database: getAuthDatabase(),
    }),
  TELEGRAM: ({ state, env, runtime, implementation }) =>
    new InMemoryTelegramObject({
      state,
      env,
      runtime,
      implementation,
    }),
  RESEND: ({ state, env, runtime, implementation }) =>
    new InMemoryResendObject({
      state,
      env,
      runtime,
      implementation,
    }),
  RESON8: ({ state, env, runtime, implementation }) =>
    new InMemoryReson8Object({
      state,
      env,
      runtime,
      implementation,
    }),
  MCP: ({ state, env, runtime, implementation }) =>
    new InMemoryMcpObject({
      state,
      env,
      runtime,
      implementation,
    }),
  PROJECT_CONNECTOR: ({ state, env, runtime, implementation }) =>
    new InMemoryProjectConnectorObject({ state, env, runtime, implementation }),
  OTP: ({ state, env, runtime, implementation }) =>
    new InMemoryOtpObject({
      state,
      env,
      runtime,
      implementation,
    }),
  UPLOAD: ({ state, env, runtime, implementation }) =>
    new InMemoryUploadObject({
      state,
      env: env as never,
      runtime,
      implementation,
    }),
  SANDBOX: createUnavailableLocalObject,
  SANDBOX_MANAGER: ({ state, runtime, implementation, createSandboxProviders }) =>
    new InMemorySandboxManagerObject({
      state,
      runtime,
      implementation,
      sandboxProviders: createSandboxProviders(state.id.toString()),
    }),
  GITHUB: ({ state, env, runtime, implementation }) =>
    new InMemoryGitHubObject({
      state,
      env: env as never,
      runtime,
      implementation,
    }),
  GITHUB_WEBHOOK_ROUTER: ({ state, env, runtime }) =>
    new InMemoryGitHubWebhookRouterObject({
      state,
      env: env as never,
      runtime,
    }),
  CLOUDFLARE: ({ state, env, runtime }) =>
    new InMemoryCloudflareObject({
      state,
      env,
      runtime,
    }),
  FORMS: ({ state, env, runtime, implementation }) =>
    new InMemoryFormsObject({
      state,
      env,
      runtime,
      implementation,
    }),
  AUTOMATIONS: ({ state, env, runtime, implementation, nowEpochMs, readAutomationSource }) =>
    new InMemoryAutomationsObject({
      state,
      env,
      runtime,
      implementation,
      nowEpochMs,
      readAutomationSource,
    }),
  PI: ({ state, env, runtime, nowEpochMs, openPiSessionStore, piAgentIdFromConfig }) =>
    new InMemoryPiObject({
      state,
      options: createPiDurableHarnessOptions(env),
      runtime,
      openStorage: openPiSessionStore,
      idFromConfig: piAgentIdFromConfig,
      nowEpochMs,
    }),
  PI_MANAGER: ({
    state,
    env,
    runtime,
    implementation,
    nowEpochMs,
    getPiAgent,
    piAvailableModels,
  }) => {
    const supportedAvailableModels = piAvailableModels
      ? async () => piAvailableModels
      : (() => {
          const models = createPiDurableModels(env);
          return async () => await listSupportedPiDurableModels(models);
        })();
    return new InMemoryPiManagerObject({
      state,
      env,
      runtime,
      implementation,
      agent: getPiAgent,
      supportedAvailableModels,
      nowEpochMs,
    });
  },
  BILLING: ({ state, env, runtime, implementation }) =>
    new InMemoryBillingObject({
      state,
      env,
      runtime,
      implementation,
    }),
  MARKETPLACE: ({ state, env, runtime, implementation }) =>
    new InMemoryMarketplaceObject({
      state,
      env,
      runtime,
      implementation,
    }),
} satisfies Record<LocalObjectBindingName, LocalBackofficeObjectFactory<unknown>>;

export class LocalObjectFactory implements BackofficeObjectFactory {
  readonly env: BackofficeRuntimeEnv;

  #namespaces: NamespaceMap = {};
  readonly #getRuntimeServices: () => BackofficeRuntimeServices;
  readonly #createFragmentHostOperations: NonNullable<
    LocalObjectFactoryOptions["createFragmentHostOperations"]
  >;
  readonly #readAutomationSource?: LocalObjectFactoryOptions["readAutomationSource"];
  readonly #objectFactories?: LocalObjectFactoryOverrides;
  readonly #piAvailableModels: readonly PiAvailableModel[] | null;
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
  #timeOffsetMs = 0;
  readonly #drainTimeEpochMs = new AsyncLocalStorage<{
    epochMs: number;
    active: boolean;
  }>();

  constructor(options: LocalObjectFactoryOptions) {
    this.env = options.runtimeEnv;
    this.#getRuntimeServices = options.getRuntimeServices;
    this.#createFragmentHostOperations = options.createFragmentHostOperations ?? (() => null);
    this.#readAutomationSource = options.readAutomationSource;
    this.#objectFactories = options.objectFactories;
    this.#piAvailableModels = options.piAvailableModels ?? null;
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
      throw new Error(`Local Backoffice object binding ${address.binding} is not registered.`);
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
              authorization: context.authorization,
            },
            env: this.env as unknown as CloudflareEnv,
            nowEpochMs: this.now(),
          }),
        ),
    };
    return { commands: stub, http };
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
    const agents = this.#namespaces.PI as LocalDurableObjectNamespace<InMemoryPiObject>;
    await Promise.all(agents.instances().map(({ object }) => object.close()));
    await Promise.all(
      [...this.#piSessionStores.values()].map(async (storage) =>
        (await storage).close(BACKGROUND_CONTEXT),
      ),
    );
    this.#piSessionStores.clear();
    await Promise.all([...this.#authDatabases.owned].map(async (database) => database.destroy()));
    this.#authDatabases.owned.clear();
  }

  createRuntimeConfig(): BackofficeRuntimeConfig {
    return {
      ...(this.env.DOCS_PUBLIC_BASE_URL?.trim()
        ? { docsPublicBaseUrl: this.env.DOCS_PUBLIC_BASE_URL.trim() }
        : {}),
      authEmailVerification: parseAuthEmailVerificationRuntimeConfig({
        enabled: this.env.AUTH_EMAIL_VERIFICATION_ENABLED,
        publicBaseUrl: this.env.DOCS_PUBLIC_BASE_URL,
      }),
      signUpInvitationsEnabled: parseSignUpInvitationsEnabled({
        enabled: this.env.SIGN_UP_INVITATIONS_ENABLED,
        publicBaseUrl: this.env.DOCS_PUBLIC_BASE_URL,
        accountCreationAvailable: this.#hasNamespace("AUTH"),
      }),
      bindings: {
        api: this.#hasNamespace("API"),
        auth: this.#hasNamespace("AUTH"),
        automations: this.#hasNamespace("AUTOMATIONS"),
        billing: this.#hasNamespace("BILLING"),
        marketplace: this.#hasNamespace("MARKETPLACE"),
        telegram: this.#hasNamespace("TELEGRAM"),
        otp: this.#hasNamespace("OTP"),
        resend: this.#hasNamespace("RESEND"),
        reson8: this.#hasNamespace("RESON8"),
        mcp: this.#hasNamespace("MCP"),
        projectConnector: this.#hasNamespace("PROJECT_CONNECTOR"),
        upload: this.#hasNamespace("UPLOAD"),
        github: this.#hasNamespace("GITHUB"),
        githubWebhookRouter: this.#hasNamespace("GITHUB_WEBHOOK_ROUTER"),
        cloudflare: this.#hasNamespace("CLOUDFLARE"),
        sandbox: this.#hasNamespace("SANDBOX"),
      },
    };
  }

  #registerNamespaces() {
    for (const bindingName of Object.keys(localObjectFactories) as LocalObjectBindingName[]) {
      this.#register(
        { name: bindingName },
        localObjectFactories[bindingName] as LocalBackofficeObjectFactory<unknown>,
      );
    }
  }

  #register<TObject>(
    binding: { name: LocalObjectBindingName },
    createObject: LocalBackofficeObjectFactory<TObject>,
  ) {
    const override = this.#objectFactories?.[binding.name] as
      | LocalBackofficeObjectFactory<TObject>
      | undefined;
    const factory = override ?? createObject;

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
            const agents = this.#namespaces.PI as LocalDurableObjectNamespace<InMemoryPiObject>;
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
    const storage = openNodeSqliteStorage(filename);
    this.#piSessionStores.set(objectId, storage);
    return storage;
  }

  #namespace<TObject>(
    binding: BackofficeObjectBinding<TObject>,
  ): LocalDurableObjectNamespace<TObject> {
    const namespace = this.#namespaces[binding.name];
    if (!namespace) {
      throw new Error(`Local Backoffice object binding ${binding.name} is not registered.`);
    }

    return namespace as LocalDurableObjectNamespace<TObject>;
  }

  #hasNamespace(bindingName: BackofficeObjectBindingName) {
    return Boolean(this.#namespaces[bindingName]);
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
