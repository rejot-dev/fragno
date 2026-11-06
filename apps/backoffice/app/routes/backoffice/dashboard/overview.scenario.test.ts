import { afterAll, assert, beforeAll, describe, test, vi } from "vitest";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/remote/codemode-node-executor";
import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";
import {
  pageDataPath,
  pageValuePath,
  type PageDefinition,
} from "@fragno-private/backoffice-ui/pages/definition";
import { pageRows, pageValue, type PageData } from "@fragno-private/backoffice-ui/pages/rows";
import { BackofficeUiStoreRenderer } from "@fragno-private/backoffice-ui/renderer";
import { layoutUniverse } from "@fragno-private/design-system/orchestration/orchestration-universe-model";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { createStateStore } from "@json-render/react";

import { loadPage } from "@/artifacts/pages/build.server";
import { checkPageSource } from "@/artifacts/pages/page-source.test-support";
import {
  createBackofficeSystemExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { GENERAL_SKILL_CONTENT } from "@/files/content/skills";
import { CODEMODE_WORKFLOW } from "@/fragno/automation/engine/codemode-invocation";
import {
  queryAutomationReplica,
  readAutomationPageQuery,
  readAutomationReplica,
} from "@/fragno/automation/lofi/testing";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { currentWorkflowWaits } from "@/fragno/automation/workflow-waits";
import { piAgentActor } from "@/fragno/pi/agent/pi-agent-actor";
import { runtimeToolWorkflowCatalog } from "@/fragno/runtime-tools/workflow-catalog.server";

import { ApiObject } from "../../../../workers/api-object";
import { AppInstallationsObject } from "../../../../workers/app-installations-object";
import { AppsObject } from "../../../../workers/apps-object";
import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
import { BillingObject } from "../../../../workers/billing-object";
import { CodemodeObject } from "../../../../workers/codemode-object";
import { GitHubObject } from "../../../../workers/github-object";
import { GitHubWebhookRouterObject } from "../../../../workers/github-webhook-router-object";
import { McpObject } from "../../../../workers/mcp-object";
import { OtpObject } from "../../../../workers/otp-object";
import { ProjectConnectorObject } from "../../../../workers/project-connector-object";
import { ResendObject } from "../../../../workers/resend-object";
import { TelegramObject } from "../../../../workers/telegram-object";
import { UploadObject } from "../../../../workers/upload-object";
import { piAgentListings, piAgentQueueStatus } from "../agents/agent-activity";
import type { AutomationWorkflowRun } from "../automations/script-view/workflow-run-presentation";
import { projectEventTraceList, type EventTraceSummary } from "./event-traces";
import { orchestrationInletDetail, projectOrchestrationGraph } from "./orchestration-graph";
import { workflowOutsideCalls } from "./orchestration-outside-systems";
import { projectOrchestrationUniverse } from "./orchestration-universe";
import { dashboardBucketStarts, projectBackofficeDashboard } from "./overview";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }
  class MockRpcTarget {}
  class MockWorkerEntrypoint {}
  return {
    DurableObject: MockDurableObject,
    RpcTarget: MockRpcTarget,
    WorkerEntrypoint: MockWorkerEntrypoint,
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  BILLING: (input) => new BillingObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  GITHUB: (input) => new GitHubObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new GitHubWebhookRouterObject(input),
  MCP: (input) => new McpObject(input),
  OTP: (input) => new OtpObject(input),
  PROJECT_CONNECTOR: (input) => new ProjectConnectorObject(input),
  RESEND: (input) => new ResendObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

// Building the home page runs its source, which needs a compiler that bundles saved modules.
let codemodeServer: Awaited<ReturnType<typeof createCodemodeTestServer>>;
beforeAll(async () => {
  codemodeServer = await createCodemodeTestServer();
});
afterAll(async () => {
  await codemodeServer?.close();
});

const orgId = "org-1";
const scope = { kind: "org" as const, orgId, jurisdiction: null };
const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULED_AT = "2030-01-01T00:00:00.000Z";

const workflows = {
  "automations/ship-order.workflow.js": `export default defineWorkflow({ name: "ship-order" }, async (event, step) => {
  await step.do("ship", async () => "shipped");
  return "shipped";
});`,
  "automations/charge-card.workflow.js": `export default defineWorkflow({ name: "charge-card" }, async (event, step) => {
  await step.do("charge", { retries: { limit: 0, delay: 0 } }, async () => {
    throw new Error("card declined");
  });
});`,
  "automations/approve-refund.workflow.js": `export default defineWorkflow({ name: "approve-refund" }, async (event, step) => {
  await step.do("ask for approval", async () => ({
    $ui: {
      version: 1,
      state: {},
      spec: {
        root: "question",
        elements: { question: { type: "Text", props: { text: "Approve the refund?" }, children: [] } },
      },
    },
  }));
  await step.waitForEvent("approval", { type: "refund-approved", timeout: "7 days" });
});`,
  "automations/sync-ledger.workflow.js": `export default defineWorkflow({ name: "sync-ledger" }, async (event, step) => {
  await step.do("sync", { retries: { limit: 0, delay: 0 } }, async () => {
    if (event.payload.offline) {
      throw new Error("ledger offline");
    }
  });
});`,
  "automations/await-shipment.workflow.js": `export default defineWorkflow({ name: "await-shipment" }, async (event, step) => {
  await step.waitForEvent("shipment", { type: "shipped", timeout: "7 days" });
});`,
};

/** Asks six questions in one go, then waits for the answers to the last. */
const SURVEY_WORKFLOW = `export default defineWorkflow({ name: "survey" }, async (event, step) => {
  for (const question of [1, 2, 3, 4, 5, 6]) {
    await step.do(\`question \${question}\`, async () => ({
      $ui: {
        version: 1,
        state: {},
        spec: {
          root: "question",
          elements: { question: { type: "Text", props: { text: \`Question \${question}\` }, children: [] } },
        },
      },
    }));
  }
  await step.waitForEvent("answers", { type: "survey-answered", timeout: "7 days" });
});`;

/** Events carry the time they happened, so the scenario stamps them against its own clock. */
function event(
  id: string,
  source: string,
  eventType: string,
  occurredAt: number,
  { payload, subject }: Pick<AutomationEvent, "payload" | "subject"> = {
    payload: { id },
    subject: { scope: { kind: "org", orgId, jurisdiction: null } },
  },
): AutomationEvent {
  return {
    id,
    scopeRestriction: null,
    scope,
    source,
    eventType,
    occurredAt: new Date(occurredAt).toISOString(),
    payload,
    actors: createBackofficeSystemExecution(scope).actors,
    subject,
    causation: { kind: "origin" },
  };
}

/** Acting as an agent's turn does, which lets the runs it starts reply to the agent. */
function agentExecution(agentName: string): BackofficeExecutionContext {
  const execution = createBackofficeSystemExecution(scope);
  const { actors } = execution;
  return {
    ...execution,
    actors: { ...actors, delegation: [...actors.delegation, piAgentActor(scope, agentName)] },
  };
}

function connectionEvent(
  id: string,
  state: "ready" | "unavailable",
  connectionId: string,
  at: number,
  name = connectionId,
) {
  return event(id, "integrations", `connection.${state}`, at, {
    payload: { name, authMethod: null },
    subject: { scope, service: connectionId.split("#", 1)[0], connectionId },
  });
}

type PiEventType =
  | "turn.completed"
  | "turn.aborted"
  | "agent.created"
  | "agent.updated"
  | "agent.deleted"
  | "agent.stopped";

/** Each `pi` event with the smallest payload its catalog entry accepts. */
function piEvent(
  id: string,
  eventType: PiEventType,
  agentName: string,
  at: number,
  description = "Reviews changes.",
) {
  const definition = {
    agentName,
    description,
    model: null,
    permissions: [],
    instructions: "Review carefully.",
  };
  const payloads: Record<PiEventType, Record<string, unknown>> = {
    "turn.completed": { answerEntryId: 1 },
    "turn.aborted": {},
    "agent.created": { definition },
    "agent.updated": { definition },
    "agent.deleted": { definition },
    "agent.stopped": {},
  };
  const isTurn = eventType.startsWith("turn.");
  return event(id, "pi", eventType, at, {
    payload: payloads[eventType],
    subject: {
      scope: { kind: "org", orgId, jurisdiction: null },
      agentName,
      ...(isTurn ? { requestId: id } : {}),
    },
  });
}

/** A turn or queue event about one request, whose ID differs from the request's. */
function requestEvent(
  id: string,
  eventType: "turn.started" | "queue.added" | "queue.dispatched",
  requestId: string,
  at: number,
  payload: Record<string, unknown>,
) {
  return event(id, "pi", eventType, at, {
    payload,
    subject: {
      scope: { kind: "org", orgId, jurisdiction: null },
      agentName: "assistant",
      requestId,
    },
  });
}

const HOME_PAGE_PATH = "/workspace/home.page.js";
const HOME_PAGE_SOURCE = String(
  GENERAL_SKILL_CONTENT["skills/building-pages/examples/home.page.js"],
);

type SpecElement = {
  type: string;
  props: Record<string, unknown>;
  children?: string[];
  repeat?: { statePath: unknown };
};

/**
 * The rows of each section's top-level lists and charts, by section label, in layout order;
 * lists nested in a row read that row's fields.
 */
function sectionQueries({ spec, queries }: PageDefinition): Record<string, string[]> {
  const elements = spec.elements as Record<string, SpecElement>;
  const queryAt = (path: unknown) =>
    Object.keys(queries).find((name) => pageDataPath(name) === path);
  const sections: Record<string, string[]> = {};
  const visit = (id: string, section: string) => {
    const element = elements[id];
    const label =
      element.type === "Panel" || element.type === "PanelTable"
        ? String(element.props.title)
        : section;
    const rows = element.props.rows as { $state?: unknown } | undefined;
    const query = queryAt(element.repeat?.statePath) ?? queryAt(rows?.$state);
    if (query !== undefined) {
      (sections[label] ??= []).push(query);
      return;
    }
    for (const child of element.children ?? []) {
      visit(child, label);
    }
  };
  visit(spec.root, "");
  return sections;
}

type HomePageRows = {
  "Needs attention": [
    { workflow: string; step: string; instanceId: string }[],
    { workflow: string; errored: number; error: string }[],
    { id: string }[],
  ];
  "Coming up": [
    { name: string; at: string }[],
    { workflow: string; runs: number; waits: { eventType: string }[] }[],
  ];
  Agents: [
    {
      agentName: string;
      description: string;
      latestKind: string | null;
      queue: string;
      hourly: { turns: number }[];
    }[],
  ];
};

/** Saves the example home page and builds it as its route does. */
async function buildHomePage(ctx: BackofficeScenarioContext): Promise<PageDefinition> {
  assert.deepEqual(checkPageSource(HOME_PAGE_PATH, HOME_PAGE_SOURCE), []);
  await ctx.runCodemode({
    scope,
    code: `async () => await state.writeFile({ path: ${JSON.stringify(HOME_PAGE_PATH)}, content: ${JSON.stringify(HOME_PAGE_SOURCE)} })`,
  });
  const { page: loaded } = await loadPage({
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeSystemExecution(scope),
    sourcePath: HOME_PAGE_PATH,
  });
  assert(loaded.kind === "ready", JSON.stringify(loaded));
  return loaded.definition;
}

/**
 * Renders the home page and reads each section the way readDashboard reads the dashboard, so the
 * two compare where the page covers the dashboard.
 */
async function readHomePage(ctx: BackofficeScenarioContext, definition: PageDefinition) {
  const handle = ctx.lofi.automations.forOrg(orgId);
  await handle.drain();
  const now = ctx.runtime.now();
  const store = createStateStore({});
  const data: Record<string, PageData[]> = {};
  for (const [name, query] of Object.entries(definition.queries)) {
    data[name] = pageRows(query, await readAutomationPageQuery(handle.replica, query, now));
    store.set(pageDataPath(name), data[name]);
    for (const [valueName, value] of Object.entries(definition.values)) {
      if (value.query === name) {
        store.set(pageValuePath(valueName), pageValue(value, data[name]));
      }
    }
  }
  const markup = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(BackofficeUiStoreRenderer, {
        spec: definition.spec,
        store,
        now,
        links: () => "/",
        // The widgets are the dashboard's own components, so markers show where the page puts them.
        widgets: {
          orchestration: () => createElement("i", { "data-widget": "orchestration" }),
          workflowResponse: ({ instanceId }) => createElement("i", { "data-respond": instanceId }),
        },
      }),
    ),
  );
  assert.notInclude(markup, "cannot show its data");

  // The page's queries declare these columns, which pageRows decodes.
  const sections = Object.fromEntries(
    Object.entries(sectionQueries(definition)).map(([label, queries]) => [
      label,
      queries.map((query) => data[query]),
    ]),
  ) as unknown as HomePageRows;
  const [awaitingInput, failing, unavailable] = sections["Needs attention"];
  const [schedules, waiting] = sections["Coming up"];
  const responses = new Set([...markup.matchAll(/data-respond="([^"]+)"/g)].map(([, id]) => id));
  return {
    attention: [
      ...awaitingInput.map(
        ({ workflow, step, instanceId }) =>
          `input: ${workflow} (${step})${responses.has(instanceId) ? "" : " without a form"}`,
      ),
      ...failing.map(
        ({ workflow, errored, error }) => `failing: ${workflow} ×${errored} (${error})`,
      ),
      ...unavailable.map(({ id }) => `unavailable: ${id}`),
    ],
    agents: sections.Agents[0].map(({ agentName, description, latestKind, queue, hourly }) => {
      const turns = hourly.reduce((total, hour) => total + hour.turns, 0);
      const recorded =
        latestKind === null
          ? "no activity"
          : `${latestKind}, ${turns} turns in ${hourly.length} hours`;
      return `${agentName} (${description.slice(0, 20)}): ${recorded}${queue ? `; ${queue}` : ""}`;
    }),
    // The page shows cron expressions as they are, so only when each schedule fires compares.
    schedules: schedules.map(({ name, at }) => `${name} at ${at}`),
    waiting: waiting.map(
      ({ workflow, runs, waits }) =>
        `${workflow}: ${runs} for ${waits.map(({ eventType }) => eventType).join(", ")}`,
    ),
  };
}

/**
 * The example home page shows what the overview shows, except what automations did lately, which
 * the Activity tab projects from traces. Its response forms are the dashboard's own, so the page
 * only has to place them. Building the page records Codemode events, so both read the scope after
 * the build.
 */
async function assertHomePageMatchesDashboard(ctx: BackofficeScenarioContext) {
  const definition = await buildHomePage(ctx);
  const {
    conversations: _conversations,
    activity: _activity,
    recentActivity: _recentActivity,
    schedules,
    ...dashboard
  } = await readDashboard(ctx);
  assert.deepEqual(await readHomePage(ctx, definition), {
    ...dashboard,
    schedules: schedules.map((schedule) => schedule.replace(/^(.*): .* at /, "$1 at ")),
  });
}

/**
 * Reads the overview the way the page does, from the scope's Automations replica, and the Activity
 * tab's list of what each origin set in motion.
 */
async function readDashboard(ctx: BackofficeScenarioContext) {
  const replica = ctx.lofi.automations.forOrg(orgId);
  await replica.drain();
  const now = ctx.runtime.now();
  const since = dashboardBucketStarts(now)[0] ?? now;
  const [overview, traces, recentTraces] = await Promise.all([
    readAutomationReplica(replica.replica, "dashboardOverview", { since }),
    readAutomationReplica(replica.replica, "eventTraceSummaries", { limit: 100, origins: "all" }),
    // Fewer than the events nothing acted on after the last run, as a burst of them can be.
    readAutomationReplica(replica.replica, "eventTraceSummaries", {
      limit: 2,
      origins: "acted-on",
    }),
  ]);
  const { agents, agentTurns } = overview;
  const dashboard = projectBackofficeDashboard({ now, ...overview });

  return {
    attention: dashboard.attention.map((item) => {
      switch (item.kind) {
        case "awaiting-input":
          return `input: ${item.workflow} (${item.generatedUi.step.name})`;
        case "failing-workflow":
          return `failing: ${item.workflow} ×${item.erroredRuns} (${item.error})`;
        case "connection-unavailable":
          return `unavailable: ${item.connection.connectionId}`;
      }
      throw new Error("Unsupported dashboard attention item.");
    }),
    // The conversation each run waiting for input leads to.
    conversations: dashboard.attention.flatMap((item) =>
      item.kind === "awaiting-input"
        ? [`${item.workflow}: ${item.run.codemode?.agentName ?? "no conversation"}`]
        : [],
    ),
    agents: piAgentListings(agents, agentTurns, dashboard.bucketStarts).map((agent) => {
      const turns = agent.turnsPerBucket.reduce((total, count) => total + count, 0);
      const recorded =
        agent.latestKind === null
          ? "no activity"
          : `${agent.latestKind}, ${turns} turns in ${agent.turnsPerBucket.filter((count) => count > 0).length} hours`;
      const queue = piAgentQueueStatus(agent);
      return `${agent.agentName} (${agent.definition.description.slice(0, 20)}): ${recorded}${queue ? `; ${queue.label}` : ""}`;
    }),
    schedules: dashboard.schedules.map(
      ({ name, cadence, at }) => `${name}: ${cadence} at ${at.toISOString()}`,
    ),
    waiting: dashboard.waiting.map(
      ({ workflow, runCount, waitingFor }) =>
        `${workflow}: ${runCount} for ${waitingFor.join(", ")}`,
    ),
    activity: [
      ...describeActivity(traces.filter((trace) => trace.outcome.kind !== "unhandled")),
      `${traces.filter((trace) => trace.outcome.kind === "unhandled").length} nothing acted on`,
    ],
    recentActivity: describeActivity(recentTraces),
  };
}

function describeActivity(traces: EventTraceSummary[]): string[] {
  return projectEventTraceList(traces).map((entry) => {
    const [newest, ...older] = entry.kind === "trace" ? [entry.trace] : entry.traces;
    const effects = newest.effects.map(({ kind, label }) => `${kind} ${label}`).join(", ");
    const repeats = older.length === 0 ? "" : ` ×${older.length + 1}`;
    return `${effects}${repeats} ← ${newest.source} ${newest.headline ?? newest.eventType}: ${newest.outcome.kind}`;
  });
}

/** When a schedule that fires daily at 07:00 UTC fires next after `now`. */
function nextMorning(now: number): string {
  const morning = new Date(now);
  morning.setUTCHours(7, 0, 0, 0);
  if (morning.getTime() <= now) {
    morning.setUTCDate(morning.getUTCDate() + 1);
  }
  return morning.toISOString();
}

/** A scope's orchestration graph as the Map reads it from the scope's replica, and its inputs. */
async function readScopeGraph(
  ctx: BackofficeScenarioContext,
  graphScope: BackofficeContextScope,
  scopeLabel: string,
) {
  const replica = ctx.lofi.automations.forScope(graphScope);
  await replica.drain();
  const now = ctx.runtime.now();
  const since = dashboardBucketStarts(now)[0] ?? now;
  const [inputs, { activeWorkflows }] = await Promise.all([
    readAutomationReplica(replica.replica, "orchestrationGraphInputs", {
      since,
      ownerScope: graphScope,
    }),
    readAutomationReplica(replica.replica, "orchestrationRecords", undefined),
  ]);
  // Catalogs are left out so the graph holds only what this scope's data puts there.
  const graph = projectOrchestrationGraph({
    scopeLabel,
    sources: [],
    eventDefinitions: [],
    activeWorkflows,
    ...inputs,
  });
  return { graph, inputs, since, replica: replica.replica };
}

/** The Map's orchestration graph, as its tab reads it from the replica. */
async function readMap(ctx: BackofficeScenarioContext) {
  const {
    graph,
    inputs: { forwardAccepts, recentForwards },
  } = await readScopeGraph(ctx, scope, "Ada Labs");
  return {
    routes: graph.routes.map(
      ({ eventId, priority, label, action }) =>
        `${eventId} → P${priority} ${label} → ${action.kind === "reclassify_event" ? action.eventId : action.targetId}`,
    ),
    targets: graph.targets.map(({ label, activeCount }) => `${label}: ${activeCount} running`),
    recent: graph.events
      .filter(({ recentCount }) => recentCount > 0)
      .map(({ id, recentCount }) => `${id} ×${recentCount}`)
      .sort(),
    // Each inlet with what the inspector lists as forwarded through it.
    inlets: graph.inlets.map(({ id, label, senders, status, eventIds, recentCount }) => ({
      inlet: `${label} (${senders.label}, ${status}) → ${eventIds?.join(", ") ?? "unnamed events"} ×${recentCount}`,
      forwarded: orchestrationInletDetail(id, { forwardAccepts, recentForwards }).forwards.map(
        ({ source, eventType, from }) => `${source}.${eventType} by ${from.routeName}`,
      ),
    })),
  };
}

/**
 * The organization's universe, as the person `viewer` sees it on its Map: a planet per scope, with
 * the routes on it, and the forwards between planets. Each project's planet, and the person's own,
 * is read from its replica if `read`.
 */
async function readUniverse(
  ctx: BackofficeScenarioContext,
  {
    projects,
    viewer,
    read,
  }: {
    projects: readonly { scope: BackofficeContextScope; label: string }[];
    viewer: { scope: BackofficeContextScope; label: string };
    read: boolean;
  },
) {
  const readScope = async (scopeToRead: { scope: BackofficeContextScope; label: string }) => {
    if (!read) {
      return { ...scopeToRead, read: null };
    }
    const { graph, inputs, replica, since } = await readScopeGraph(
      ctx,
      scopeToRead.scope,
      scopeToRead.label,
    );
    return {
      ...scopeToRead,
      read: {
        graph,
        routes: inputs.routes,
        deliveries: await readAutomationReplica(replica, "recentForwardDeliveries", { since }),
        calls: await readOutsideCalls(replica),
      },
    };
  };
  const organization = await readScopeGraph(ctx, scope, "Ada Labs");
  const universe = projectOrchestrationUniverse({
    organization: {
      scope,
      graph: organization.graph,
      routes: organization.inputs.routes,
      deliveries: await readAutomationReplica(organization.replica, "recentForwardDeliveries", {
        since: organization.since,
      }),
      calls: await readOutsideCalls(organization.replica),
    },
    projects: await Promise.all(projects.map(readScope)),
    viewer: await readScope(viewer),
    recentForwards: organization.inputs.recentForwards,
    // Only the person looking forwards in, and they go by their own name.
    memberNames: {},
  });
  // Forwards carried at the same moment have no order between them, so each list is sorted.
  const sorted = (lines: string[]) => [...lines].sort();
  return {
    planets: universe.scopes.map(
      ({ id, graph }) =>
        `${id} ${graph.scopeLabel}: ${sorted(graph.routes.map(({ label }) => label)).join(", ") || "no routes"}`,
    ),
    forwards: sorted(
      universe.forwards.map(
        ({ routeId, fromScopeId, toScopeId }) => `${fromScopeId} → ${toScopeId} by ${routeId}`,
      ),
    ),
    // What the universe draws: one forward per pair of planets and event carried between them.
    drawn: sorted(
      layoutUniverse(universe).forwards.map(
        ({ fromScopeId, toScopeId, eventId }) =>
          `${fromScopeId} → ${toScopeId} carrying ${eventId}`,
      ),
    ),
    // The calls it draws, from workflows on planets to outside systems, which go by their names.
    calls: sorted(
      layoutUniverse(universe).calls.map(({ scopeId, workflowId, externalId }) => {
        const external = universe.externals.find(({ id }) => id === externalId)!;
        return `${scopeId} ${workflowId} → ${externalId} "${external.label}" ${external.icon}`;
      }),
    ),
  };
}

/**
 * The outside systems a scope's workflows call, from the scripts their last runs ran, with its
 * connections naming the integrations.
 */
async function readOutsideCalls(replica: Parameters<typeof readAutomationReplica>[0]) {
  return workflowOutsideCalls(
    await readAutomationReplica(replica, "latestWorkflowPrograms", undefined),
    runtimeToolWorkflowCatalog,
    await readAutomationReplica(replica, "integrationConnections", undefined),
  );
}

/** The Agents directory, one line per agent: its activity and the turns it ended per hour. */
async function readAgentDirectory(ctx: BackofficeScenarioContext): Promise<string[]> {
  const handle = ctx.lofi.automations.forOrg(orgId);
  await handle.drain();
  const bucketStarts = dashboardBucketStarts(ctx.runtime.now());
  const directory = await readAutomationReplica(handle.replica, "piAgentDirectory", {
    bucketStarts,
  });
  return directory.map(
    ({ agentName, builtIn, activity, queued, paused, turnsPerBucket }) =>
      `${agentName}${builtIn ? " (built in)" : ""}: ${activity}, ${queued} queued${paused ? ", paused" : ""}; turns ${turnsPerBucket.filter((count) => count > 0).join(" + ") || "none"}`,
  );
}

/**
 * What the views beside the dashboard read from the replica: the routes the Files explorer marks
 * workflows with, the orchestration graph's records and an event's latest occurrences, the runs
 * the run views show, and the Codemode runs an agent conversation opens.
 */
async function readReplicaReads(ctx: BackofficeScenarioContext) {
  // The scope's own catalog adds to what registered capabilities describe.
  await ctx.runtime.objects.automations.for(scope).commands.ensureEventSource({
    source: "shop",
    label: "Shop",
    description: "Orders placed in the shop.",
    category: "custom",
  });
  await ctx.runCodemode({
    scope,
    code: `async () => await events.catalogCreate(${JSON.stringify({
      source: "shop",
      eventType: "order.placed",
      label: "Order placed",
      payloadSchema: { type: "object", properties: { id: { type: "string" } } },
    })})`,
  });
  const handle = ctx.lofi.automations.forOrg(orgId);
  await handle.drain();
  const { replica } = handle;
  const runLine = (run: AutomationWorkflowRun) =>
    `${run.remoteWorkflowName ?? run.workflowName} ${run.status}: ${
      run.workflowSteps.map(({ name, status }) => `${name} ${status}`).join(", ") || "no steps"
    }; ${run.workflowEvents.length} events, ${run.workflowStepEmissions.length} emissions`;

  const records = await readAutomationReplica(replica, "orchestrationRecords", undefined);
  const activeCodemode = await readAutomationReplica(replica, "workflowRuns", {
    type: "active-codemode",
  });
  const waiting = await readAutomationReplica(replica, "workflowRuns", { type: "waiting" });
  const instanceIds = [...activeCodemode.map(({ instanceId }) => instanceId), "missing"];
  const latestEvents: Record<string, string[]> = {};
  for (const [source, eventType] of [
    ["acme", "webhook.received"],
    ["shop", "order.placed"],
    ["shop", "missing"],
  ] as const) {
    latestEvents[`${source}:${eventType}`] = (
      await readAutomationReplica(replica, "latestEventsOfType", { source, eventType, limit: 2 })
    ).map(({ id, payload }) => `${id} ${JSON.stringify(payload)}`);
  }
  return {
    routes: (await readAutomationReplica(replica, "automationRoutes", undefined)).map(
      ({ id, name, enabled, priority, trigger, action, nextOccurrenceAt }) =>
        `${priority} ${id} "${name}"${enabled ? "" : " disabled"}: ${trigger.kind} -> ${action.kind}${nextOccurrenceAt ? ` at ${nextOccurrenceAt}` : ""}`,
    ),
    eventSources: records.eventSources.map(({ id, label }) => `${id}: ${label}`).sort(),
    eventDefinitions: records.eventDefinitions
      .map(
        ({ source, eventType, label, payloadSchema }) =>
          `${source}.${eventType}: ${label}${payloadSchema ? " (schema)" : ""}`,
      )
      .sort(),
    activeWorkflows: records.activeWorkflows
      .map(({ workflowName, remoteWorkflowName }) => remoteWorkflowName ?? workflowName)
      .sort(),
    activeCodemodeRuns: activeCodemode.map(runLine),
    waitingRuns: waiting.map(runLine),
    instanceRuns: await Promise.all(
      instanceIds.map(async (instanceId) =>
        (
          await readAutomationReplica(replica, "workflowRuns", {
            type: "instance",
            workflowName: CODEMODE_WORKFLOW,
            instanceId,
          })
        ).map(runLine),
      ),
    ),
    startedCodemodeRuns: await readAutomationReplica(replica, "startedCodemodeRuns", {
      instanceIds,
    }),
    // `WorkflowRunResponse` derives a run's waits from the run, as the waits relation does.
    waits: waiting
      .flatMap((run) =>
        currentWorkflowWaits([
          {
            id: run.id,
            output: run.output,
            steps: run.workflowSteps,
            events: run.workflowEvents,
          },
        ]),
      )
      .map(
        ({ eventType, interfaceStepKey }) =>
          `${eventType}${interfaceStepKey ? ` asks at ${interfaceStepKey}` : ""}`,
      ),
    latestEvents,
  };
}

describe("dashboard", () => {
  test("separates what needs a person from how automations and events are doing", async () => {
    const start = Date.now();
    const twoDaysLater = start + 2 * DAY_MS;
    const createRun = (name: string, instanceId: string, at: number) =>
      ({
        orgId,
        instanceId,
        path: `/workspace/automations/${name}.workflow.js`,
        event: event(`trigger-${instanceId}`, "shop", "order.manual", at),
      }) as const;

    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        env: { codemode: createCodemodeNodeExecutor(codemodeServer) },
        name: "a dashboard over two days of automation activity",
        files: backofficeFiles.custom({ workspace: workflows }),
        // Failing card charges are part of what the dashboard reports.
        options: { allowErroredWorkflows: true },
        setup: ({ given }) => [
          given.organization.exists({ id: orgId, name: "Ada Labs" }),
          given.router.route({
            orgId,
            id: "ship-placed-orders",
            name: "Ship placed orders",
            enabled: true,
            priority: 100,
            trigger: { kind: "event", source: "shop", eventType: "order.placed", matcher: null },
            action: {
              kind: "start_workflow",
              authority: { kind: "organization-automation", grants: [] },
              workflowScriptPath: "/workspace/automations/ship-order.workflow.js",
              instanceIdTemplate: "ship-${event.id}",
            },
          }),
          given.router.route({
            orgId,
            id: "morning-digest",
            name: "Morning digest",
            enabled: true,
            priority: 150,
            trigger: {
              kind: "schedule",
              cadence: { kind: "cron", expression: "0 7 * * *", timeZone: "UTC" },
            },
            action: {
              kind: "start_workflow",
              authority: { kind: "organization-automation", grants: [] },
              workflowScriptPath: "/workspace/automations/ship-order.workflow.js",
              instanceIdTemplate: "morning-${event.id}",
            },
          }),
          given.router.route({
            orgId,
            id: "new-year-digest",
            name: "New year digest",
            enabled: true,
            priority: 200,
            trigger: { kind: "schedule", cadence: { kind: "once", at: SCHEDULED_AT } },
            action: {
              kind: "start_workflow",
              authority: { kind: "organization-automation", grants: [] },
              workflowScriptPath: "/workspace/automations/ship-order.workflow.js",
              instanceIdTemplate: "digest-${event.id}",
            },
          }),
        ],
        steps: ({ when, then }) => [
          when.workflow.createInstance(createRun("charge-card", "charge-1", start)),
          when.automation.ingestEvent(event("hook-1", "acme", "webhook.received", start)),
          when.time.advance("2 days"),
          when.workflow.createInstance(createRun("charge-card", "charge-2", twoDaysLater)),
          when.workflow.createInstance(createRun("approve-refund", "refund-1", twoDaysLater)),
          when.workflow.createInstance(createRun("await-shipment", "shipment-1", twoDaysLater)),
          when.automation.ingestEvent(event("order-1", "shop", "order.placed", twoDaysLater)),
          when.automation.ingestEvent(event("hook-2", "acme", "webhook.received", twoDaysLater)),
          when.automation.ingestEvent(event("hook-3", "acme", "webhook.received", twoDaysLater)),
          when.automation.ingestEvent(
            connectionEvent("billing-ready", "ready", "api#billing", twoDaysLater),
          ),
          when.automation.ingestEvent(
            connectionEvent("agensi-ready", "ready", "mcp#agensi", start),
          ),
          when.automation.ingestEvent(
            connectionEvent("agensi-unavailable", "unavailable", "mcp#agensi", twoDaysLater),
          ),
          then.assert(
            "the last day surfaces today's failure but not the older one, the open form, and the outage",
            async (ctx) => {
              assert.deepEqual(await readDashboard(ctx), {
                attention: [
                  "input: approve-refund (ask for approval)",
                  "failing: charge-card ×1 (Error: card declined)",
                  "unavailable: mcp#agensi",
                ],
                conversations: ["approve-refund: no conversation"],
                agents: ["assistant (General-purpose Back): no activity"],
                schedules: [
                  `Morning digest: Every day at 07:00 UTC at ${nextMorning(twoDaysLater)}`,
                  `New year digest: Once at ${SCHEDULED_AT}`,
                ],
                waiting: ["await-shipment: 1 for shipped"],
                // What set something in motion leads; events nothing acted on gather apart. The
                // clock jumps two days at once, so the morning schedule fires once to catch up.
                activity: [
                  "workflow ship-order ← shop order.placed: settled",
                  "workflow ship-order ← scheduler Morning digest: settled",
                  "6 nothing acted on",
                ],
                // Overview's recent activity reaches past the events nothing acted on since.
                recentActivity: [
                  "workflow ship-order ← shop order.placed: settled",
                  "workflow ship-order ← scheduler Morning digest: settled",
                ],
              });
            },
          ),
          then.assert(
            "the Map leads both schedules and the order route to one workflow",
            async (ctx) => {
              assert.deepEqual(await readMap(ctx), {
                routes: [
                  "shop:order.placed → P100 Ship placed orders → workflow:/workspace/automations/ship-order.workflow.js",
                  "scheduler:schedule:morning-digest → P150 Morning digest → workflow:/workspace/automations/ship-order.workflow.js",
                  "scheduler:schedule:new-year-digest → P200 New year digest → workflow:/workspace/automations/ship-order.workflow.js",
                ],
                targets: ["ship-order: 0 running"],
                recent: [
                  "acme:webhook.received ×2",
                  "integrations:connection.ready ×1",
                  "integrations:connection.unavailable ×1",
                  "shop:order.placed ×1",
                ],
                inlets: [],
              });
            },
          ),
          then.assert("the example home page shows what the dashboard shows", async (ctx) => {
            await assertHomePageMatchesDashboard(ctx);
          }),
          then.assert(
            "the views beside the dashboard read the scope from the replica",
            async (ctx) => {
              const waitingRuns = [
                "await-shipment waiting: shipment waiting; 0 events, 0 emissions",
                "approve-refund waiting: ask for approval completed, approval waiting; 0 events, 0 emissions",
              ];
              assert.deepEqual(await readReplicaReads(ctx), {
                routes: [
                  '100 ship-placed-orders "Ship placed orders": event -> start_workflow',
                  `150 morning-digest "Morning digest": schedule -> start_workflow at ${nextMorning(twoDaysLater)}`,
                  `200 new-year-digest "New year digest": schedule -> start_workflow at ${SCHEDULED_AT}`,
                ],
                eventSources: ["shop: Shop"],
                eventDefinitions: ["shop.order.placed: Order placed (schema)"],
                activeWorkflows: ["approve-refund", "await-shipment"],
                activeCodemodeRuns: waitingRuns,
                waitingRuns,
                instanceRuns: [[waitingRuns[0]], [waitingRuns[1]], []],
                startedCodemodeRuns: ["refund-1", "shipment-1"],
                waits: ["shipped", "refund-approved asks at do:ask for approval"],
                latestEvents: {
                  "acme:webhook.received": ['hook-3 {"id":"hook-3"}', 'hook-2 {"id":"hook-2"}'],
                  "shop:order.placed": ['order-1 {"id":"order-1"}'],
                  "shop:missing": [],
                },
              });
            },
          ),
        ],
      }),
    );
  });

  test("the Map shows where members and System forward into the organization", async () => {
    const personal = { kind: "user", userId: "user-1", jurisdiction: null } as const;
    const system = { kind: "system" } as const;
    const inOrganization = (code: string) => ({ scope, code: `async () => await ${code}` });
    const fire = (
      fireScope: typeof personal | typeof system,
      source: string,
      eventType: string,
    ) => ({
      scope: fireScope,
      code: `async () => await events.fire({ source: "${source}", eventType: "${eventType}", payload: {} })`,
    });

    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "a member and System forward into an organization that accepts some of it",
        setup: ({ given }) => [
          given.organization.exists({ id: orgId, name: "Ada Labs", ownerUserId: "owner-1" }),
          given.auth.user({ id: "user-1" }),
          given.auth.member({ orgId, userId: "user-1" }),
          given.codemode.run({
            scope: personal,
            code: `async () => await router.create({
              id: "balances-to-org",
              name: "Balances to Ada Labs",
              trigger: { kind: "event", source: "bank", eventType: "balance.updated" },
              action: { kind: "forward_event", targetScope: { kind: "org", orgIdTemplate: "${orgId}" } },
            })`,
          }),
          given.codemode.run({
            scope: system,
            code: `async () => await router.create({
              id: "notices-to-org",
              name: "Notices to Ada Labs",
              trigger: { kind: "event", source: "ops", eventType: "notice.posted" },
              action: { kind: "forward_event", targetScope: { kind: "org", orgIdTemplate: "${orgId}" } },
            })`,
          }),
          given.codemode.run(
            inOrganization(`router.acceptsCreate({
              id: "member-balances",
              name: "Member balances",
              from: { kind: "members" },
              matcher: { path: "$.eventType", op: "eq", value: "balance.updated" },
            })`),
          ),
          given.codemode.run(
            inOrganization(`router.acceptsCreate({
              id: "member-receipts",
              name: "Member receipts",
              enabled: false,
              from: { kind: "members" },
              matcher: { all: [
                { path: "$.source", op: "eq", value: "upload" },
                { path: "$.eventType", op: "eq", value: "file.uploaded" },
              ] },
            })`),
          ),
          given.codemode.run(
            inOrganization(`router.acceptsCreate({
              id: "large-transfers",
              name: "Large transfers",
              from: { kind: "scope", scope: { kind: "user", userId: "user-2", jurisdiction: null } },
              matcher: { path: "$.payload.amountCents", op: "exists" },
            })`),
          ),
        ],
        steps: ({ when, then }) => [
          when.codemode.run(fire(personal, "bank", "balance.updated")),
          when.codemode.run(fire(personal, "bank", "balance.updated")),
          when.codemode.run(fire(system, "ops", "notice.posted")),
          then.assert(
            "each accept feeds the events it names, and System's forwards need none",
            async (ctx) => {
              assert.deepEqual((await readMap(ctx)).inlets, [
                {
                  inlet: "Large transfers (user:user-2, accepting) → unnamed events ×0",
                  forwarded: [],
                },
                {
                  inlet: "Member balances (Members, accepting) → bank:balance.updated ×2",
                  forwarded: [
                    "bank.balance.updated by Balances to Ada Labs",
                    "bank.balance.updated by Balances to Ada Labs",
                  ],
                },
                {
                  inlet: "Member receipts (Members, disabled) → upload:file.uploaded ×0",
                  forwarded: [],
                },
                {
                  inlet: "From System (System, trusted) → ops:notice.posted ×1",
                  forwarded: ["ops.notice.posted by Notices to Ada Labs"],
                },
              ]);
            },
          ),
          when.codemode.run(
            inOrganization(`router.acceptsUpdate({ id: "member-balances", enabled: false })`),
          ),
          then.assert("a disabled accept still shows what it let in", async (ctx) => {
            assert.deepInclude((await readMap(ctx)).inlets, {
              inlet: "Member balances (Members, disabled) → bank:balance.updated ×2",
              forwarded: [
                "bank.balance.updated by Balances to Ada Labs",
                "bank.balance.updated by Balances to Ada Labs",
              ],
            });
          }),
        ],
      }),
    );
  });

  test("the universe joins the organization, its projects, and the members who forward in", async () => {
    const personal = { kind: "user", userId: "user-1", jurisdiction: null } as const;
    const system = { kind: "system" } as const;
    const books = (projectId: unknown) =>
      ({ kind: "project", owner: scope, projectId: String(projectId) }) as const;
    const forwardRoute = (id: string, name: string, source: string, targetScope: string) =>
      `router.create({
        id: "${id}",
        name: "${name}",
        trigger: { kind: "event", source: "${source}", eventType: "received" },
        action: { kind: "forward_event", targetScope: ${targetScope} },
      })`;
    const run = (
      ctx: BackofficeScenarioContext,
      runScope: BackofficeContextScope,
      ...calls: string[]
    ) =>
      ctx.runCodemode({
        scope: runScope,
        code: `async () => { ${calls.map((call) => `await ${call};`).join(" ")} }`,
      });
    const fire = (source: string, payload: string) =>
      `events.fire({ source: "${source}", eventType: "received", payload: ${payload} })`;
    const toOrganization = `{ kind: "org", orgIdTemplate: "${orgId}" }`;

    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "an organization forwards to its project while a member and System forward to it",
        setup: ({ given }) => [
          given.organization.exists({ id: orgId, name: "Ada Labs", ownerUserId: "owner-1" }),
          given.auth.user({ id: "user-1" }),
          given.auth.member({ orgId, userId: "user-1" }),
          given.codemode.run({
            scope: personal,
            code: `async () => {
              await ${forwardRoute("balances-to-org", "Balances to Ada Labs", "bank", toOrganization)};
              await router.create({
                id: "ledger-to-org",
                name: "Ledger to Ada Labs",
                trigger: { kind: "event", source: "ledger", eventType: "*" },
                action: { kind: "forward_event", targetScope: ${toOrganization} },
              });
              await router.create({
                id: "tag-large-balances",
                name: "Tag large balances",
                trigger: { kind: "event", source: "bank", eventType: "received" },
                action: {
                  kind: "reclassify_event",
                  source: "bank",
                  eventType: "large",
                  payload: { kind: "projection", fields: {} },
                },
              });
            }`,
          }),
          given.codemode.run({
            scope: system,
            code: `async () => await ${forwardRoute("notices-to-org", "Notices to Ada Labs", "ops", toOrganization)}`,
          }),
          given.codemode.run({
            scope,
            code: `async () => await router.acceptsCreate({
              id: "member-balances",
              name: "Member balances",
              from: { kind: "members" },
              matcher: null,
            })`,
          }),
        ],
        steps: ({ when, then }) => [
          when.project.create({
            owner: scope,
            name: "Books",
            slug: "books",
            createdByUserId: "owner-1",
            captureIdAs: "books",
          }),
          then.assert("the organization routes leads to Books, naming it or not", async (ctx) => {
            const project = `{ kind: "project", owner: ${toOrganization}, projectIdTemplate: "${String(ctx.vars.books)}" }`;
            const anyProject = `{ kind: "project", owner: ${toOrganization}, projectIdTemplate: "\${event.payload.projectId}" }`;
            await run(
              ctx,
              scope,
              forwardRoute("leads-to-books", "Leads to Books", "crm", project),
              forwardRoute(
                "documents-to-project",
                "Documents to their project",
                "inbox",
                anyProject,
              ),
            );
            await run(
              ctx,
              books(ctx.vars.books),
              forwardRoute("receipts-to-org", "Receipts to Ada Labs", "shop", toOrganization),
            );
          }),
          then.assert("a member, System, and the organization forward", async (ctx) => {
            await run(
              ctx,
              personal,
              fire("bank", "{}"),
              `events.fire({ source: "ledger", eventType: "deposit.received", payload: {} })`,
              `events.fire({ source: "ledger", eventType: "balance.updated", payload: {} })`,
            );
            await run(ctx, system, fire("ops", "{}"));
            await run(ctx, scope, fire("inbox", `{ projectId: "${String(ctx.vars.books)}" }`));
            await ctx.drain();
          }),
          then.assert(
            "the person looking and Books are planets beside the organization, and System is not",
            async (ctx) => {
              const booksId = `project:org:${scope.orgId}:${String(ctx.vars.books)}`;
              const projects = [{ scope: books(ctx.vars.books), label: "Books" }];
              const organizationDrawn = [
                `org:org-1 → ${booksId} carrying crm:received`,
                `org:org-1 → ${booksId} carrying inbox:received`,
              ];
              // Until Books is read, its planet is its name, which the organization's forwards
              // still reach; until the person looking is read, they show as the organization
              // knows them: their ledger route once for each type it forwarded.
              const viewer = { scope: personal, label: "Ada" };
              assert.deepEqual(await readUniverse(ctx, { projects, viewer, read: false }), {
                planets: [
                  "org:org-1 Ada Labs: Documents to their project, Leads to Books",
                  `${booksId} Books: no routes`,
                  "user:user-1 Ada: Balances to Ada Labs, Ledger to Ada Labs, Ledger to Ada Labs",
                ],
                forwards: [
                  `org:org-1 → ${booksId} by documents-to-project`,
                  `org:org-1 → ${booksId} by leads-to-books`,
                  "user:user-1 → org:org-1 by balances-to-org|bank:received",
                  "user:user-1 → org:org-1 by ledger-to-org|ledger:balance.updated",
                  "user:user-1 → org:org-1 by ledger-to-org|ledger:deposit.received",
                ],
                drawn: [
                  ...organizationDrawn,
                  "user:user-1 → org:org-1 carrying bank:received",
                  "user:user-1 → org:org-1 carrying ledger:balance.updated",
                  "user:user-1 → org:org-1 carrying ledger:deposit.received",
                ],
                calls: [],
              });
              // Read, Books adds the forward its route names, and the person looking sees all of
              // their own routes, which the organization never does, the ledger route on its
              // wildcard event.
              assert.deepEqual(await readUniverse(ctx, { projects, viewer, read: true }), {
                planets: [
                  "org:org-1 Ada Labs: Documents to their project, Leads to Books",
                  `${booksId} Books: Receipts to Ada Labs`,
                  "user:user-1 Ada: Balances to Ada Labs, Ledger to Ada Labs, Tag large balances",
                ],
                forwards: [
                  `org:org-1 → ${booksId} by documents-to-project`,
                  `org:org-1 → ${booksId} by leads-to-books`,
                  `${booksId} → org:org-1 by receipts-to-org`,
                  "user:user-1 → org:org-1 by balances-to-org",
                  "user:user-1 → org:org-1 by ledger-to-org",
                ],
                drawn: [
                  ...organizationDrawn,
                  `${booksId} → org:org-1 carrying shop:received`,
                  "user:user-1 → org:org-1 carrying bank:received",
                  "user:user-1 → org:org-1 carrying ledger:*",
                ],
                calls: [],
              });
            },
          ),
        ],
      }),
    );
  });

  test("the universe shows the outside systems its workflows called in their last runs", async () => {
    const path = "/workspace/automations/research-lead.workflow.js";
    // The calls never run, since no lead asks for them; the script names them all the same. The
    // CRM is a connection of the organization's, and the lead's own connection is only known as
    // the workflow runs.
    const researchLead = `export default defineWorkflow({ name: "research-lead" }, async (event, step) => {
  await step.do("research", async () => {
    if (event.payload.deep) {
      const page = await web.extract({ url: event.payload.url });
      const verdict = await models.classify({ input: page, labels: ["hot", "cold"] });
      await integrations.execute({ connectionId: "api#crm", actionId: "notes.create", input: { verdict } });
      await integrations.execute({ connectionId: event.payload.connection, actionId: "reply", input: {} });
      return verdict;
    }
    return "skipped";
  });
});`;
    const projects: { scope: BackofficeContextScope; label: string }[] = [];
    const viewer = {
      scope: { kind: "user", userId: "user-1", jurisdiction: null } as const,
      label: "Ada",
    };

    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        env: { codemode: createCodemodeNodeExecutor(codemodeServer) },
        name: "an organization's lead research reaches the web and models",
        files: backofficeFiles.custom({
          workspace: { "automations/research-lead.workflow.js": researchLead },
        }),
        setup: ({ given }) => [
          given.organization.exists({ id: orgId, name: "Ada Labs" }),
          given.router.route({
            orgId,
            id: "research-leads",
            name: "Research leads",
            enabled: true,
            priority: 100,
            trigger: { kind: "event", source: "crm", eventType: "lead.created", matcher: null },
            action: {
              kind: "start_workflow",
              authority: { kind: "organization-automation", grants: [] },
              workflowScriptPath: path,
              instanceIdTemplate: "research-${event.id}",
            },
          }),
        ],
        steps: ({ when, then }) => [
          then.assert("a workflow that never ran calls nothing yet", async (ctx) => {
            assert.deepEqual(
              (await readUniverse(ctx, { projects, viewer, read: false })).calls,
              [],
            );
          }),
          when.automation.ingestEvent(
            connectionEvent("crm-ready", "ready", "api#crm", Date.now(), "CRM"),
          ),
          when.workflow.createInstance({
            orgId,
            instanceId: "research-1",
            path,
            event: event("lead-1", "crm", "lead.created", Date.now()),
          }),
          then.assert("its run names what it calls", async (ctx) => {
            assert.deepEqual((await readUniverse(ctx, { projects, viewer, read: false })).calls, [
              `org:org-1 workflow:${path} → connection:api#crm "CRM" code`,
              `org:org-1 workflow:${path} → integrations "Integrations" link`,
              `org:org-1 workflow:${path} → models "Models" cpu`,
              `org:org-1 workflow:${path} → web "Web" globe`,
            ]);
          }),
        ],
      }),
    );
  });

  test("a workflow needs attention for the failures since it last completed", async () => {
    const start = Date.now();
    const syncRun = (instanceId: string, offline: boolean, at: number) =>
      ({
        orgId,
        instanceId,
        path: "/workspace/automations/sync-ledger.workflow.js",
        event: event(`trigger-${instanceId}`, "ledger", "sync.requested", at, {
          payload: { offline },
          subject: { scope: { kind: "org", orgId, jurisdiction: null } },
        }),
      }) as const;
    const attentionOf = async (ctx: BackofficeScenarioContext) => {
      const { attention, conversations } = await readDashboard(ctx);
      return { attention, conversations };
    };

    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        env: { codemode: createCodemodeNodeExecutor(codemodeServer) },
        name: "a ledger sync fails, recovers, and fails again while an agent's form waits",
        files: backofficeFiles.custom({ workspace: workflows }),
        options: { allowErroredWorkflows: true },
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ when, then }) => [
          when.workflow.createInstance(syncRun("sync-1", true, start)),
          then.assert("the failed sync needs attention", async (ctx) => {
            assert.deepEqual(await attentionOf(ctx), {
              attention: ["failing: sync-ledger ×1 (Error: ledger offline)"],
              conversations: [],
            });
          }),
          when.time.advance("1 minute"),
          when.workflow.createInstance(syncRun("sync-2", false, start + 60_000)),
          when.workflow.createInstance({
            orgId,
            instanceId: "refund-1",
            path: "/workspace/automations/approve-refund.workflow.js",
            event: event("trigger-refund-1", "shop", "refund.requested", start + 60_000),
            execution: agentExecution("assistant"),
            replyTo: {
              kind: "agent",
              scope: { kind: "org", orgId, jurisdiction: null },
              agentName: "assistant",
            },
          }),
          then.assert(
            "the sync that completed clears the failure, and the form leads to the agent that started it",
            async (ctx) => {
              assert.deepEqual(await attentionOf(ctx), {
                attention: ["input: approve-refund (ask for approval)"],
                conversations: ["approve-refund: assistant"],
              });
              await assertHomePageMatchesDashboard(ctx);
            },
          ),
          when.time.advance("1 minute"),
          when.workflow.createInstance(syncRun("sync-3", true, start + 120_000)),
          then.assert("a failure after the recovery counts alone", async (ctx) => {
            assert.deepEqual(await attentionOf(ctx), {
              attention: [
                "input: approve-refund (ask for approval)",
                "failing: sync-ledger ×1 (Error: ledger offline)",
              ],
              conversations: ["approve-refund: assistant"],
            });
            await assertHomePageMatchesDashboard(ctx);
          }),
        ],
      }),
    );
  });

  test("a run's steps keep the order it created them in, also within one transaction", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "a survey asks six questions in one tick and waits at the last",
        files: backofficeFiles.custom({
          workspace: { "automations/survey.workflow.js": SURVEY_WORKFLOW },
        }),
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ when, then }) => [
          when.workflow.createInstance({
            orgId,
            instanceId: "survey-1",
            path: "/workspace/automations/survey.workflow.js",
            event: event("trigger-survey-1", "shop", "survey.requested", Date.now()),
          }),
          then.assert(
            "the run lists its steps in order and asks at the last question",
            async (ctx) => {
              const handle = ctx.lofi.automations.forOrg(orgId);
              await handle.drain();
              const [run] = await readAutomationReplica(handle.replica, "workflowRuns", {
                type: "waiting",
              });
              const steps = [1, 2, 3, 4, 5, 6]
                .map((question) => `question ${question}`)
                .concat("answers");
              assert.deepEqual(
                run?.workflowSteps.map(({ name }) => name),
                steps,
              );
              assert.deepEqual(
                await queryAutomationReplica(
                  handle,
                  `SELECT "name" FROM steps ORDER BY "createdAt", "position"`,
                ),
                steps.map((name) => ({ name })),
              );
              assert.deepEqual(
                await queryAutomationReplica(
                  handle,
                  `SELECT "eventType", "interfaceStepKey" FROM workflow_waits`,
                ),
                [{ eventType: "survey-answered", interfaceStepKey: "do:question 6" }],
              );
            },
          ),
        ],
      }),
    );
  });

  test("lists the agents its events define, with what each did over the last day", async () => {
    const start = Date.now();
    const twoDaysLater = start + 2 * DAY_MS;
    const minuteBefore = twoDaysLater - 60_000;

    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        env: { codemode: createCodemodeNodeExecutor(codemodeServer) },
        name: "agents are defined, answer, get cut off, stop, change, and go over two days",
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ when, then }) => [
          when.automation.ingestEvent(piEvent("old", "turn.completed", "assistant", start)),
          when.automation.ingestEvent(piEvent("reviewer", "agent.created", "reviewer", start)),
          when.automation.ingestEvent(piEvent("drafter", "agent.created", "drafter", start)),
          when.time.advance("2 days"),
          when.automation.ingestEvent(
            piEvent("answered", "turn.completed", "assistant", minuteBefore),
          ),
          when.automation.ingestEvent(
            piEvent("cut-off", "turn.aborted", "assistant", minuteBefore),
          ),
          // A steer Pi placed in its turn no longer waits; work queued while stopped does.
          when.automation.ingestEvent(
            requestEvent("steer-added", "queue.added", "steer", minuteBefore, { type: "steer" }),
          ),
          when.automation.ingestEvent(
            requestEvent("steer-started", "turn.started", "steer", minuteBefore, {}),
          ),
          when.automation.ingestEvent(
            requestEvent("taken-added", "queue.added", "taken", minuteBefore, { type: "prompt" }),
          ),
          when.automation.ingestEvent(
            requestEvent("taken-dispatched", "queue.dispatched", "taken", minuteBefore, {
              turnRequestId: "taken",
            }),
          ),
          // Before the queued work: events in one instant order by when they were stored, which can tie.
          when.automation.ingestEvent(piEvent("stop", "agent.stopped", "assistant", minuteBefore)),
          when.automation.ingestEvent(
            requestEvent("waiting-added", "queue.added", "waiting", twoDaysLater, {
              type: "notification",
            }),
          ),
          when.automation.ingestEvent(
            piEvent("revised", "agent.updated", "reviewer", minuteBefore, "Approves changes."),
          ),
          when.automation.ingestEvent(piEvent("gone", "agent.deleted", "drafter", minuteBefore)),
          then.assert(
            "built-in agents come first, each agent's latest definition and event stand, and only the last day's turns count",
            async (ctx) => {
              assert.deepEqual((await readDashboard(ctx)).agents, [
                "assistant (General-purpose Back): queued, 2 turns in 1 hours; 1 queued · paused",
                "reviewer (Approves changes.): updated, 0 turns in 0 hours",
              ]);
            },
          ),
          then.assert(
            "the example home page shows the agents as the dashboard does",
            async (ctx) => {
              await assertHomePageMatchesDashboard(ctx);
            },
          ),
          then.assert("the Agents directory lists each agent with its turns", async (ctx) => {
            assert.deepEqual(await readAgentDirectory(ctx), [
              "assistant (built in): Answering, 1 queued, paused; turns 2",
              "reviewer: Definition updated, 0 queued; turns none",
            ]);
          }),
        ],
      }),
    );
  });
});
