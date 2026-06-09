import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject } from "cloudflare:workers";

import { createOrgFileSystem } from "@/files";
import type { AutomationEvent, AutomationIngestResult } from "@/fragno/automation";
import {
  buildNotConfiguredResponse,
  createAutomationsRuntime,
  type AutomationsRuntime,
} from "@/fragno/automation/automations";
import {
  createDurableHookRepository,
  createEmptyDurableHookRepository,
  type DurableHookQueueOptions,
} from "@/fragno/durable-hooks";
import { createPiRouteRuntime } from "@/fragno/pi/pi";

export class Automations extends DurableObject<CloudflareEnv> {
  #env: CloudflareEnv;
  #state: DurableObjectState;
  #runtime: AutomationsRuntime | null = null;
  #host: FragmentDurableObjectHost<void, AutomationsRuntime>;
  private readonly automationRoutePrefix = "/api/automations/bindings";

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;
    this.#host = createFragmentDurableObjectHost({
      name: "Automations",
      state,
      env,
      createRuntime: () => {
        const runtime: AutomationsRuntime = createAutomationsRuntime(state, {
          env: this.#env,
          createPiAutomationContext: this.#createPiAutomationContext.bind(this),
          getAutomationFileSystem: ({ orgId }) => this.#createAutomationFileSystem(orgId),
        });
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

  async #createAutomationFileSystem(orgId?: string) {
    const normalizedOrgId = orgId?.trim();
    if (!normalizedOrgId) {
      throw new Error("Automation file system requires an organisation id");
    }

    return createOrgFileSystem({
      orgId: normalizedOrgId,
      env: this.#env,
      automationHookQueue: (opts) => this.getDurableHookRepository("automation").getHookQueue(opts),
    });
  }

  async #createPiAutomationContext(input: { event: AutomationEvent; idempotencyKey: string }) {
    const orgId = input.event.orgId?.trim();
    if (!orgId) {
      return undefined;
    }

    return {
      runtime: createPiRouteRuntime({ env: this.#env, orgId }),
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
