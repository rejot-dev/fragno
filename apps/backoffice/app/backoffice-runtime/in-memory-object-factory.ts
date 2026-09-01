import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { MasterFileSystem } from "@/files";

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
import { InMemoryTelegramObject } from "../../workers/telegram.do";
import { InMemoryUploadObject } from "../../workers/upload.do";
import { createDurableObjectDatabaseAdapterScope } from "./database-adapters";
import {
  InMemoryDurableObjectNamespace,
  type InMemoryDurableObjectFactory,
  type InMemoryDurableObjectInstance,
} from "./in-memory-durable-objects";
import type { InMemoryBackofficeRuntimeEnv } from "./in-memory-runtime-env";
import { defaultInMemoryBackofficeRuntimeEnv } from "./in-memory-runtime-env";
import {
  createAuthorizedBackofficeObjectRequest,
  removeBackofficeInternalContextHeader,
} from "./internal-object-request";
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

export type InMemoryBackofficeObjectFactory<TObject> = (input: {
  id: DurableObjectId;
  name: string;
  state: Parameters<InMemoryDurableObjectFactory<TObject>>[0]["state"];
  env: InMemoryBackofficeRuntimeEnv;
  runtime: BackofficeRuntimeServices;
  nowEpochMs: () => number;
  getAutomationFileSystem?: InMemoryObjectFactoryOptions["getAutomationFileSystem"];
}) => TObject;

export type InMemoryObjectFactoryOverrides = Partial<
  Record<BackofficeObjectBindingName, InMemoryBackofficeObjectFactory<unknown>>
>;

export type InMemoryObjectFactoryOptions = {
  env?: Partial<InMemoryBackofficeRuntimeEnv>;
  getRuntimeServices: () => BackofficeRuntimeServices;
  getAutomationFileSystem?: (input: {
    execution: BackofficeExecutionContext;
    purpose?: string;
  }) => Promise<MasterFileSystem>;
  objectFactories?: InMemoryObjectFactoryOverrides;
};

type NamespaceMap = Record<string, InMemoryDurableObjectNamespace<unknown>>;

let inMemoryDateNowOverrideTail = Promise.resolve();

async function acquireInMemoryDateNowOverride(): Promise<() => void> {
  const precedingOverride = inMemoryDateNowOverrideTail;
  let releaseCurrentOverride!: () => void;
  inMemoryDateNowOverrideTail = new Promise<void>((resolve) => {
    releaseCurrentOverride = resolve;
  });
  await precedingOverride;
  return releaseCurrentOverride;
}

class UnavailableInMemoryDurableObject {
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

const createUnavailableObject = () => new UnavailableInMemoryDurableObject();

const inMemoryObjectFactories = {
  API: ({ state, env, runtime }) =>
    new InMemoryApiObject({
      state,
      env,
      runtime,
    }),
  AUTH: ({ state, env, runtime }) =>
    new InMemoryAuthObject({
      state,
      env: env as never,
      runtime,
      database: createInMemoryAuthDatabase(),
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
  SANDBOX: createUnavailableObject,
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
  AUTOMATIONS: ({ state, env, runtime, nowEpochMs, getAutomationFileSystem }) =>
    new InMemoryAutomationsObject({
      state,
      env,
      runtime,
      nowEpochMs,
      getAutomationFileSystem,
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
} satisfies Record<BackofficeObjectBindingName, InMemoryBackofficeObjectFactory<unknown>>;

export class InMemoryObjectFactory implements BackofficeObjectFactory {
  readonly env: InMemoryBackofficeRuntimeEnv;

  #namespaces: NamespaceMap = {};
  readonly #getRuntimeServices: () => BackofficeRuntimeServices;
  readonly #getAutomationFileSystem?: InMemoryObjectFactoryOptions["getAutomationFileSystem"];
  readonly #objectFactories?: InMemoryObjectFactoryOverrides;
  #timeOffsetMs = 0;
  #activeTimeEpochMs: number | null = null;

  constructor(options: InMemoryObjectFactoryOptions) {
    this.env = {
      ...defaultInMemoryBackofficeRuntimeEnv(),
      ...options.env,
    };
    this.#getRuntimeServices = options.getRuntimeServices;
    this.#getAutomationFileSystem = options.getAutomationFileSystem;
    this.#objectFactories = options.objectFactories;
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
      throw new Error(`In-memory Backoffice object binding ${address.binding} is not registered.`);
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

  instances(): InMemoryDurableObjectInstance[] {
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
    return this.#activeTimeEpochMs ?? Date.now() + this.#timeOffsetMs;
  }

  advanceTime(ms: number): number {
    this.#timeOffsetMs += ms;
    return this.now();
  }

  async drainAlarms(): Promise<void> {
    const now = this.now();
    const due = this.instances()
      .map((instance) => ({ ...instance, alarmTimestamp: instance.state.alarmTimestamp }))
      .filter(
        ({ state, alarmTimestamp }) =>
          alarmTimestamp !== null && alarmTimestamp <= now && state.consumeDueAlarm(now),
      );

    await this.#runAtCurrentTime(async () => {
      for (const { object, state } of due) {
        await state.drainBlocking();
        const alarm = (object as { alarm?: () => Promise<void> }).alarm;
        if (alarm) {
          await alarm.call(object);
        }
      }
    });
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
    for (const bindingName of Object.keys(
      inMemoryObjectFactories,
    ) as BackofficeObjectBindingName[]) {
      this.#register(
        { name: bindingName },
        inMemoryObjectFactories[bindingName] as InMemoryBackofficeObjectFactory<unknown>,
      );
    }
  }

  #register<TObject>(
    binding: BackofficeObjectBinding<TObject>,
    createObject: InMemoryBackofficeObjectFactory<TObject>,
  ) {
    const override = this.#objectFactories?.[binding.name] as
      | InMemoryBackofficeObjectFactory<TObject>
      | undefined;
    const factory = override ?? createObject;

    this.#namespaces[binding.name] = new InMemoryDurableObjectNamespace({
      name: binding.name,
      createObject: (input) => {
        const runtime = this.#getRuntimeServices();
        return factory({
          ...input,
          env: this.env,
          runtime: {
            ...runtime,
            adapters: runtime.adapters.forScope(
              createDurableObjectDatabaseAdapterScope(input.state as unknown as DurableObjectState),
            ),
          },
          nowEpochMs: () => this.now(),
          getAutomationFileSystem: this.#getAutomationFileSystem,
        });
      },
    }) as InMemoryDurableObjectNamespace<unknown>;
  }

  #namespace<TObject>(
    binding: BackofficeObjectBinding<TObject>,
  ): InMemoryDurableObjectNamespace<TObject> {
    const namespace = this.#namespaces[binding.name];
    if (!namespace) {
      throw new Error(`In-memory Backoffice object binding ${binding.name} is not registered.`);
    }

    return namespace as InMemoryDurableObjectNamespace<TObject>;
  }

  #hasNamespace(bindingName: BackofficeObjectBindingName) {
    return Boolean(this.#namespaces[bindingName]);
  }

  async #runAtCurrentTime<T>(callback: () => Promise<T>): Promise<T> {
    // Date.now is process-global, so logical-time drains from different runtimes cannot overlap.
    const releaseDateNowOverride = await acquireInMemoryDateNowOverride();
    const originalNow = Date.now;
    const activeTimeEpochMs = originalNow() + this.#timeOffsetMs;
    this.#activeTimeEpochMs = activeTimeEpochMs;
    Date.now = () => activeTimeEpochMs;
    try {
      return await callback();
    } finally {
      Date.now = originalNow;
      this.#activeTimeEpochMs = null;
      releaseDateNowOverride();
    }
  }
}
