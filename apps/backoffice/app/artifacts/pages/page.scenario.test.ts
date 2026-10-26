import { afterAll, assert, beforeAll, describe, test, vi } from "vitest";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import type { CodemodeExecutor } from "@fragno-dev/codemode/execution/codemode-activation-contract";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/remote/codemode-node-executor";
import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";
import type { BackofficeUiLinkTarget } from "@fragno-private/backoffice-ui/link";
import {
  pageDataPath,
  pageValuePath,
  type PageDefinition,
  type PageLoad,
} from "@fragno-private/backoffice-ui/pages/definition";
import { pageRows, pageValue, type PageData } from "@fragno-private/backoffice-ui/pages/rows";
import { BackofficeUiStoreRenderer } from "@fragno-private/backoffice-ui/renderer";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { createStateStore } from "@json-render/react";

import { artifactBuildPath } from "@/artifacts/build-cache.server";
import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { GENERAL_SKILL_CONTENT } from "@/files/content/skills";
import { readAutomationPageQuery } from "@/fragno/automation/lofi/testing";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { listPageSources } from "@/routes/backoffice/pages/load.server";

import { loadPage } from "./build.server";
import { checkPageSource } from "./page-source.test-support";

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
const scope = { kind: "org" as const, orgId, jurisdiction: null };
const SOURCE_PATH = "/workspace/reports/operations.page.js";

const operationsPage = `export default page.define({ title: "Operations" }, ({ sql, now, intervals, bucket }) => {
  const day = now.minus("24 hours");

  const started = sql\`SELECT count(*) AS total FROM runs WHERE createdAt >= \${day}\`.columns({ total: "number" });

  // Runs created in the same millisecond tie on createdAt, so the instance ID orders them.
  const recent = sql\`
    SELECT instanceId AS run, remoteWorkflowName AS workflow, status FROM runs
    ORDER BY createdAt DESC, instanceId DESC LIMIT 2
  \`.columns({ run: "string", workflow: "string?", status: "string" });

  const failing = sql\`
    SELECT coalesce(remoteWorkflowName, workflowName) AS workflow, count(*) AS errored,
      max(createdAt) AS lastFailure
    FROM runs WHERE status = \${"errored"} AND createdAt >= \${day}
    GROUP BY 1
  \`.columns({ workflow: "string", errored: "number", lastFailure: "time" });

  // The window starts a minute after the oldest run, inside its hour, so the bucket excludes it.
  const hours = intervals({ every: "1 hour", since: now.minus("119 minutes") });
  const hourly = sql\`
    SELECT hour, count(*) AS runs FROM (SELECT \${bucket("createdAt", hours)} AS hour FROM runs)
    WHERE hour IS NOT NULL GROUP BY hour ORDER BY hour
  \`.columns({ hour: "time", runs: "number" });

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
 * Each workflow with its runs nested as JSON rows, whose times decode like a column's, and a
 * shared query read as a CTE.
 */
const nestedRunsPage = `export default page.define({ title: "Runs by workflow" }, ({ sql }) => {
  const runs = sql\`SELECT coalesce(remoteWorkflowName, workflowName) AS workflow, instanceId, status, createdAt FROM runs\`;
  const workflows = sql\`
    WITH run AS (\${runs})
    SELECT workflow,
      json_group_array(json_object('instanceId', instanceId, 'createdAt', createdAt)
        ORDER BY instanceId) AS runs
    FROM run GROUP BY workflow ORDER BY workflow
  \`.columns({ workflow: "string", runs: { rows: { instanceId: "string", createdAt: "time" } } });
  return ui.rowList(
    {},
    ui.each(workflows, (workflow) =>
      ui.listRow({ title: workflow.workflow, detail: workflow.runs[0].instanceId }, [
        ui.relativeTime({ time: workflow.runs[0].createdAt }),
      ]),
    ),
  );
});
`;

/** Binds a JSON column, which declarations type as unknown, to a metric's value. */
const paramsMetricPage = `export default page.define({ title: "Order params" }, ({ sql }) =>
  ui.metric({
    label: "Newest params",
    value: sql\`SELECT params FROM runs ORDER BY createdAt DESC LIMIT 1\`.columns({ params: "json" }).value("params", "none"),
  }),
);
`;

const newestRunPage = `export default page.define({ title: "Newest run" }, ({ sql }) =>
  ui.table({
    caption: "Newest run",
    columns: [{ key: "instanceId", label: "Run" }],
    rows: sql\`SELECT instanceId FROM runs ORDER BY createdAt DESC, instanceId DESC LIMIT 1\`.columns({ instanceId: "string" }),
  }),
);
`;

/** The example the building-pages skill walks through. */
const skillExamplePage = /```js\n(.*?)```/su.exec(
  String(GENERAL_SKILL_CONTENT["skills/building-pages/SKILL.md"]),
)![1]!;

/** A page with one query, whose SQL and columns a test fills in. */
const queryPage = (query: string, columns = '{ instanceId: "string" }') =>
  `export default page.define({ title: "Query" }, ({ sql }) =>
  ui.table({
    caption: "Rows",
    columns: [{ key: "instanceId", label: "Run" }],
    rows: sql\`${query}\`.columns(${columns}),
  }),
);
`;

/** A page written for the builder of version 4, which queried TanStack DB's collections. */
const tanstackPage = `export default page.define({ title: "Old" }, ({ collections, from }) =>
  ui.table({
    caption: "Runs",
    columns: [{ key: "status", label: "Status" }],
    rows: from({ run: collections.workflowInstances }),
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
      // Payloads are JSON, whose fields may start with $.
      payload: { $schema: "https://example.com/order.json", instanceId },
      actors: createBackofficeSystemExecution(scope).actors,
      subject: { scope: { kind: "org", orgId, jurisdiction: null } },
      causation: { kind: "origin" },
    }),
  } as const;
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
    diagnostics: checkPageSource(SOURCE_PATH, source),
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
 * Renders a built page the way its route does, with each query's results read through the
 * scope's replica, and returns the markup with each query's rows.
 */
async function renderPage(ctx: BackofficeScenarioContext, definition: PageDefinition) {
  const { queries, values, spec } = definition;
  const handle = ctx.lofi.automations.forOrg(orgId);
  await handle.drain();

  const now = ctx.runtime.now();
  const store = createStateStore({});
  const data: Record<string, PageData[]> = {};
  for (const [name, query] of Object.entries(queries)) {
    const rows = pageRows(query, await readAutomationPageQuery(handle.replica, query, now));
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
      createElement(BackofficeUiStoreRenderer, {
        spec,
        store,
        now,
        links: testLinks,
        // These pages place no widgets; the overview scenario checks a page that does.
        widgets: {
          orchestration: () => null,
          workflowResponse: () => null,
        },
      }),
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
            assert.equal(loaded.definition.title, "Operations");
            const { markup } = await renderPage(ctx, loaded.definition);
            assert.include(markup, "Runs today");
            assert.match(markup, />4</);
            assert.deepEqual(tables(markup), {
              "Recent runs": ["ship-2 | ship-order | complete", "charge-1 | charge-card | errored"],
              "Failing workflows": ["charge-card | 1"],
              "Runs per hour": ["1", "2"],
            });
          }),
          then.assert("the dashboard offers every page in the workspace", async (ctx) => {
            await ctx.runCodemode({
              scope,
              code: `async () => await state.writeFile({ path: "/workspace/home.page.js", content: ${JSON.stringify(JSON.stringify(newestRunPage))} })`,
            });
            // Workflow sources and the cached build sit beside the pages without being pages.
            assert.deepEqual(
              await listPageSources({
                runtime: ctx.runtime.services,
                kernel: new BackofficeKernel(ctx.runtime.services),
                execution: createBackofficeSystemExecution(scope),
              }),
              ["/workspace/home.page.js", SOURCE_PATH],
            );
          }),
          then.assert(
            "the skill's example checks, builds, and shows each workflow",
            async (ctx) => {
              const { diagnostics, verifyError } = await writePage(ctx, skillExamplePage);
              assert.deepEqual(diagnostics, [], diagnostics.join("\n"));
              assert.equal(verifyError, null);
              const loaded = await loadBuiltPage(ctx);
              assert(loaded.kind === "ready", JSON.stringify(loaded));
              const { data } = await renderPage(ctx, loaded.definition);
              // The metric renders first, so its query is q0 and the table's q1.
              const health = data.q1 as { workflow: string; errored: number }[];
              assert.deepEqual(
                health.map(({ workflow, errored }) => `${workflow}: ${errored} errored`).sort(),
                ["await-shipment: 0 errored", "charge-card: 1 errored", "ship-order: 0 errored"],
              );
            },
          ),
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

  test("a page shows nested rows and JSON as their columns declare them", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: allLocalObjects,
        env: codemodeEnv(),
        name: "a page of each workflow's runs as nested rows",
        files: backofficeFiles.custom({ workspace: workflows }),
        options: { allowErroredWorkflows: true },
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ when, then }) => [
          when.workflow.createInstance(startRun("ship-order", "ship-1")),
          when.time.advance("1 hour"),
          when.workflow.createInstance(startRun("ship-order", "ship-2")),
          when.workflow.createInstance(startRun("charge-card", "charge-1")),
          then.assert("nested rows decode their times and bind to rows", async (ctx) => {
            const { diagnostics, verifyError } = await writePage(ctx, nestedRunsPage);
            assert.deepEqual(diagnostics, [], diagnostics.join("\n"));
            assert.equal(verifyError, null);
            const loaded = await loadBuiltPage(ctx);
            assert(loaded.kind === "ready", JSON.stringify(loaded));
            const { markup, data } = await renderPage(ctx, loaded.definition);
            // Times arrive as ISO strings, an hour apart for ship-order's two runs.
            const rows = Object.values(data)[0] as {
              workflow: string;
              runs: { instanceId: string; createdAt: string }[];
            }[];
            assert.deepEqual(
              rows.map(({ workflow, runs }) => [
                workflow,
                runs.map(({ instanceId }) => instanceId),
              ]),
              [
                ["charge-card", ["charge-1"]],
                ["ship-order", ["ship-1", "ship-2"]],
              ],
            );
            const [first, second] = rows[1]!.runs.map(({ createdAt }) => Date.parse(createdAt));
            assert.closeTo(second! - first!, 3_600_000, 60_000);
            assert.equal(rows[1]!.runs[0]!.createdAt, new Date(first!).toISOString());
            assert.include(markup, "1h ago");
          }),
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
            },
          ),
          then.assert(
            "a value that does not fit its declared column fails the page",
            async (ctx) => {
              const { verifyError } = await writePage(
                ctx,
                queryPage("SELECT instanceId FROM runs", '{ instanceId: "number" }'),
              );
              // The build cannot know the rows, so the page reports them as it reads them.
              assert.equal(verifyError, null);
              const loaded = await loadBuiltPage(ctx);
              assert(loaded.kind === "ready", JSON.stringify(loaded));
              const error = await renderPage(ctx, loaded.definition).then(
                () => null,
                (failure: unknown) =>
                  failure instanceof Error ? failure.message : String(failure),
              );
              assert.include(
                error,
                'Column "instanceId" of row 1 is declared "number" but holds string',
              );
            },
          ),
        ],
      }),
    );
  });

  test("SQL that cannot run fails the build and the route, naming why", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: allLocalObjects,
        env: codemodeEnv(),
        name: "page sources whose queries cannot run",
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert("a misspelled column fails the build and the route", async (ctx) => {
            const { diagnostics, verifyError } = await writePage(
              ctx,
              queryPage("SELECT instanceId FROM runs ORDER BY statsu"),
            );
            // SQL is text, so only the build sees into it.
            assert.deepEqual(diagnostics, [], diagnostics.join("\n"));
            assert.equal(verifyError, "queries.q0: no such column: statsu");
            const loaded = await loadBuiltPage(ctx);
            assert(loaded.kind === "failed", JSON.stringify(loaded));
            assert.equal(loaded.message, "queries.q0: no such column: statsu");
            assert.equal(await cachedOutcome(ctx), "failed");
          }),
          then.assert(
            "a declared column the query does not select fails the build",
            async (ctx) => {
              const { verifyError } = await writePage(
                ctx,
                queryPage("SELECT instanceId AS run FROM runs"),
              );
              assert.equal(
                verifyError,
                'queries.q0: The query declares "instanceId", which it does not select. It selects: run.',
              );
            },
          ),
          then.assert("reading a column the declarations lack fails the check", async (ctx) => {
            const { diagnostics } = await writePage(
              ctx,
              `export default page.define({ title: "Broken" }, ({ sql }) =>
  ui.rowList(
    {},
    ui.each(sql\`SELECT instanceId FROM runs\`.columns({ instanceId: "string" }), (run) =>
      ui.listRow({ title: run.statsu }, []),
    ),
  ),
);
`,
            );
            assert.include(diagnostics.join("\n"), "Property 'statsu' does not exist");
          }),
          then.assert(
            "queries read only the page relations, without writing, within limits",
            async (ctx) => {
              const failures: Record<string, string | null> = {};
              for (const [label, sql] of Object.entries({
                table: "SELECT instanceId FROM workflow_instance_workflows",
                write: "DELETE FROM agents",
                twoStatements: "SELECT instanceId FROM runs; SELECT 1",
                random: "SELECT hex(randomblob(4)) AS instanceId",
                pragma: "PRAGMA table_info(runs)",
              })) {
                failures[label] = (await writePage(ctx, queryPage(sql))).verifyError;
              }
              assert.deepEqual(failures, {
                table:
                  'queries.q0: "workflow_instance_workflows" is not a relation queries can read. Read one of: runs, steps, workflow_events, events, event_sources, event_definitions, routes, route_schedules, route_dispatches, projects, kv_store, connections, agent_turns, agents, workflow_waits.',
                write:
                  "queries.q0: Queries only read: they cannot write, attach databases, or change settings.",
                twoStatements:
                  "queries.q0: SQL holds more than one statement: SELECT instanceId FROM runs; SELECT 1",
                random: "queries.q0: Queries cannot call randomblob().",
                pragma:
                  "queries.q0: Queries only read: they cannot write, attach databases, or change settings.",
              });
            },
          ),
          then.assert(
            "a page written for the older page format names how to rewrite it",
            async (ctx) => {
              const { verifyError } = await writePage(ctx, tanstackPage);
              assert.include(
                verifyError,
                "This page is written for an older page format: its build function reads collections, which pages no longer get. Pages now query with sql`...`",
              );
            },
          ),
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
