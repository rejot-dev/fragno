import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
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
  createMasterFileSystem,
  createOrgFileSystem,
  createSystemFilesContext,
  staticFileContributor,
  type MasterFileSystem,
} from "@/files";
import { tmpFileContributor } from "@/files/contributors/tmp";
import type {
  AutomationEvent,
  AutomationFragmentConfig,
  AutomationIngestResult,
} from "@/fragno/automation";
import {
  buildNotConfiguredResponse,
  createAutomationsRuntime,
  type AutomationsRuntime,
} from "@/fragno/automation/automations";
import {
  createDurableHookRepository,
  createEmptyDurableHookRepository,
  type DurableHookQueueOptions,
  type DurableHookQueueResponse,
} from "@/fragno/durable-hooks";
import { createPiRouteRuntime } from "@/fragno/pi/pi";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";

export type AutomationsFileSystemResolver = (input: {
  execution: BackofficeExecutionContext;
  purpose?: string;
}) => Promise<MasterFileSystem>;

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
  if (execution.scope.kind === "org") {
    return createOrgFileSystem({
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
      uploadConfig: null,
    }),
    { contributors: [staticFileContributor, tmpFileContributor] },
  );
};

export class InMemoryAutomationsObject implements AutomationsObject {
  #env: AutomationFragmentConfig["env"] | undefined;
  #state: BackofficeObjectState;
  #runtimeServices: BackofficeRuntimeServices;
  #runtime: AutomationsRuntime | null = null;
  #host: FragmentDurableObjectHost<void, AutomationsRuntime>;
  #getAutomationFileSystem?: AutomationsFileSystemResolver;
  private readonly automationRoutePrefix = "/api/automations/bindings";

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
    this.#env = env as AutomationFragmentConfig["env"];
    this.#state = state;
    this.#runtimeServices = runtime;
    this.#getAutomationFileSystem = getAutomationFileSystem;
    this.#host = createFragmentDurableObjectHost({
      name: "Automations",
      state,
      env,
      createRuntime: () => {
        const runtime: AutomationsRuntime = createAutomationsRuntime(
          {
            adapters: this.#runtimeServices.adapters,
          },
          {
            env: this.#env,
            runtime: this.#runtimeServices,
            createPiAutomationContext: this.#createPiAutomationContext.bind(this),
            getAutomationFileSystem: async ({ execution, purpose }) => {
              if (this.#getAutomationFileSystem) {
                return await this.#getAutomationFileSystem({ execution, purpose });
              }

              return await this.#createAutomationFileSystem(execution);
            },
          },
        );
        return runtime;
      },
      getMigrationFragments: (runtime) => [runtime.workflowsFragment, runtime.automationFragment],
      hostRuntime: (runtime, { hostFragment }) => ({
        ...runtime,
        workflowsFragment: hostFragment(runtime.workflowsFragment),
        automationFragment: hostFragment(runtime.automationFragment),
      }),
      mounts: [
        {
          id: "automation",
          match: ({ pathname }) => pathname.startsWith(this.automationRoutePrefix),
          target: (runtime) => runtime.automationFragment,
        },
        { id: "workflows", target: (runtime) => runtime.workflowsFragment },
      ],
      onProcessError: (error) => {
        console.error("Automations durable hook processor error", error);
      },
      onDispatcherError: (error) => {
        console.warn("Automations durable hook processor disabled", error);
      },
    });

    void state.blockConcurrencyWhile(async () => {
      this.#runtime = await this.#host.initialize(undefined);
    });
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
    if (scope?.kind !== "org") {
      return undefined;
    }

    return {
      runtime: createPiRouteRuntime({
        object: this.#runtimeServices.objects.pi.forOrg(scope.orgId),
        orgId: scope.orgId,
      }),
    };
  }

  async triggerIngestEvent(event: AutomationEvent): Promise<AutomationIngestResult> {
    if (!this.#runtime?.automationFragment) {
      throw new Error("Automations runtime is not ready.");
    }

    const result = await this.#runtime.automationFragment.callServices(() =>
      this.#runtime!.automationFragment.services.ingestEvent(event),
    );

    return result;
  }

  async ingestEvent(event: AutomationEvent): Promise<AutomationIngestResult> {
    return await this.triggerIngestEvent(event);
  }

  async alarm() {
    await this.#host.alarm();
  }

  getDurableHookRepository(fragment?: "workflows" | "automation") {
    type Options = DurableHookQueueOptions & { fragment?: "workflows" | "automation" };
    if (!this.#runtime?.workflowsFragment || !this.#runtime?.automationFragment) {
      return createEmptyDurableHookRepository<Options>();
    }

    return createDurableHookRepository<Options>((options) =>
      (options?.fragment ?? fragment) === "workflows"
        ? this.#runtime!.workflowsFragment
        : this.#runtime!.automationFragment,
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.#runtime?.workflowsFragment || !this.#runtime?.automationFragment) {
      return buildNotConfiguredResponse();
    }

    return await this.#host.fetch(this.#runtime, request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
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
