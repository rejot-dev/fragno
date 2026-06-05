import fragnoWorkflowRuntimeBundle from "@fragno-dev/workflows/dynamic-runtime?raw";

import type { AnyBackofficeRuntimeTool } from "@/fragno/runtime-tools/runtime-tools";

import type { AutomationEvent } from "./contracts";
import type { CodemodeWorkflowToolDispatcher } from "./engine/codemode";

export type CodemodeAutomationWorkflowBinding = {
  id?: string;
  scriptId: string;
  scriptVersion?: number;
  scriptBody: string;
};

export type CodemodeAutomationWorkflowInput = {
  orgId: string;
  binding: CodemodeAutomationWorkflowBinding;
  event: AutomationEvent;
  state: DurableObjectState;
  env: Pick<CloudflareEnv, "LOADER">;
  tools: readonly AnyBackofficeRuntimeTool[];
  toolDispatcher?: CodemodeWorkflowToolDispatcher;
  syncFacetAlarm?: (input: { facetName: string; facet: Fetcher }) => Promise<void>;
};

export type CodemodeWorkflowInstanceCreator = (input: {
  event: AutomationEvent;
  binding: CodemodeAutomationWorkflowBinding;
  tools: readonly AnyBackofficeRuntimeTool[];
  toolDispatcher?: CodemodeWorkflowToolDispatcher;
}) => Promise<Response>;

const WORKFLOW_FACET_COMPATIBILITY_DATE = "2026-05-07";

const renderUserWorkflowModule = (
  scriptBody: string,
  orgId: string,
  binding: CodemodeAutomationWorkflowBinding,
  event: AutomationEvent,
  toolGlobals: string,
) => `
import { defineWorkflow as defineFragnoWorkflow } from "./fragno-workflow-runtime.js";

const automationWorkflowOrgId = ${JSON.stringify(orgId)};
const automationWorkflowBinding = ${JSON.stringify({
  ...(binding.id ? { id: binding.id } : {}),
  scriptId: binding.scriptId,
  ...(typeof binding.scriptVersion === "number" ? { scriptVersion: binding.scriptVersion } : {}),
  source: event.source,
  eventType: event.eventType,
})};
let automationWorkflowToolDispatcher = null;
let automationWorkflowPayload = null;

const defineWorkflow = (config, handler) => defineFragnoWorkflow(config, async (input, step) => {
  automationWorkflowPayload = input?.payload ?? null;
  try {
    return await handler(input, step);
  } finally {
    automationWorkflowPayload = null;
  }
});

export const setAutomationWorkflowToolDispatcher = (dispatcher) => {
  automationWorkflowToolDispatcher = dispatcher ?? null;
};

const callTool = async (namespace, name, input) => {
  if (!automationWorkflowToolDispatcher) {
    throw new Error("Codemode workflow tool dispatcher is not available.");
  }

  if (!automationWorkflowPayload?.event) {
    throw new Error("Codemode workflow event payload is not available.");
  }

  const responseJson = await automationWorkflowToolDispatcher.call(namespace, name, JSON.stringify({
    orgId: automationWorkflowOrgId,
    binding: automationWorkflowBinding,
    event: automationWorkflowPayload.event,
    input: input ?? null,
  }));
  const response = JSON.parse(responseJson);
  if (response.error) {
    throw new Error(response.error);
  }

  return response.result;
};

${toolGlobals}

export const workflow = (${scriptBody.trim().replace(/;*$/, "")});
`;

const renderFacetModule = () => `
import { DurableObject } from "cloudflare:workers";
import {
  CloudflareDurableObjectsDriverConfig,
  createFragmentDurableObjectHost,
  createWorkflowsFragment,
  defaultFragnoRuntime,
  DurableObjectDialect,
  SqlAdapter,
} from "./fragno-workflow-runtime.js";
import { setAutomationWorkflowToolDispatcher, workflow } from "./user-workflow.js";

const proxiedAlarmStorageKey = "__automation_workflow_proxied_alarm_time";

const toAlarmTime = (value) => value instanceof Date ? value.getTime() : value;

const installFacetAlarmProxy = (state) => {
  const storage = state.storage;
  storage.getAlarm = async () => await storage.get(proxiedAlarmStorageKey) ?? null;
  storage.setAlarm = async (scheduledTime) => {
    await storage.put(proxiedAlarmStorageKey, toAlarmTime(scheduledTime));
    return undefined;
  };

  storage.deleteAlarm = async () => {
    await storage.delete(proxiedAlarmStorageKey);
    return undefined;
  };
};

const createAdapter = (state) => new SqlAdapter({
  dialect: new DurableObjectDialect({ ctx: state }),
  driverConfig: new CloudflareDurableObjectsDriverConfig(),
});

export class AutomationWorkflowFacet extends DurableObject {
  #host;
  #runtime = null;

  constructor(state, env) {
    super(state, env);
    installFacetAlarmProxy(state);

    this.#host = createFragmentDurableObjectHost({
      name: "AutomationWorkflowFacet",
      state,
      env,
      createRuntime: () => createWorkflowsFragment(
        {
          workflows: { [workflow.name]: workflow },
          runtime: defaultFragnoRuntime,
        },
        {
          databaseAdapter: createAdapter(state),
          mountRoute: "/api/workflows",
        },
      ),
      onProcessError: (error) => console.error("Automation workflow facet hook processor error", error),
      onDispatcherError: (error) => console.warn("Automation workflow facet hook processor disabled", error),
    });

    state.blockConcurrencyWhile(async () => {
      this.#runtime = await this.#host.initialize(undefined);
    });
  }

  async runWithToolDispatcher(dispatcher, callback) {
    setAutomationWorkflowToolDispatcher(dispatcher);
    try {
      return await callback();
    } finally {
      setAutomationWorkflowToolDispatcher(null);
    }
  }

  getWorkflowName() {
    return workflow.name;
  }

  async createInstance(input, dispatcher) {
    return await this.runWithToolDispatcher(dispatcher, async () => {
      return await this.fetch(new Request(input.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input.body),
      }));
    });
  }

  async runAlarm(dispatcher) {
    return await this.runWithToolDispatcher(dispatcher, async () => {
      await this.ctx.storage.deleteAlarm();
      await this.alarm();
      return Response.json({ ok: true });
    });
  }

  async fetch(request) {
    if (!this.#runtime) {
      return Response.json({ message: "Automation workflow facet is not ready.", code: "NOT_CONFIGURED" }, { status: 400 });
    }

    const url = new URL(request.url);
    if (url.pathname === "/__automation-workflow/alarm-state") {
      return Response.json({ alarmTime: await this.ctx.storage.getAlarm() });
    }

    if (request.method === "POST" && url.pathname === "/__automation-workflow/alarm") {
      await this.ctx.storage.deleteAlarm();
      await this.alarm();
      return Response.json({ ok: true });
    }

    return await this.#host.fetch(this.#runtime, request, {
      waitUntil: this.ctx.waitUntil.bind(this.ctx),
    });
  }

  async alarm() {
    await this.#host.alarm();
  }
}
`;

export const codemodeAutomationWorkflowLoaderId = (binding: CodemodeAutomationWorkflowBinding) =>
  `automation-workflow:${binding.scriptId}:${binding.scriptVersion ?? 0}`;

const toWorkflowIdentifierSegment = (value: string) => {
  const normalized = value.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/-+/g, "-");
  return /^[a-zA-Z0-9_]/.test(normalized) ? normalized : `id-${normalized}`;
};

export const codemodeAutomationWorkflowInstanceIdFor = (input: CodemodeAutomationWorkflowInput) =>
  [
    input.event.id,
    input.binding.id ?? input.binding.scriptId,
    String(input.binding.scriptVersion ?? 0),
  ]
    .map(toWorkflowIdentifierSegment)
    .join("-")
    .slice(0, 128);

export const createCodemodeAutomationWorkflowInstance = async (
  input: CodemodeAutomationWorkflowInput,
): Promise<Response> => {
  const { createWorker } = await import("@cloudflare/worker-bundler");
  const { renderCodemodeWorkflowToolGlobals } = await import("./engine/codemode");
  const loaderId = codemodeAutomationWorkflowLoaderId(input.binding);

  const worker = input.env.LOADER.get(loaderId, async () => {
    const bundled = await createWorker({
      entryPoint: "src/facet.ts",
      files: {
        "src/facet.ts": renderFacetModule(),
        "src/user-workflow.js": renderUserWorkflowModule(
          input.binding.scriptBody,
          input.orgId,
          input.binding,
          input.event,
          renderCodemodeWorkflowToolGlobals(input.tools),
        ),
        "src/fragno-workflow-runtime.js": fragnoWorkflowRuntimeBundle,
        "wrangler.jsonc": JSON.stringify({
          compatibility_date: WORKFLOW_FACET_COMPATIBILITY_DATE,
          compatibility_flags: ["nodejs_compat"],
        }),
      },
      conditions: ["workerd", "worker", "import", "default"],
      externals: ["cloudflare:workers"],
    });

    return {
      mainModule: bundled.mainModule,
      modules: bundled.modules,
      compatibilityDate: WORKFLOW_FACET_COMPATIBILITY_DATE,
      compatibilityFlags: ["nodejs_compat"],
    };
  });

  const facet = input.state.facets.get(loaderId, () => ({
    class: worker.getDurableObjectClass("AutomationWorkflowFacet"),
    id: loaderId,
  })) as Fetcher & {
    getWorkflowName(): Promise<string>;
    createInstance(
      input: { url: string; body: unknown },
      dispatcher?: CodemodeWorkflowToolDispatcher,
    ): Promise<Response>;
  };

  const workflowName = await facet.getWorkflowName();
  const instanceId = codemodeAutomationWorkflowInstanceIdFor(input);
  const response = await facet.createInstance(
    {
      url: `https://automation-workflow.local/api/workflows/${workflowName}/instances`,
      body: {
        id: instanceId,
        params: { event: input.event },
      },
    },
    input.toolDispatcher,
  );

  if (response.ok) {
    await input.syncFacetAlarm?.({ facetName: loaderId, facet });
  }

  return response;
};
