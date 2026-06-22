import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { MasterFileSystem } from "@/files";

import { InMemoryApiObject } from "../../workers/api.do";
import { InMemoryAuthObject } from "../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../workers/automations.do";
import { InMemoryCloudflareWorkersObject } from "../../workers/cloudflare-wfp.do";
import { InMemoryGitHubWebhookRouterObject } from "../../workers/github-webhook-router.do";
import { InMemoryGitHubObject } from "../../workers/github.do";
import { InMemoryMcpObject } from "../../workers/mcp.do";
import { InMemoryOtpObject } from "../../workers/otp.do";
import { InMemoryPiObject } from "../../workers/pi.do";
import { InMemoryResendObject } from "../../workers/resend.do";
import { InMemoryReson8Object } from "../../workers/reson8.do";
import { InMemorySandboxRegistryObject } from "../../workers/sandbox-registry.do";
import { InMemoryTelegramObject } from "../../workers/telegram.do";
import { InMemoryUploadObject } from "../../workers/upload.do";
import type { BackofficeContextScope } from "./context";
import {
  InMemoryDurableObjectNamespace,
  type InMemoryDurableObjectFactory,
  type InMemoryDurableObjectInstance,
} from "./in-memory-durable-objects";
import type { InMemoryBackofficeRuntimeEnv } from "./in-memory-runtime-env";
import { defaultInMemoryBackofficeRuntimeEnv } from "./in-memory-runtime-env";
import type {
  BackofficeObjectAddress,
  BackofficeObjectBinding,
  BackofficeObjectBindingName,
  BackofficeObjectFactory,
} from "./object-registry";
import { assertBackofficeObjectAddressAllowed } from "./object-registry";
import { encodeBackofficeObjectAddress } from "./object-registry";
import type { BackofficeRuntimeConfig, BackofficeRuntimeServices } from "./runtime-services";

export type InMemoryBackofficeObjectFactory<TObject> = (input: {
  id: DurableObjectId;
  name: string;
  state: Parameters<InMemoryDurableObjectFactory<TObject>>[0]["state"];
  env: InMemoryBackofficeRuntimeEnv;
  runtime: BackofficeRuntimeServices;
  getAutomationFileSystem?: InMemoryObjectFactoryOptions["getAutomationFileSystem"];
  ownerScope?: BackofficeContextScope;
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

const ownerScopeFromAddress = (
  address: BackofficeObjectAddress,
): BackofficeContextScope | undefined => {
  if (address.scope.kind === "org") {
    return { kind: "org", orgId: address.scope.orgId };
  }
  if (address.scope.kind === "project") {
    return {
      kind: "project",
      orgId: address.scope.orgId,
      projectId: address.scope.projectId,
    };
  }
  return undefined;
};

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

  async getDurableHookRepository() {
    return {
      getHookQueue: async () => ({
        configured: false,
        hooksEnabled: false,
        namespace: null,
        items: [],
        cursor: undefined,
        hasNextPage: false,
      }),
      getHook: async () => null,
    };
  }

  async getAllOrganizations() {
    return [];
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

  async getInstances() {
    return [];
  }

  async getInstance() {
    return null;
  }

  async trackInstance() {}

  async untrackInstance() {}

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
    }),
  TELEGRAM: ({ state, runtime }) =>
    new InMemoryTelegramObject({
      state,
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
  CLOUDFLARE_WORKERS: ({ state, env, runtime }) =>
    new InMemoryCloudflareWorkersObject({
      state,
      env,
      runtime,
    }),
  SANDBOX: createUnavailableObject,
  SANDBOX_REGISTRY: ({ state, runtime }) =>
    new InMemorySandboxRegistryObject({
      state,
      runtime,
    }),
  GITHUB: ({ state, env, runtime }) =>
    new InMemoryGitHubObject({
      state,
      env: env as never,
      runtime,
    }),
  GITHUB_WEBHOOK_ROUTER: ({ state, env }) =>
    new InMemoryGitHubWebhookRouterObject({
      state,
      env: env as never,
    }),
  PI: ({ state, env, runtime }) =>
    new InMemoryPiObject({
      state,
      env: env as never,
      runtime,
    }),
  AUTOMATIONS: ({ state, env, runtime, getAutomationFileSystem, ownerScope }) =>
    new InMemoryAutomationsObject({
      state,
      env,
      runtime,
      getAutomationFileSystem,
      ownerScope,
    }),
} satisfies Record<BackofficeObjectBindingName, InMemoryBackofficeObjectFactory<unknown>>;

export class InMemoryObjectFactory implements BackofficeObjectFactory {
  readonly env: InMemoryBackofficeRuntimeEnv;

  #namespaces: NamespaceMap = {};
  #getRuntimeServices: () => BackofficeRuntimeServices;
  #getAutomationFileSystem?: InMemoryObjectFactoryOptions["getAutomationFileSystem"];
  #objectFactories?: InMemoryObjectFactoryOverrides;
  #ownerScopes = new Map<string, BackofficeContextScope | undefined>();
  #timeOffsetMs = 0;

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

  get<TObject>(
    binding: BackofficeObjectBinding<TObject>,
    address: BackofficeObjectAddress,
  ): TObject {
    if (address.binding !== binding.name) {
      throw new Error(
        `Backoffice object address binding ${address.binding} does not match requested binding ${binding.name}.`,
      );
    }
    assertBackofficeObjectAddressAllowed(address);
    const namespace = this.#namespace<TObject>(binding);
    const encodedName = encodeBackofficeObjectAddress(address);
    this.#ownerScopes.set(`${binding.name}:${encodedName}`, ownerScopeFromAddress(address));
    return namespace.get(namespace.idFromName(encodedName));
  }

  instances(): InMemoryDurableObjectInstance<unknown>[] {
    return Object.values(this.#namespaces).flatMap((namespace) => namespace.instances());
  }

  async drainWaitUntil(): Promise<void> {
    const results = await Promise.all(
      Object.values(this.#namespaces).map(async (namespace) => await namespace.drainWaitUntil()),
    );
    if (results.some(Boolean)) {
      await Promise.resolve();
    }
  }

  now(): number {
    return Date.now() + this.#timeOffsetMs;
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

    for (const { object, state } of due) {
      await state.drainBlocking();
      const alarm = (object as { alarm?: () => Promise<void> }).alarm;
      if (alarm) {
        const originalNow = Date.now;
        Date.now = () => now;
        try {
          await alarm.call(object);
        } finally {
          Date.now = originalNow;
        }
      }
    }
  }

  createRuntimeConfig(): BackofficeRuntimeConfig {
    return {
      ...(this.env.DOCS_PUBLIC_BASE_URL?.trim()
        ? { docsPublicBaseUrl: this.env.DOCS_PUBLIC_BASE_URL.trim() }
        : {}),
      bindings: {
        api: this.#hasNamespace("API"),
        auth: this.#hasNamespace("AUTH"),
        automations: this.#hasNamespace("AUTOMATIONS"),
        telegram: this.#hasNamespace("TELEGRAM"),
        otp: this.#hasNamespace("OTP"),
        pi: this.#hasNamespace("PI"),
        resend: this.#hasNamespace("RESEND"),
        reson8: this.#hasNamespace("RESON8"),
        mcp: this.#hasNamespace("MCP"),
        upload: this.#hasNamespace("UPLOAD"),
        github: this.#hasNamespace("GITHUB"),
        cloudflareWorkers: this.#hasNamespace("CLOUDFLARE_WORKERS"),
        githubWebhookRouter: this.#hasNamespace("GITHUB_WEBHOOK_ROUTER"),
        sandboxRegistry: this.#hasNamespace("SANDBOX_REGISTRY"),
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
      createObject: (input) =>
        factory({
          ...input,
          env: this.env,
          runtime: this.#getRuntimeServices(),
          getAutomationFileSystem: this.#getAutomationFileSystem,
          ownerScope: this.#ownerScopes.get(input.name),
        }),
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
}
