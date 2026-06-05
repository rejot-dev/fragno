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
import { createCodemodeAutomationWorkflowInstance } from "@/fragno/automation/codemode-workflow-facet";
import { CodemodeWorkflowToolDispatcher } from "@/fragno/automation/engine/codemode";
import {
  loadDurableHookQueue,
  type DurableHookQueueOptions,
  type DurableHookQueueResponse,
} from "@/fragno/durable-hooks";
import { createPiRouteRuntime } from "@/fragno/pi/pi";
import {
  PI_MODEL_CATALOG,
  createPiAgentName,
  resolvePiHarnesses,
  type PiConfigState,
} from "@/fragno/pi/pi-shared";

import { createFacetAlarmProxy, type FacetAlarmProxy } from "./lib/facet-alarm-proxy";

const FACET_ALARM_STORAGE_PREFIX = "__facet_alarm__:";
const AUTOMATION_WORKFLOW_ALARM_STATE_URL =
  "https://automation-workflow.local/__automation-workflow/alarm-state";
const AUTOMATION_WORKFLOW_ALARM_DELIVER_URL =
  "https://automation-workflow.local/__automation-workflow/alarm";

const resolveDefaultPiAgent = (configState: PiConfigState) => {
  if (!configState.configured || !configState.config) {
    return undefined;
  }

  const harness = resolvePiHarnesses(configState.config.harnesses)[0];
  const model = PI_MODEL_CATALOG.find((option) => {
    return Boolean(configState.config?.apiKeys?.[option.provider]);
  });

  if (!harness || !model) {
    return undefined;
  }

  return createPiAgentName({
    harnessId: harness.id,
    provider: model.provider,
    model: model.name,
  });
};

export class Automations extends DurableObject<CloudflareEnv> {
  #env: CloudflareEnv;
  #state: DurableObjectState;
  #runtime: AutomationsRuntime | null = null;
  #host: FragmentDurableObjectHost<void, AutomationsRuntime>;
  #facetAlarms: FacetAlarmProxy;
  private readonly automationRoutePrefix = "/api/automations/bindings";

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;
    this.#facetAlarms = createFacetAlarmProxy({
      state,
      storagePrefix: FACET_ALARM_STORAGE_PREFIX,
      alarmStateUrl: AUTOMATION_WORKFLOW_ALARM_STATE_URL,
      getFacet: (facetName) => this.#getCodemodeWorkflowFacet(facetName),
      deliverAlarm: ({ facet }) => this.#deliverCodemodeWorkflowFacetAlarm(facet),
      onDeliveryError: ({ error }) => {
        console.error("Automation workflow facet alarm delivery failed", error);
      },
    });
    this.#host = createFragmentDurableObjectHost({
      name: "Automations",
      state,
      env,
      createRuntime: () => {
        const runtime: AutomationsRuntime = createAutomationsRuntime(state, {
          env: this.#env,
          createPiAutomationContext: this.#createPiAutomationContext.bind(this),
          createCodemodeWorkflowInstance: async ({ event, binding, tools }) => {
            const orgId = event.orgId?.trim() || "";
            return await createCodemodeAutomationWorkflowInstance({
              orgId,
              binding,
              event,
              state: this.#state,
              env: this.#env,
              tools,
              toolDispatcher: new CodemodeWorkflowToolDispatcher({ env: this.#env }),
              syncFacetAlarm: ({ facetName, facet }) => this.#facetAlarms.sync(facetName, facet),
            });
          },
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
      automationHookQueue: (opts) =>
        this.getHookQueue({ ...opts, fragment: "automation" as const }),
    });
  }

  async #createPiAutomationContext(input: { event: AutomationEvent; idempotencyKey: string }) {
    const orgId = input.event.orgId?.trim();
    if (!orgId) {
      return undefined;
    }

    const piDo = this.#env.PI.get(this.#env.PI.idFromName(orgId));
    const configState = await piDo.getAdminConfig();
    const defaultAgent = resolveDefaultPiAgent(configState);
    if (!defaultAgent) {
      return undefined;
    }

    return {
      runtime: createPiRouteRuntime({ env: this.#env, orgId }),
      defaultAgent,
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
    await this.#facetAlarms.processDue();
  }

  #getCodemodeWorkflowFacet(facetName: string) {
    const worker = this.#env.LOADER.get(facetName, async () => {
      throw new Error(
        `Codemode automation workflow '${facetName}' is not loaded; cannot deliver proxied alarm.`,
      );
    });

    return this.#state.facets.get(facetName, () => ({
      class: worker.getDurableObjectClass("AutomationWorkflowFacet"),
      id: facetName,
    })) as Fetcher & { runAlarm?(dispatcher?: unknown): Promise<Response> };
  }

  async #deliverCodemodeWorkflowFacetAlarm(
    facet: Fetcher & { runAlarm?(dispatcher?: unknown): Promise<Response> },
  ) {
    let deliveredByRpc = false;
    try {
      await facet.runAlarm?.(new CodemodeWorkflowToolDispatcher({ env: this.#env }));
      deliveredByRpc = Boolean(facet.runAlarm);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes('does not implement the method "runAlarm"')
      ) {
        throw error;
      }
    }

    if (!deliveredByRpc) {
      await facet.fetch(
        new Request(AUTOMATION_WORKFLOW_ALARM_DELIVER_URL, {
          method: "POST",
        }),
      );
    }
  }

  async getHookQueue(
    options?: DurableHookQueueOptions & {
      fragment?: "workflows" | "automation";
    },
  ): Promise<DurableHookQueueResponse> {
    if (!this.#runtime?.workflowsFragment || !this.#runtime?.automationFragment) {
      return {
        configured: false,
        hooksEnabled: false,
        namespace: null,
        items: [],
        cursor: undefined,
        hasNextPage: false,
      };
    }

    const targetFragment =
      options?.fragment === "workflows"
        ? this.#runtime.workflowsFragment
        : this.#runtime.automationFragment;
    return loadDurableHookQueue(targetFragment, options);
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
