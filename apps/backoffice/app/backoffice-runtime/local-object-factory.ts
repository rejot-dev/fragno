import { AsyncLocalStorage } from "node:async_hooks";

import type { AutomationSourceReader } from "@/fragno/automation/automation-source";

import { InMemoryApiObject } from "../../workers/api.do";
import { InMemoryAuthObject } from "../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../workers/automations.do";
import { InMemoryBillingObject } from "../../workers/billing.do";
import { InMemoryCloudflareObject } from "../../workers/cloudflare.do";
import { InMemoryFormsObject } from "../../workers/forms.do";
import { InMemoryGitHubWebhookRouterObject } from "../../workers/github-webhook-router.do";
import { InMemoryGitHubObject } from "../../workers/github.do";
import { createInMemoryAuthDatabase } from "../../workers/in-memory-auth-database";
import { InMemoryMarketplaceObject } from "../../workers/marketplace.do";
import { InMemoryMcpObject } from "../../workers/mcp.do";
import { InMemoryOtpObject } from "../../workers/otp.do";
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
  type BackofficeFragmentHostOperations,
  type BackofficeRuntimeConfig,
  type BackofficeRuntimeServices,
} from "./runtime-services";

export type LocalBackofficeObjectFactory<TObject> = (input: {
  id: DurableObjectId;
  name: string;
  state: Parameters<LocalDurableObjectFactory<TObject>>[0]["state"];
  env: BackofficeRuntimeEnv;
  runtime: BackofficeRuntimeServices;
  nowEpochMs: () => number;
  readAutomationSource?: LocalObjectFactoryOptions["readAutomationSource"];
  sqliteDataDirectory?: string;
  readonly getAuthDatabase: () => LocalAuthDatabase;
}) => TObject;

export type LocalObjectFactoryOverrides = Partial<
  Record<BackofficeObjectBindingName, LocalBackofficeObjectFactory<unknown>>
>;

export type LocalObjectFactoryOptions = {
  runtimeEnv: BackofficeRuntimeEnv;
  getRuntimeServices: () => BackofficeRuntimeServices;
  createFragmentHostOperations?: (objectId: string) => BackofficeFragmentHostOperations | null;
  clearDurableHooks: (objectId: string) => Promise<void>;
  readAutomationSource?: AutomationSourceReader;
  objectFactories?: LocalObjectFactoryOverrides;
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
  API: ({ state, env, runtime }) =>
    new InMemoryApiObject({
      state,
      env,
      runtime,
    }),
  AUTH: ({ state, env, runtime, getAuthDatabase }) =>
    new InMemoryAuthObject({
      state,
      env: env as never,
      runtime,
      database: getAuthDatabase(),
    }),
  TELEGRAM: ({ state, env, runtime }) =>
    new InMemoryTelegramObject({
      state,
      env,
      runtime,
    }),
  RESEND: ({ state, env, runtime }) =>
    new InMemoryResendObject({
      state,
      env,
      runtime,
    }),
  RESON8: ({ state, env, runtime }) =>
    new InMemoryReson8Object({
      state,
      env,
      runtime,
    }),
  MCP: ({ state, env, runtime }) =>
    new InMemoryMcpObject({
      state,
      env,
      runtime,
    }),
  OTP: ({ state, env, runtime }) =>
    new InMemoryOtpObject({
      state,
      env,
      runtime,
    }),
  UPLOAD: ({ state, env, runtime }) =>
    new InMemoryUploadObject({
      state,
      env: env as never,
      runtime,
    }),
  SANDBOX: createUnavailableLocalObject,
  SANDBOX_MANAGER: ({ state, env, runtime }) =>
    new InMemorySandboxManagerObject({ state, env: env as CloudflareEnv, runtime }),
  GITHUB: ({ state, env, runtime }) =>
    new InMemoryGitHubObject({
      state,
      env: env as never,
      runtime,
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
  FORMS: ({ state, env, runtime }) =>
    new InMemoryFormsObject({
      state,
      env,
      runtime,
    }),
  AUTOMATIONS: ({ state, env, runtime, nowEpochMs, readAutomationSource }) =>
    new InMemoryAutomationsObject({
      state,
      env,
      runtime,
      nowEpochMs,
      readAutomationSource,
    }),
  BILLING: ({ state, env, runtime }) =>
    new InMemoryBillingObject({
      state,
      env,
      runtime,
    }),
  MARKETPLACE: ({ state, env, runtime }) =>
    new InMemoryMarketplaceObject({
      state,
      env,
      runtime,
    }),
} satisfies Record<BackofficeObjectBindingName, LocalBackofficeObjectFactory<unknown>>;

export class LocalObjectFactory implements BackofficeObjectFactory {
  readonly env: BackofficeRuntimeEnv;

  #namespaces: NamespaceMap = {};
  readonly #getRuntimeServices: () => BackofficeRuntimeServices;
  readonly #createFragmentHostOperations: NonNullable<
    LocalObjectFactoryOptions["createFragmentHostOperations"]
  >;
  readonly #readAutomationSource?: LocalObjectFactoryOptions["readAutomationSource"];
  readonly #objectFactories?: LocalObjectFactoryOverrides;
  readonly #sqlite?: LocalObjectFactoryOptions["sqlite"];
  readonly #executionCoordinator: BackofficeObjectExecutionCoordinator;
  readonly #sqliteCoordination: SqliteObjectCoordination | null;
  readonly #clearDurableHooks: (objectId: string) => Promise<void>;
  readonly #authDatabases: LocalAuthDatabases = {
    byState: new WeakMap(),
    owned: new Set(),
  };
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
            },
            env: this.env as CloudflareEnv,
            nowEpochMs: this.now(),
          }),
        ),
    };
    return { commands: stub, http };
  }

  async restorePersistedInstances(): Promise<void> {
    for (const id of this.#sqlite?.storage.objectIds() ?? []) {
      const { namespace, durableObjectId } = this.#resolvePersistedObject(id);
      await namespace.restorePersisted(durableObjectId);
    }
  }

  async discoverPersistedInstances(): Promise<void> {
    for (const id of this.#sqlite?.storage.objectIds() ?? []) {
      const { namespace, durableObjectId } = this.#resolvePersistedObject(id);
      await namespace.discoverPersisted(durableObjectId);
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
    const failures: Error[] = [];

    await this.#runAtCurrentTime(async () => {
      for (const { namespace, instance, alarm: dueAlarm } of due) {
        try {
          await namespace.deliverAlarm(instance, dueAlarm, now);
        } catch (cause) {
          failures.push(
            new Error(`Local Backoffice object alarm failed for ${instance.name}.`, { cause }),
          );
        }
      }
    });

    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more local Backoffice object alarms failed.");
    }
  }

  async cleanup(): Promise<void> {
    await this.#executionCoordinator.waitForIdle();
    await this.#sqliteCoordination?.waitForIdle();
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
        upload: this.#hasNamespace("UPLOAD"),
        github: this.#hasNamespace("GITHUB"),
        githubWebhookRouter: this.#hasNamespace("GITHUB_WEBHOOK_ROUTER"),
        cloudflare: this.#hasNamespace("CLOUDFLARE"),
        sandbox: this.#hasNamespace("SANDBOX"),
      },
    };
  }

  #registerNamespaces() {
    for (const bindingName of Object.keys(localObjectFactories) as BackofficeObjectBindingName[]) {
      this.#register(
        { name: bindingName },
        localObjectFactories[bindingName] as LocalBackofficeObjectFactory<unknown>,
      );
    }
  }

  #register<TObject>(
    binding: BackofficeObjectBinding<TObject>,
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
        const runtime = this.#getRuntimeServices();
        const state = input.state;
        return factory({
          ...input,
          env: this.env,
          runtime: {
            ...runtime,
            adapters: runtime.adapters.forScope(
              createDurableObjectDatabaseAdapterScope(input.state as unknown as DurableObjectState),
            ),
            fragmentHostOperations: this.#createFragmentHostOperations(String(input.id)),
            objectRuntime:
              state instanceof SqliteDurableObjectState
                ? {
                    registerRefresh: (refresh) => {
                      state.registerRuntimeRefresh(refresh);
                    },
                    clearDurableHooks: () => this.#clearDurableHooks(String(input.id)),
                  }
                : null,
          },
          nowEpochMs: () => this.now(),
          readAutomationSource: this.#readAutomationSource,
          sqliteDataDirectory: this.#sqlite?.directory,
          getAuthDatabase: () =>
            getLocalAuthDatabase(this.#authDatabases, input.state, this.#sqlite?.directory, () =>
              this.now(),
            ),
        });
      },
    }) as LocalDurableObjectNamespace<unknown>;
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
    const binding = id.slice(0, separator) as BackofficeObjectBindingName;
    const namespace = this.#namespaces[binding];
    if (!namespace || separator === -1) {
      throw new Error(`Unknown persisted Backoffice object identity: ${id}`);
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
