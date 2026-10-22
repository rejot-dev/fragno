import { afterAll, assert, beforeAll, describe, test, vi } from "vitest";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import type { CodemodeExecutor } from "@fragno-dev/codemode/execution/codemode-activation-contract";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/remote/codemode-node-executor";
import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import * as ts from "typescript";

import { createStateStore } from "@json-render/react";
import { queryOnce } from "@tanstack/react-db";

import { artifactBuildPath } from "@/artifacts/build-cache.server";
import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeUiLinkTarget } from "@/backoffice-ui/components/link";
import { BackofficeUiStoreRenderer } from "@/backoffice-ui/renderer";
import { STATIC_CODEMODE_CONTENT } from "@/files/content/static-codemode";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";

import { loadPage } from "./build.server";
import { pageDataPath, pageValuePath, type PageDefinition, type PageLoad } from "./definition";
import { pageQuery, pageRows, pageValue, type PageData } from "./query";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

// Building imports the saved source, which needs a compiler that bundles saved modules.
let codemodeServer: Awaited<ReturnType<typeof createCodemodeTestServer>>;
// While set, every codemode run fails as if the bridge were unreachable.
let outage: string | null = null;
beforeAll(async () => {
  codemodeServer = await createCodemodeTestServer();
});
afterAll(async () => {
  await codemodeServer?.close();
});

const orgId = "org-1";
const scope = { kind: "org" as const, orgId };
const SOURCE_PATH = "/workspace/reports/operations.page.js";

const operationsPage = `export default page.define(({ collections, from, and, eq, gte, not, isNull, coalesce, count, max, intervals, bucket, now }) => {
  const day = now.minus("24 hours");
  const runs = collections.workflowInstances;

  const started = from({ run: runs })
    .where(({ run }) => gte(run.createdAt, day))
    .select(({ run }) => ({ total: count(run.id) }));

  const recent = from({ run: runs })
    .orderBy(({ run }) => run.createdAt, "desc")
    .limit(2)
    .select(({ run }) => ({ run: run.instanceId, workflow: run.remoteWorkflowName, status: run.status }));

  const failing = from({ run: runs })
    .where(({ run }) => and(eq(run.status, "errored"), gte(run.createdAt, day)))
    .groupBy(({ run }) => coalesce(run.remoteWorkflowName, run.workflowName))
    .select(({ run }) => ({
      workflow: coalesce(run.remoteWorkflowName, run.workflowName),
      errored: count(run.id),
      lastFailure: max(run.createdAt),
    }));

  // The window starts a minute after the oldest run, inside its hour, so the bucket excludes it.
  const hours = intervals({ every: "1 hour", since: now.minus("119 minutes") });
  const hourly = from({ run: runs })
    .where(({ run }) => not(isNull(bucket(run.createdAt, hours))))
    .groupBy(({ run }) => bucket(run.createdAt, hours))
    .select(({ run }) => ({ hour: bucket(run.createdAt, hours), runs: count(run.id) }))
    .orderBy(({ run }) => bucket(run.createdAt, hours), "asc");

  return ui.stack({ gap: "md" }, [
    ui.metric({ label: "Runs today", value: started.value("total", 0) }),
    ui.table({
      caption: "Recent runs",
      columns: [
        { key: "run", label: "Run" },
        { key: "workflow", label: "Workflow" },
        { key: "status", label: "Status" },
      ],
      rows: recent,
    }),
    ui.table({
      caption: "Failing workflows",
      columns: [
        { key: "workflow", label: "Workflow" },
        { key: "errored", label: "Errored" },
      ],
      rows: failing,
    }),
    ui.table({ caption: "Runs per hour", columns: [{ key: "runs", label: "Runs" }], rows: hourly }),
  ]);
});
`;

/**
 * The home page's Automations panel and attention list: one row per workflow with its latest run,
 * a sparkline of starts per hour, and links, read from a grouped subquery with nested rows.
 */
const automationsPage = `export default page.define(({ collections, from, many, unionAll, intervals, bucket, now, and, eq, gt, gte, add, divide, coalesce, count, sum, max, caseWhen }) => {
  const day = now.minus("24 hours");
  const hours = intervals({ every: "1 hour", since: day });
  const runs = from({ run: collections.workflowInstances }).select(({ run }) => ({
    id: run.id,
    workflow: coalesce(run.remoteWorkflowName, run.workflowName),
    workflowName: run.workflowName,
    instanceId: run.instanceId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }));
  const workflows = from({ run: runs })
    .groupBy(({ run }) => run.workflow)
    .select(({ run }) => ({
      workflow: run.workflow,
      started: count(run.id),
      completed: sum(caseWhen(eq(run.status, "complete"), 1, 0)),
      errored: sum(caseWhen(eq(run.status, "errored"), 1, 0)),
      lastActivity: max(run.updatedAt),
    }));
  const health = from({ workflow: workflows })
    .orderBy(({ workflow }) => workflow.lastActivity, "desc")
    .orderBy(({ workflow }) => workflow.workflow, "asc")
    .select(({ workflow }) => ({
      workflow: workflow.workflow,
      started: workflow.started,
      errored: workflow.errored,
      successRate: caseWhen(
        gt(add(workflow.completed, workflow.errored), 0),
        divide(workflow.completed, add(workflow.completed, workflow.errored)),
      ),
      rateTone: caseWhen(gt(workflow.errored, 0), "failed", "live"),
      latest: many(
        from({ run: runs })
          .where(({ run }) => eq(run.workflow, workflow.workflow))
          .orderBy(({ run }) => run.updatedAt, "desc")
          .limit(1)
          .select(({ run }) => ({
            workflowName: run.workflowName,
            instanceId: run.instanceId,
            status: run.status,
            tone: caseWhen(eq(run.status, "errored"), "failed", eq(run.status, "complete"), "live", "waiting"),
            updatedAt: run.updatedAt,
          })),
      ),
      hourly: many(
        from({ run: runs })
          .where(({ run }) => and(eq(run.workflow, workflow.workflow), gte(run.createdAt, day)))
          .groupBy(({ run }) => bucket(run.createdAt, hours))
          .select(({ run }) => ({ hour: bucket(run.createdAt, hours), runs: count(run.id) })),
      ),
    }));
  const attention = from({
    item: unionAll(
      from({ waiting: runs })
        .where(({ waiting }) => eq(waiting.status, "waiting"))
        .select(({ waiting }) => ({ title: waiting.workflow, detail: "Waiting for an event", at: waiting.updatedAt })),
      from({ failed: runs })
        .where(({ failed }) => eq(failed.status, "errored"))
        .select(({ failed }) => ({ title: failed.workflow, detail: "Errored", at: failed.updatedAt })),
    ),
  })
    .orderBy(({ item }) => item.at, "desc")
    .limit(10)
    .select(({ item }) => ({
      title: item.title,
      detail: item.detail,
      at: item.at,
      icon: caseWhen(eq(item.detail, "Errored"), "alert-triangle", "pause-circle"),
      tone: caseWhen(eq(item.detail, "Errored"), "failed", "waiting"),
    }));

  return ui.grid({ columns: "main-side", gap: "lg" }, [
    ui.stack({ gap: "md" }, [
      ui.metric({ label: "Workflows", value: from({ workflow: workflows }).select(({ workflow }) => ({ total: count(workflow.workflow) })).value("total", 0) }),
      ui.section({ label: "Automations" }, [
        ui.stack({ gap: "sm" }, ui.each(health, (row) =>
          ui.grid({ columns: 4, gap: "sm" }, [
            ui.link({
              label: row.workflow,
              to: { kind: "run", workflowName: row.latest[0].workflowName, instanceId: row.latest[0].instanceId },
            }),
            ui.sparkBars({ label: "Starts per hour", rows: row.hourly, axis: { field: "hour", intervals: hours }, value: "runs" }),
            ui.number({ value: row.successRate, format: "percent", tone: row.rateTone }),
            ui.badge({ label: row.latest[0].status, tone: row.latest[0].tone }),
            ui.relativeTime({ time: row.latest[0].updatedAt }),
            ui.when(ui.is(row.errored, { gt: 0 }), ui.text({ text: "Has errored runs" })),
          ]),
        )),
      ]),
    ]),
    ui.stack({ gap: "md" }, [
      ui.section({ label: "Needs attention" }, [
        ui.stack({ gap: "sm" }, ui.each(attention, (item) =>
          ui.stack({ gap: "sm", direction: "row", justify: "between" }, [
            ui.stack({ gap: "sm", direction: "row" }, [
              ui.icon({ name: item.icon, tone: item.tone }),
              ui.stack({ gap: "sm" }, [ui.text({ text: item.title }), ui.text({ text: item.detail, tone: "muted" })]),
            ]),
            ui.relativeTime({ time: item.at }),
          ]),
        )),
      ]),
      ui.link({ label: "Integrations", to: { kind: "integrations" } }),
    ]),
  ]);
});
`;

/** Binds a JSON field, which declarations type as unknown, to a metric's value. */
const paramsMetricPage = `export default page.define(({ collections, from }) =>
  ui.metric({
    label: "Newest params",
    value: from({ run: collections.workflowInstances }).orderBy(({ run }) => run.createdAt, "desc").limit(1).value("params", "none"),
  }),
);
`;

const newestRunPage = `export default page.define(({ collections, from }) =>
  ui.table({
    caption: "Newest run",
    columns: [{ key: "instanceId", label: "Run" }],
    rows: from({ run: collections.workflowInstances }).orderBy(({ run }) => run.createdAt, "desc").limit(1),
  }),
);
`;

const workflows = {
  "automations/ship-order.workflow.js": `export default defineWorkflow({ name: "ship-order" }, async (event, step) => {
  await step.do("ship", async () => "shipped");
});`,
  "automations/await-shipment.workflow.js": `export default defineWorkflow({ name: "await-shipment" }, async (event, step) => {
  await step.waitForEvent("shipment", { type: "shipped", timeout: "7 days" });
});`,
  "automations/charge-card.workflow.js": `export default defineWorkflow({ name: "charge-card" }, async (event, step) => {
  await step.do("charge", { retries: { limit: 0, delay: 0 } }, async () => {
    throw new Error("card declined");
  });
});`,
};

/** The test bridge, unless an outage is in progress. */
function codemodeEnv() {
  const executor = createCodemodeNodeExecutor(codemodeServer);
  const codemode: CodemodeExecutor = async (activation, host) => {
    if (outage !== null) {
      return { status: "interrupted", cause: outage };
    }
    return await executor(activation, host);
  };
  return { codemode };
}

function startRun(workflow: string, instanceId: string) {
  return {
    orgId,
    instanceId,
    path: `/workspace/automations/${workflow}.workflow.js`,
    event: (ctx: BackofficeScenarioContext): AutomationEvent => ({
      id: `trigger-${instanceId}`,
      scopeRestriction: null,
      scope,
      source: "shop",
      eventType: "order.manual",
      occurredAt: new Date(ctx.runtime.now()).toISOString(),
      // Payloads are JSON, whose fields may start with $ as TanStack's virtual fields do.
      payload: { $schema: "https://example.com/order.json", instanceId },
      actors: createBackofficeSystemExecution(scope).actors,
      subject: { orgId },
      causation: { kind: "origin" },
    }),
  } as const;
}

/**
 * Type-checks a page source against the static codemode declarations with js.check's
 * options; scenarios have no compiler service to run js.check itself.
 */
function checkPageSource(source: string): string[] {
  const files = new Map<string, string>([
    ...Object.entries(STATIC_CODEMODE_CONTENT).map(
      ([path, content]) => [`/static/${path}`, String(content)] as const,
    ),
    [SOURCE_PATH, source] as const,
  ]);
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const program = ts.createProgram([...files.keys()], options, {
    ...host,
    fileExists: (name) => files.has(name) || host.fileExists(name),
    readFile: (name) => files.get(name) ?? host.readFile(name),
    getSourceFile: (name, languageVersion, onError) => {
      const content = files.get(name);
      return content === undefined
        ? host.getSourceFile(name, languageVersion, onError)
        : ts.createSourceFile(name, content, languageVersion);
    },
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

/** Saves the source as an agent does. */
async function writeSource(ctx: BackofficeScenarioContext, source: string) {
  await ctx.runCodemode({
    scope,
    code: `async () => await state.writeFile({ path: ${JSON.stringify(SOURCE_PATH)}, content: ${JSON.stringify(source)} })`,
  });
}

/**
 * Writes the source and runs the skill's checks: js.check's diagnostics, and artifacts.buildPage,
 * which builds the page as its route does and reports the error viewers would see.
 */
async function writePage(ctx: BackofficeScenarioContext, source: string) {
  await writeSource(ctx, source);
  const build = await ctx.runCodemode({
    scope,
    code: `async () => await artifacts.buildPage({ path: ${JSON.stringify(SOURCE_PATH)} })`,
  });
  // The tool's output schema has validated the result.
  const built = build.result as { status: "built" } | { status: "failed"; message: string };
  return {
    diagnostics: checkPageSource(source),
    verifyError: built.status === "failed" ? built.message : null,
  };
}

/** Loads the page as its route does, building it when the cache does not match. */
async function loadBuiltPage(ctx: BackofficeScenarioContext): Promise<PageLoad> {
  return await loadPage({
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeSystemExecution(scope),
    sourcePath: SOURCE_PATH,
  });
}

/** The outcome the system cached for the page. */
async function cachedOutcome(ctx: BackofficeScenarioContext): Promise<string> {
  const build = await ctx.runCodemode({
    scope,
    code: `async () => (await state.readJson({ path: ${JSON.stringify(artifactBuildPath(SOURCE_PATH))} })).outcome.kind`,
  });
  return build.result as string;
}

/** Where the scenario's links lead, so assertions read which target each link names. */
function testLinks(target: BackofficeUiLinkTarget): string {
  if (target.kind === "run") {
    return `/runs/${target.workflowName}/${target.instanceId}`;
  }
  return "id" in target ? `/${target.kind}s/${target.id}` : `/${target.kind}`;
}

/**
 * Renders a built page the way its route does, with each query's live results run once, and
 * returns the markup with each query's rows.
 */
async function renderPage(ctx: BackofficeScenarioContext, definition: PageDefinition) {
  const { queries, values, spec } = definition;
  const database = ctx.tanstack.automations.forOrg(orgId);
  await database.drain();

  const now = ctx.runtime.now();
  const store = createStateStore({});
  const data: Record<string, PageData[]> = {};
  for (const [name, query] of Object.entries(queries)) {
    const rows = pageRows(
      await queryOnce((builder) => pageQuery(builder, database.collections, query, now)),
    );
    data[name] = rows;
    store.set(pageDataPath(name), rows);
    for (const [valueName, value] of Object.entries(values)) {
      if (value.query === name) {
        store.set(pageValuePath(valueName), pageValue(value, rows));
      }
    }
  }
  // Links render as router links, as they do inside the app.
  const markup = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(BackofficeUiStoreRenderer, { spec, store, now, links: testLinks }),
    ),
  );
  return { markup, data };
}

/** Each table's rows by caption, as cell text joined with " | ". */
function tables(markup: string): Record<string, string[]> {
  return Object.fromEntries(
    [
      ...markup.matchAll(
        /<table[^>]*>.*?<caption[^>]*>(.*?)<\/caption>.*?<tbody[^>]*>(.*?)<\/tbody>/g,
      ),
    ].map(([, caption, body]) => [
      caption,
      [...(body ?? "").matchAll(/<tr>(.*?)<\/tr>/g)].map(([, row]) =>
        [...(row ?? "").matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(([, cell]) => cell).join(" | "),
      ),
    ]),
  );
}

/**
 * Each Automations row as "workflow -> link | last bars | badge tone and label | time | note",
 * where bars show 1 for an hour with starts.
 */
function automationRows(markup: string): string[] {
  return [
    ...markup.matchAll(
      /<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a><span role="img" aria-label="Starts per hour"[^>]*>((?:<span[^>]*><\/span>)*)<\/span><span(?: data-tone="(\w+)")?[^>]*>([^<]+)<\/span><span[^>]*data-tone="(\w+)"[^>]*>([^<]+)<\/span><time[^>]*>([^<]+)<\/time>(?:<p[^>]*>([^<]+)<\/p>)?/g,
    ),
  ].map(([, href, workflow, bars, rateTone, rate, tone, status, time, note]) => {
    const heights = [...(bars ?? "").matchAll(/height:([^"]+)"/g)].map(([, height]) =>
      height === "1px" ? "0" : "1",
    );
    assert.lengthOf(heights, 25);
    return [
      `${workflow} -> ${href}`,
      `...${heights.slice(-3).join("")}`,
      rateTone ? `${rateTone} ${rate}` : rate,
      `${tone} ${status}`,
      time,
      ...(note ? [note] : []),
    ].join(" | ");
  });
}

/** Each attention item as "icon tone | title: detail | time". */
function attentionItems(markup: string): string[] {
  const section = markup.slice(markup.indexOf('aria-label="Needs attention"'));
  return [
    ...section.matchAll(
      /<span data-tone="(\w+)"[^>]*><svg[^>]*>.*?<\/svg><\/span><div[^>]*><p[^>]*>([^<]+)<\/p><p[^>]*>([^<]+)<\/p><\/div><\/div><time[^>]*>([^<]+)<\/time>/g,
    ),
  ].map(([, tone, title, detail, time]) => `${tone} | ${title}: ${detail} | ${time}`);
}

describe("workspace pages", () => {
  test("a page built from its source shows live counts, groups, and hourly buckets", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: allLocalObjects,
        env: codemodeEnv(),
        name: "an operations page over the scope's workflow runs",
        files: backofficeFiles.custom({ workspace: workflows }),
        // charge-card fails on purpose, so the page has a failing workflow to group.
        options: { allowErroredWorkflows: true },
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ when, then }) => [
          when.workflow.createInstance(startRun("ship-order", "ship-1")),
          when.time.advance("1 hour"),
          when.workflow.createInstance(startRun("await-shipment", "shipment-1")),
          when.time.advance("1 hour"),
          when.workflow.createInstance(startRun("charge-card", "charge-1")),
          when.workflow.createInstance(startRun("ship-order", "ship-2")),
          then.assert("the source checks against the declarations and verifies", async (ctx) => {
            const { diagnostics, verifyError } = await writePage(ctx, operationsPage);
            assert.deepEqual(diagnostics, [], diagnostics.join("\n"));
            assert.equal(verifyError, null);
          }),
          then.assert("the route builds the page and renders its results", async (ctx) => {
            const loaded = await loadBuiltPage(ctx);
            assert(loaded.kind === "ready", JSON.stringify(loaded));
            assert.equal(await cachedOutcome(ctx), "built");
            const { markup } = await renderPage(ctx, loaded.definition);
            assert.include(markup, "Runs today");
            assert.match(markup, />4</);
            assert.deepEqual(tables(markup), {
              "Recent runs": ["ship-2 | ship-order | complete", "charge-1 | charge-card | errored"],
              "Failing workflows": ["charge-card | 1"],
              "Runs per hour": ["1", "2"],
            });
          }),
          then.assert("an edited source replaces the cached build", async (ctx) => {
            await writePage(ctx, newestRunPage);
            const loaded = await loadBuiltPage(ctx);
            assert(loaded.kind === "ready", JSON.stringify(loaded));
            assert.deepEqual(tables((await renderPage(ctx, loaded.definition)).markup), {
              "Newest run": ["ship-2"],
            });
          }),
        ],
      }),
    );
  });

  test("a page rebuilds the home page's automations panel from nested and merged rows", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: allLocalObjects,
        env: codemodeEnv(),
        name: "an automations page with a row per workflow and an attention list",
        files: backofficeFiles.custom({ workspace: workflows }),
        options: { allowErroredWorkflows: true },
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ when, then }) => [
          when.workflow.createInstance(startRun("ship-order", "ship-1")),
          when.time.advance("1 hour"),
          when.workflow.createInstance(startRun("await-shipment", "shipment-1")),
          when.time.advance("1 hour"),
          when.workflow.createInstance(startRun("charge-card", "charge-1")),
          when.workflow.createInstance(startRun("ship-order", "ship-2")),
          then.assert("the source checks against the declarations and verifies", async (ctx) => {
            const { diagnostics, verifyError } = await writePage(ctx, automationsPage);
            assert.deepEqual(diagnostics, [], diagnostics.join("\n"));
            assert.equal(verifyError, null);
          }),
          then.assert(
            "each workflow row shows its latest run, hourly starts, success rate, and errors",
            async (ctx) => {
              const loaded = await loadBuiltPage(ctx);
              assert(loaded.kind === "ready", JSON.stringify(loaded));
              const { markup } = await renderPage(ctx, loaded.definition);
              assert.match(markup, /aria-label="Workflows"[^>]*>.*?<p[^>]*>3<\/p>/);
              // Bars run oldest to newest over 25 hourly intervals; ship-order started 2 hours apart.
              assert.deepEqual(automationRows(markup), [
                "ship-order -> /runs/codemode-script/ship-2 | ...101 | live 100% | live complete | now",
                "charge-card -> /runs/codemode-script/charge-1 | ...001 | failed 0% | failed errored | now | Has errored runs",
                "await-shipment -> /runs/codemode-script/shipment-1 | ...010 | — | waiting waiting | 1h ago",
              ]);
              assert.deepEqual(attentionItems(markup), [
                "failed | charge-card: Errored | now",
                "waiting | await-shipment: Waiting for an event | 1h ago",
              ]);
              // Details sit beside a narrow side column, which ends in the scope's integrations.
              assert.include(markup, "xl:grid-cols-[minmax(0,1fr)_22rem]");
              assert.include(markup, 'href="/integrations"');
            },
          ),
          then.assert(
            "bound data that does not fit a prop shows the mismatch in its place",
            async (ctx) => {
              // params is JSON, which the declarations type as unknown, so only rendering can tell.
              await writePage(ctx, paramsMetricPage);
              const loaded = await loadBuiltPage(ctx);
              assert(loaded.kind === "ready", JSON.stringify(loaded));
              const { markup, data } = await renderPage(ctx, loaded.definition);
              assert.include(markup, "Metric cannot show its data");
              assert.match(markup, /value: Invalid input/);
              const [newest] = Object.values(data).flat();
              assert.include(JSON.stringify(newest), '"$schema":"https://example.com/order.json"');
              assert.notInclude(JSON.stringify(newest), '"$synced"');
            },
          ),
          then.assert("merged queries that share an alias fail the build", async (ctx) => {
            const { verifyError } = await writePage(
              ctx,
              automationsPage.replaceAll("waiting", "run").replaceAll("failed", "run"),
            );
            assert.include(verifyError, "The query from item cannot run in TanStack DB");
            assert.include(verifyError, '"run"');
          }),
          then.assert(
            "nested rows that do not match the selecting row by eq fail the build",
            async (ctx) => {
              const { verifyError } = await writePage(
                ctx,
                automationsPage.replace(
                  ".where(({ run }) => eq(run.workflow, workflow.workflow))",
                  ".where(({ run }) => gte(run.workflow, workflow.workflow))",
                ),
              );
              assert.include(verifyError, "The query from workflow cannot run in TanStack DB");
              assert.include(verifyError, '"latest"');
            },
          ),
        ],
      }),
    );
  });

  test("a misspelled field fails the check and the route with the collection's fields", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: allLocalObjects,
        env: codemodeEnv(),
        name: "a page source that reads a field its collection lacks",
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert("the check, the verification, and the route name the field", async (ctx) => {
            const { diagnostics, verifyError } = await writePage(
              ctx,
              `export default page.define(({ collections, from }) =>
  ui.table({
    caption: "Runs",
    columns: [{ key: "status", label: "Status" }],
    rows: from({ run: collections.workflowInstances }).orderBy(({ run }) => run.statsu, "desc").limit(5),
  }),
);
`,
            );
            assert.include(diagnostics.join("\n"), "Property 'statsu' does not exist");
            const fieldError = 'workflowInstances has no "statsu" field. Fields: id, workflowName';
            assert.include(verifyError, fieldError);
            const loaded = await loadBuiltPage(ctx);
            assert(loaded.kind === "failed", JSON.stringify(loaded));
            assert.include(loaded.message, fieldError);
            assert.equal(await cachedOutcome(ctx), "failed");
          }),
        ],
      }),
    );
  });

  test("a grouped query that selects an ungrouped field fails verification and the route", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: allLocalObjects,
        env: codemodeEnv(),
        name: "events grouped by time that select their type",
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert("the verification and the route name the field and the fix", async (ctx) => {
            // TanStack DB rejects it as the build compiles the query, before any row arrives.
            const { diagnostics, verifyError } = await writePage(
              ctx,
              `export default page.define(({ collections, from, count }) =>
  ui.barChart({
    label: "Events by day and type",
    rows: from({ event: collections.events })
      .groupBy(({ event }) => event.occurredAt)
      .select(({ event }) => ({ day: event.occurredAt, events: count(event.id), series: event.eventType })),
    axis: { field: "day" },
    value: "events",
    series: "series",
  }),
);
`,
            );
            assert.deepEqual(diagnostics, [], diagnostics.join("\n"));
            const ungrouped =
              "The query from events is grouped, so it selects and filters only its group keys";
            assert.include(verifyError, ungrouped);
            assert.include(verifyError, "'series'");
            const loaded = await loadBuiltPage(ctx);
            assert(loaded.kind === "failed", JSON.stringify(loaded));
            assert.include(loaded.message, ungrouped);
          }),
        ],
      }),
    );
  });

  test("an outage fails the page without caching; builds before it are served from the cache", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: allLocalObjects,
        env: codemodeEnv(),
        name: "a page opened while codemode is unreachable",
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert("the page fails while codemode is down", async (ctx) => {
            await writeSource(ctx, newestRunPage);
            outage = "CODEMODE_CONNECTION_FAILED";
            try {
              const loaded = await loadBuiltPage(ctx);
              assert(loaded.kind === "failed", JSON.stringify(loaded));
              assert.include(loaded.message, "CODEMODE_CONNECTION_FAILED");
            } finally {
              outage = null;
            }
          }),
          then.assert("the next view builds the page", async (ctx) => {
            const loaded = await loadBuiltPage(ctx);
            assert(loaded.kind === "ready", JSON.stringify(loaded));
            assert.equal(await cachedOutcome(ctx), "built");
          }),
          then.assert(
            "a page the agent built opens from the cache without codemode",
            async (ctx) => {
              const { verifyError } = await writePage(ctx, paramsMetricPage);
              assert.equal(verifyError, null);
              outage = "CODEMODE_CONNECTION_FAILED";
              try {
                const loaded = await loadBuiltPage(ctx);
                assert(loaded.kind === "ready", JSON.stringify(loaded));
              } finally {
                outage = null;
              }
            },
          ),
        ],
      }),
    );
  });

  test("an import the build or the verification cannot load names how to fix it", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: allLocalObjects,
        env: codemodeEnv(),
        name: "a page that imports a deleted helper, then a verification that imports by variable",
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert("the route reports the import as the page's error", async (ctx) => {
            await writePage(ctx, `import { caption } from "./helpers.js";\n${newestRunPage}`);
            const loaded = await loadBuiltPage(ctx);
            assert(loaded.kind === "failed", JSON.stringify(loaded));
            assert.include(loaded.message, `${SOURCE_PATH}:1:`);
            assert.include(loaded.message, "Import './helpers.js' cannot be read");
          }),
          then.assert("verifying through a variable path names how to import it", async (ctx) => {
            // The write and the import share a call, and the import names a variable, so the
            // program is not given the module.
            const error = await ctx
              .runCodemode({
                scope,
                code: `async () => {
  const path = ${JSON.stringify(SOURCE_PATH)};
  await state.writeFile({ path, content: ${JSON.stringify(newestRunPage)} });
  return (await import(path)).default;
}`,
              })
              .then(
                () => null,
                (failure: unknown) =>
                  failure instanceof Error ? failure.message : String(failure),
              );
            assert.include(
              error,
              `Import "${SOURCE_PATH}" was not loaded. A program imports saved modules found before it runs, so name the path as a string literal, such as import("${SOURCE_PATH}"), and import a module in a later call than the one that writes it.`,
            );
          }),
        ],
      }),
    );
  });
});
