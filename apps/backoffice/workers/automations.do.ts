import { DurableObject, RpcTarget } from "cloudflare:workers";

import {
  backofficeContextScopesEqual,
  type BackofficeContextScope,
  type BackofficeExecutionContext,
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
import { backofficeScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import {
  createBackofficeFileSystem,
  createMasterFileSystem,
  createSystemFilesContext,
  emptyStaticFileArtifacts,
  staticFileContributor,
  systemFileContributor,
  type MasterFileSystem,
} from "@/files";
import { tmpFileContributor } from "@/files/contributors/tmp";
import type {
  AutomationEvent,
  AutomationEventDefinition,
  AutomationEventDefinitionCreateInput,
  AutomationEventDefinitionUpdateInput,
  AutomationFragmentConfig,
  AutomationIngestResult,
  AutomationProjectExecutionTarget,
  SandboxInstanceRecord,
  SandboxInstanceRequestInput,
  SandboxProvider,
  StarterAutomationRoutesSeedResult,
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
  type BackofficeOutboxItem,
} from "./lib/backoffice-fragment-durable-object";

export type AutomationsFileSystemResolver = (input: {
  execution: BackofficeExecutionContext;
  purpose?: string;
}) => Promise<MasterFileSystem>;

type AutomationDurableObjectConfig = {
  scope: BackofficeContextScope;
};

type AutomationsOutboxItem = BackofficeOutboxItem & {
  type: "automations.initialized";
};

const assertAutomationObjectScope = (
  expected: BackofficeContextScope,
  actual: BackofficeContextScope,
) => {
  if (!backofficeContextScopesEqual(expected, actual)) {
    throw new Error("Backoffice object method scope does not match object address scope.");
  }
};

export const createDefaultAutomationFileSystem = async ({
  objects,
  kernel,
  execution,
  automationHookQueue,
  config,
}: {
  objects: BackofficeObjectRegistry;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  automationHookQueue?: (opts?: DurableHookQueueOptions) => Promise<DurableHookQueueResponse>;
  config: BackofficeRuntimeServices["config"];
}): Promise<MasterFileSystem> => {
  if (execution.scope.kind === "org" || execution.scope.kind === "project") {
    return createBackofficeFileSystem({
      objects,
      kernel,
      execution,
      ...(automationHookQueue ? { automationHookQueue } : {}),
      config,
    });
  }

  return createMasterFileSystem(
    createSystemFilesContext({
      objects,
      execution,
      staticFileArtifacts: emptyStaticFileArtifacts,
    }),
    { contributors: [staticFileContributor, systemFileContributor, tmpFileContributor] },
  );
};

export class InMemoryAutomationsObject extends RpcTarget implements AutomationsObject {
  #env: AutomationFragmentConfig["env"] | undefined;
  #state: BackofficeObjectState;
  #runtimeServices: BackofficeRuntimeServices;
  #host: BackofficeFragmentDurableObject<
    AutomationDurableObjectConfig,
    AutomationDurableObjectConfig,
    AutomationsRuntime,
    AutomationsOutboxItem
  >;
  #getAutomationFileSystem?: AutomationsFileSystemResolver;
  #scope: BackofficeContextScope | null = null;
  private readonly automationRoutePrefix = "/api/automations";

  constructor({
    state,
    env,
    runtime,
    getAutomationFileSystem,
  }: {
    state: BackofficeObjectState;
    env?: unknown;
    runtime: BackofficeRuntimeServices;
    getAutomationFileSystem?: AutomationsFileSystemResolver;
  }) {
    super();
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
                        return getSandbox(namespace, id, options);
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
      outbox: {
        dispatch: async (item) => {
          if (item.type !== "automations.initialized") {
            return;
          }

          const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
          await runtime.automationFragment.callServices(() =>
            runtime.automationFragment.services.seedStarterAutomationRoutes(),
          );
        },
      },
    });

    void state.blockConcurrencyWhile(async () => {
      const stored = await this.#host.loadStored();
      await this.#host.initializeFromStored(stored);
      if (stored) {
        await this.#dispatchInitialized(stored.scope);
      }
    });
  }

  init(scope: BackofficeContextScope): AutomationsObject {
    if (this.#scope) {
      assertAutomationObjectScope(this.#scope, scope);
      return this;
    }

    this.#scope = scope;
    return this;
  }

  #requireScope(): BackofficeContextScope {
    if (!this.#scope) {
      throw new Error("Automations object has not been initialized with scope metadata.");
    }

    return this.#scope;
  }

  async #dispatchInitialized(scope: BackofficeContextScope) {
    await this.#host.dispatch({
      id: `automations.initialized:${
        scope.kind === "system" ? "system" : backofficeScopeSinglePathSegment(scope)
      }`,
      type: "automations.initialized",
      createdAt: new Date().toISOString(),
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
      await this.#dispatchInitialized(config.scope);
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

    if (scopeKind === "system") {
      await this.#ensureConfigured({ scope: { kind: "system" } });
      return;
    }

    if (!orgId) {
      return;
    }

    await this.#ensureConfigured({ scope: { kind: "org", orgId } });
  }

  async #createAutomationFileSystem(execution: BackofficeExecutionContext) {
    const kernel = new BackofficeKernel({ objects: this.#runtimeServices.objects });
    const automationHookObject = kernel.scoped(
      "AUTOMATIONS",
      execution.scope,
      this.#runtimeServices.objects.automations,
    );

    return createDefaultAutomationFileSystem({
      objects: this.#runtimeServices.objects,
      kernel,
      execution,
      config: this.#runtimeServices.config,
      automationHookQueue: async (opts) =>
        await (
          await automationHookObject.getDurableHookRepository("automation")
        ).getHookQueue(opts),
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

  async seedStarterAutomationRoutes(): Promise<StarterAutomationRoutesSeedResult> {
    const scope = this.#requireScope();
    await this.#ensureConfigured({ scope });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.seedStarterAutomationRoutes(),
    );
  }

  async triggerIngestEvent(event: AutomationEvent): Promise<AutomationIngestResult> {
    const scope = this.#requireScope();
    assertAutomationObjectScope(scope, event.scope);
    await this.#ensureConfigured({ scope });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.ingestEvent(event),
    );
  }

  async ingestEvent(event: AutomationEvent): Promise<AutomationIngestResult> {
    return await this.triggerIngestEvent(event);
  }

  async listEventDefinitions(): Promise<AutomationEventDefinition[]> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.listEventDefinitions(),
    );
  }

  async getEventDefinition(input: {
    source: string;
    eventType: string;
  }): Promise<AutomationEventDefinition | null> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getEventDefinition(input),
    );
  }

  async createEventDefinition(
    input: AutomationEventDefinitionCreateInput,
  ): Promise<AutomationEventDefinition> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.createEventDefinition(input),
    );
  }

  async updateEventDefinition(
    input: AutomationEventDefinitionUpdateInput,
  ): Promise<AutomationEventDefinition | null> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.updateEventDefinition(input),
    );
  }

  async resolveProjectForExecution(input: {
    projectId?: string;
    slug?: string;
  }): Promise<AutomationProjectExecutionTarget | null> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.resolveProjectForExecution(input),
    );
  }

  async listSandboxInstances(input?: {
    provider?: SandboxProvider;
    limit?: number;
  }): Promise<SandboxInstanceRecord[]> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.listSandboxInstances(input),
    );
  }

  async getSandboxInstance(input: { id: string }): Promise<SandboxInstanceRecord | null> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getSandboxInstance(input),
    );
  }

  async requestSandboxInstance(input: SandboxInstanceRequestInput): Promise<SandboxInstanceRecord> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
    const { runtime } = this.#host.requireConfigured("Automations runtime is not ready.");
    const existing = await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.getSandboxInstance({ id: input.id }),
    );
    if (
      existing &&
      (existing.status === "requested" ||
        existing.status === "starting" ||
        existing.status === "running" ||
        existing.status === "stopping")
    ) {
      return existing;
    }

    return await runtime.automationFragment.callServices(() =>
      runtime.automationFragment.services.requestSandboxInstance(input),
    );
  }

  async requestSandboxInstanceStop(input: { id: string }): Promise<SandboxInstanceRecord | null> {
    await this.#ensureConfigured({ scope: this.#requireScope() });
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

export class Automations extends DurableObject<CloudflareEnv> {
  #object: InMemoryAutomationsObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryAutomationsObject({
      state,
      env,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
    });
  }

  init(scope: BackofficeContextScope): AutomationsObject {
    return this.#object.init(scope);
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
