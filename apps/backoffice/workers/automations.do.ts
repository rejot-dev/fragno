import { DurableObject } from "cloudflare:workers";

import type {
  BackofficeContextScope,
  BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type {
  AutomationsObject,
  BackofficeObjectRegistry,
} from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import {
  createBackofficeFileSystem,
  createMasterFileSystem,
  createSystemFilesContext,
  staticFileContributor,
  type MasterFileSystem,
} from "@/files";
import { tmpFileContributor } from "@/files/contributors/tmp";
import type {
  AutomationEvent,
  AutomationFragmentConfig,
  AutomationIngestResult,
  AutomationProjectExecutionTarget,
  SandboxInstanceRecord,
  SandboxInstanceRequestInput,
  SandboxProvider,
} from "@/fragno/automation";
import { createAutomationsRuntime, type AutomationsRuntime } from "@/fragno/automation/automations";
import type { DurableHookQueueOptions, DurableHookQueueResponse } from "@/fragno/durable-hooks";
import { createPiRouteRuntime } from "@/fragno/pi/pi";
import { createCloudflareSandboxProvider } from "@/sandbox/cloudflare-sandbox-provider";
import { CLOUDFLARE_SANDBOX_PROVIDER } from "@/sandbox/contracts";

import {
  createBackofficeFragmentDurableObject,
  type BackofficeFragmentDurableObject,
  type BackofficeObjectState,
} from "./lib/backoffice-fragment-durable-object";

export type AutomationsFileSystemResolver = (input: {
  execution: BackofficeExecutionContext;
  purpose?: string;
}) => Promise<MasterFileSystem>;

type AutomationDurableObjectOwnerScope = Extract<
  BackofficeContextScope,
  { kind: "org" | "project" | "user" }
>;

type AutomationDurableObjectConfig = {
  scope: AutomationDurableObjectOwnerScope;
};

const automationConfigForScope = (
  scope: BackofficeContextScope | undefined,
): AutomationDurableObjectConfig | null => {
  if (scope?.kind === "org" || scope?.kind === "project" || scope?.kind === "user") {
    return { scope };
  }

  return null;
};

const automationConfigForOrgId = (orgId: string): AutomationDurableObjectConfig => ({
  scope: { kind: "org", orgId },
});

const ACTIVE_SANDBOX_INSTANCE_STATUSES = new Set<SandboxInstanceRecord["status"]>([
  "requested",
  "starting",
  "running",
  "stopping",
]);

const isActiveSandboxInstance = (
  instance: SandboxInstanceRecord | null | undefined,
): instance is SandboxInstanceRecord =>
  Boolean(instance && ACTIVE_SANDBOX_INSTANCE_STATUSES.has(instance.status));

const automationCatalogOrgIdForScope = (scope: BackofficeContextScope): string => {
  switch (scope.kind) {
    case "system":
      return "automation-catalog-system";
    case "org":
      return scope.orgId;
    case "user":
      return `automation-catalog-user-${scope.userId}`;
    case "project":
      return `automation-catalog-project-${scope.projectId}`;
  }
};

export const createDefaultAutomationFileSystem = async ({
  objects,
  kernel,
  execution,
  automationHookQueue,
}: {
  objects: BackofficeObjectRegistry;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  automationHookQueue?: (opts?: DurableHookQueueOptions) => Promise<DurableHookQueueResponse>;
}): Promise<MasterFileSystem> => {
  if (execution.scope.kind === "org" || execution.scope.kind === "project") {
    return createBackofficeFileSystem({
      objects,
      kernel,
      execution,
      ...(automationHookQueue ? { automationHookQueue } : {}),
    });
  }

  return createMasterFileSystem(
    createSystemFilesContext({
      orgId: automationCatalogOrgIdForScope(execution.scope),
      objects,
    }),
    { contributors: [staticFileContributor, tmpFileContributor] },
  );
};

export class InMemoryAutomationsObject implements AutomationsObject {
  #env: AutomationFragmentConfig["env"] | undefined;
  #state: BackofficeObjectState;
  #runtimeServices: BackofficeRuntimeServices;
  #host: BackofficeFragmentDurableObject<
    AutomationDurableObjectConfig,
    AutomationDurableObjectConfig,
    AutomationsRuntime
  >;
  #getAutomationFileSystem?: AutomationsFileSystemResolver;
  private readonly automationRoutePrefix = "/api/automations";

  constructor({
    state,
    env,
    runtime,
    getAutomationFileSystem,
    ownerScope,
  }: {
    state: BackofficeObjectState;
    env?: unknown;
    runtime: BackofficeRuntimeServices;
    getAutomationFileSystem?: AutomationsFileSystemResolver;
    ownerScope?: BackofficeContextScope;
  }) {
    this.#env = env as AutomationFragmentConfig["env"];
    this.#state = state;
    this.#runtimeServices = runtime;
    this.#getAutomationFileSystem = getAutomationFileSystem;
    this.#host = createBackofficeFragmentDurableObject({
      name: "Automations",
      state,
      env,
      isConfigured: (stored): stored is AutomationDurableObjectConfig => Boolean(stored?.scope),
      createRuntime: (config) =>
        createAutomationsRuntime(
          {
            adapters: this.#runtimeServices.adapters,
          },
          {
            env: this.#env,
            runtime: this.#runtimeServices,
            ownerScope: config.scope,
            sandboxProviders: this.#env?.SANDBOX
              ? {
                  [CLOUDFLARE_SANDBOX_PROVIDER]: createCloudflareSandboxProvider({
                    sandboxNamespace: this.#env.SANDBOX,
                    sdk: {
                      async getSandbox(namespace, id, options) {
                        const { getSandbox } = await import("@cloudflare/sandbox");
                        return getSandbox(namespace, id, options) as never;
                      },
                    },
                  }),
                }
              : undefined,
            createPiAutomationContext: this.#createPiAutomationContext.bind(this),
            getAutomationFileSystem: async ({ execution, purpose }) => {
              if (this.#getAutomationFileSystem) {
                return await this.#getAutomationFileSystem({ execution, purpose });
              }

              return await this.#createAutomationFileSystem(execution);
            },
          },
        ),
      getMigrationFragments: (runtime) => [runtime.workflowsFragment, runtime.automationFragment],
      hostRuntime: (runtime, { hostFragment }) => ({
        ...runtime,
        workflowsFragment: hostFragment(runtime.workflowsFragment),
        automationFragment: hostFragment(runtime.automationFragment),
      }),
      mounts: [
        {
          id: "automation",
          match: ({ pathname }) =>
            pathname === this.automationRoutePrefix ||
            pathname.startsWith(`${this.automationRoutePrefix}/`),
          target: (runtime) => runtime.automationFragment,
        },
        { id: "workflows", target: (runtime) => runtime.workflowsFragment },
      ],
    });

    void state.blockConcurrencyWhile(async () => {
      const stored = await this.#host.loadStored();
      const initialConfig = stored ?? automationConfigForScope(ownerScope);
      if (initialConfig) {
        await this.#host.storeAndInitialize(initialConfig);
        return;
      }

      await this.#host.initializeFromStored(null);
    });
  }

  async #ensureConfigured(config: AutomationDurableObjectConfig | null): Promise<void> {
    if (!config) {
      return;
    }

    const configured = this.#host.getConfigured();
    if (configured) {
      this.#host.assertSameScope(configured.stored, config.scope);
      if (JSON.stringify(configured.stored.scope) === JSON.stringify(config.scope)) {
        return;
      }
    }

    await this.#state.blockConcurrencyWhile(async () => {
      const latest = this.#host.getConfigured();
      if (latest) {
        this.#host.assertSameScope(latest.stored, config.scope);
        if (JSON.stringify(latest.stored.scope) === JSON.stringify(config.scope)) {
          return;
        }
      }
      await this.#host.storeAndInitialize(config);
    });
  }

  async #ensureConfiguredForRequest(request: Request): Promise<void> {
    if (this.#host.getConfigured()) {
      return;
    }

    const url = new URL(request.url);
    const scopeKind = url.searchParams.get("scopeKind")?.trim();
    const orgId = url.searchParams.get("orgId")?.trim();
    const projectId = url.searchParams.get("projectId")?.trim();
    const userId = url.searchParams.get("userId")?.trim();

    if (scopeKind === "project" && orgId && projectId) {
      await this.#ensureConfigured({ scope: { kind: "project", orgId, projectId } });
      return;
    }

    if (scopeKind === "user" && userId) {
      await this.#ensureConfigured({ scope: { kind: "user", userId } });
      return;
    }

    if (!orgId) {
      return;
    }

    await this.#ensureConfigured(automationConfigForOrgId(orgId));
  }

  async #createAutomationFileSystem(execution: BackofficeExecutionContext) {
    return createDefaultAutomationFileSystem({
      objects: this.#runtimeServices.objects,
      kernel: new BackofficeKernel({ objects: this.#runtimeServices.objects }),
      execution,
      automationHookQueue: (opts) => this.getDurableHookRepository("automation").getHookQueue(opts),
    });
  }

  async #createPiAutomationContext(input: { event: AutomationEvent; idempotencyKey: string }) {
    const scope = input.event.scope;
    if (scope?.kind !== "org" && scope?.kind !== "project") {
      return undefined;
    }

    return {
      runtime: createPiRouteRuntime({
        object: this.#runtimeServices.objects.pi.forOrg(scope.orgId),
        orgId: scope.orgId,
      }),
    };
  }

  async #ensureConfiguredFromStored(): Promise<void> {
    if (this.#host.getConfigured()) {
      return;
    }

    await this.#state.blockConcurrencyWhile(async () => {
      if (this.#host.getConfigured()) {
        return;
      }

      await this.#host.initializeFromStored(await this.#host.loadStored());
    });
  }

  async triggerIngestEvent(event: AutomationEvent): Promise<AutomationIngestResult> {
    await this.#ensureConfigured(automationConfigForScope(event.scope));
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.ingestEvent(event),
    );
  }

  async ingestEvent(event: AutomationEvent): Promise<AutomationIngestResult> {
    return await this.triggerIngestEvent(event);
  }

  async resolveProjectForExecution(input: {
    projectId?: string;
    slug?: string;
  }): Promise<AutomationProjectExecutionTarget | null> {
    await this.#ensureConfiguredFromStored();
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.resolveProjectForExecution(input),
    );
  }

  async listSandboxInstances(input?: {
    provider?: SandboxProvider;
    limit?: number;
  }): Promise<SandboxInstanceRecord[]> {
    await this.#ensureConfiguredFromStored();
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.listSandboxInstances(input),
    );
  }

  async getSandboxInstance(input: { id: string }): Promise<SandboxInstanceRecord | null> {
    await this.#ensureConfiguredFromStored();
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getSandboxInstance(input),
    );
  }

  async requestSandboxInstance(
    input: SandboxInstanceRequestInput & { ownerScope?: BackofficeContextScope },
  ): Promise<SandboxInstanceRecord> {
    await this.#ensureConfigured(automationConfigForScope(input.ownerScope));
    await this.#ensureConfiguredFromStored();
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    const existing = await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getSandboxInstance({ id: input.id }),
    );
    if (isActiveSandboxInstance(existing)) {
      return existing;
    }

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.requestSandboxInstance(input),
    );
  }

  async requestSandboxInstanceStop(input: {
    id: string;
    ownerScope?: BackofficeContextScope;
  }): Promise<SandboxInstanceRecord | null> {
    await this.#ensureConfigured(automationConfigForScope(input.ownerScope));
    await this.#ensureConfiguredFromStored();
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    const instance = await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getSandboxInstance({ id: input.id }),
    );
    const workflowInstanceId = instance?.workflowInstanceId;
    if (!workflowInstanceId) {
      return instance;
    }

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.requestSandboxInstanceStop({
        id: input.id,
        workflowInstanceId,
      }),
    );
  }

  async alarm() {
    await this.#host.alarm();
  }

  getDurableHookRepository(fragment?: "workflows" | "automation") {
    type Options = DurableHookQueueOptions & { fragment?: "workflows" | "automation" };
    return this.#host.getDurableHookRepository<Options>((state, options) =>
      (options?.fragment ?? fragment) === "workflows"
        ? state.runtime.workflowsFragment
        : state.runtime.automationFragment,
    );
  }

  async fetch(request: Request): Promise<Response> {
    await this.#ensureConfiguredForRequest(request);
    return await this.#host.fetch(request);
  }
}

export class Automations extends DurableObject<CloudflareEnv> implements AutomationsObject {
  #object: InMemoryAutomationsObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryAutomationsObject({
      state,
      env,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
    });
  }

  async triggerIngestEvent(event: AutomationEvent): Promise<AutomationIngestResult> {
    return await this.#object.triggerIngestEvent(event);
  }

  async ingestEvent(event: AutomationEvent): Promise<AutomationIngestResult> {
    return await this.#object.ingestEvent(event);
  }

  async resolveProjectForExecution(input: {
    projectId?: string;
    slug?: string;
  }): Promise<AutomationProjectExecutionTarget | null> {
    return await this.#object.resolveProjectForExecution(input);
  }

  async listSandboxInstances(input?: {
    provider?: SandboxProvider;
    limit?: number;
  }): Promise<SandboxInstanceRecord[]> {
    return await this.#object.listSandboxInstances(input);
  }

  async getSandboxInstance(input: { id: string }): Promise<SandboxInstanceRecord | null> {
    return await this.#object.getSandboxInstance(input);
  }

  async requestSandboxInstance(
    input: SandboxInstanceRequestInput & { ownerScope?: BackofficeContextScope },
  ): Promise<SandboxInstanceRecord> {
    return await this.#object.requestSandboxInstance(input);
  }

  async requestSandboxInstanceStop(input: {
    id: string;
    ownerScope?: BackofficeContextScope;
  }): Promise<SandboxInstanceRecord | null> {
    return await this.#object.requestSandboxInstanceStop(input);
  }

  async alarm() {
    await this.#object.alarm();
  }

  getDurableHookRepository(fragment?: "workflows" | "automation") {
    return this.#object.getDurableHookRepository(fragment);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
