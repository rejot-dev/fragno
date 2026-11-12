import { afterAll, assert, beforeAll, describe, test, vi } from "vitest";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import type { CodemodeExecutor } from "@fragno-dev/codemode/execution/codemode-activation-contract";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/remote/codemode-node-executor";
import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";
import type { BackofficeUiLinkTarget } from "@fragno-private/backoffice-ui/link";
import {
  pageDataPath,
  pageFilePath,
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
import { readScenarioReplicaView } from "@/fragno/lofi/scenario-replica-database";
import { readyUploadFilesView, workspaceUploadKey } from "@/fragno/upload/lofi/replica";
import { listPageSources } from "@/routes/backoffice/pages/load.server";

import { loadPage, type LoadedPage } from "./build.server";
import { pageFileData } from "./page-files";
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

/** A page of a CSV's rows, a JSON file's field, and a Markdown file's body and frontmatter. */
const filesPage = `export default page.define({ title: "Q4" }, ({ file }) => {
  const budget = file.csv("/workspace/finance/budget.csv", {
    month: "string",
    amount: "number",
    approved: "boolean",
    note: "string?",
  });
  const targets = file.json("/workspace/finance/targets.json");
  const plan = file.markdown("/workspace/ops/q4-plan.md", { owner: "string", due: "time" });

  return ui.stack({ gap: "md" }, [
    ui.metric({ label: "Revenue target", value: targets.revenue }),
    ui.table({
      caption: "Budget",
      columns: [
        { key: "month", label: "Month" },
        { key: "amount", label: "Amount" },
        { key: "note", label: "Note" },
      ],
      rows: budget,
    }),
    ui.keyValue({ columns: 1, items: [{ key: "owner", label: "Owner", value: plan.frontmatter.owner }] }),
    ui.markdown({ text: plan.body }),
  ]);
});
`;

const workspaceFiles = {
  "finance/budget.csv":
    'month,amount,approved,note\r\nOctober,1200.5,true,\r\n"November, early",900,false,"Says ""wait"""\r\n',
  "finance/targets.json": JSON.stringify({ revenue: "€50k" }),
  "ops/q4-plan.md": "---\nowner: Ada\ndue: 2026-12-01\n---\n# Q4 plan\n\nShip the tracker.\n",
};

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

/**
 * Loads the page as its route does, building it when the cache does not match, with when the build
 * it shows was written.
 */
async function loadVersionedPage(ctx: BackofficeScenarioContext): Promise<LoadedPage> {
  return await loadPage({
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeSystemExecution(scope),
    sourcePath: SOURCE_PATH,
  });
}

async function loadBuiltPage(ctx: BackofficeScenarioContext): Promise<PageLoad> {
  return (await loadVersionedPage(ctx)).page;
}

/** The outcome the system cached for the page. */
async function cachedOutcome(ctx: BackofficeScenarioContext): Promise<string> {
  const build = await ctx.runCodemode({
    scope,
    code: `async () => (await state.readJson({ path: ${JSON.stringify(artifactBuildPath(SOURCE_PATH))} })).outcome.kind`,
  });
  return build.result as string;
}

/** When the page's build was written, as a browser's Upload replica holds it. */
async function replicaBuildUpdatedAt(ctx: BackofficeScenarioContext): Promise<number> {
  const upload = ctx.lofi.upload.forOrg(orgId);
  await upload.drain();
  const key = workspaceUploadKey(artifactBuildPath(SOURCE_PATH));
  const build = (await readScenarioReplicaView(readyUploadFilesView(upload.replica))).find(
    ({ fileKey }) => fileKey === key,
  );
  assert(build?.updatedAt !== undefined, "The replica has no build.");
  return new Date(build.updatedAt).getTime();
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
 * scope's replica and each file read from the workspace, and returns the markup with each query's
 * rows and each file's data.
 */
async function renderPage(ctx: BackofficeScenarioContext, definition: PageDefinition) {
  const { queries, values, files, spec } = definition;
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
  const fileData: Record<string, PageData> = {};
  for (const [name, file] of Object.entries(files)) {
    const read = await ctx.runCodemode({
      scope,
      code: `async () => await state.readFile({ path: ${JSON.stringify(file.path)} })`,
    });
    fileData[name] = pageFileData(file, read.result as string);
    store.set(pageFilePath(name), fileData[name]);
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
  return { markup, data, files: fileData };
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
          then.assert("a list binds as one value, however many it holds", async (ctx) => {
            // A hundred statuses and one more value: more than Durable Object SQLite binds.
            const statuses = JSON.stringify([
              "complete",
              "errored",
              ...Array.from({ length: 98 }, (_, index) => `unused-${index}`),
            ]);
            const { verifyError } = await writePage(
              ctx,
              queryPage(
                `SELECT instanceId FROM runs WHERE status IN (\${${statuses}}) AND instanceId <> \${"none"} ORDER BY instanceId`,
              ),
            );
            assert.equal(verifyError, null);
            const loaded = await loadBuiltPage(ctx);
            assert(loaded.kind === "ready", JSON.stringify(loaded));
            assert.lengthOf(Object.values(loaded.definition.queries)[0]!.params, 2);
            const { markup } = await renderPage(ctx, loaded.definition);
            assert.deepEqual(tables(markup), { Rows: ["charge-1", "ship-1", "ship-2"] });
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

  test("a page shows workspace files as their formats and declarations read them", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: allLocalObjects,
        env: codemodeEnv(),
        name: "a quarter's page over a budget CSV, a targets JSON, and a plan in Markdown",
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert("the source checks against the declarations and builds", async (ctx) => {
            await ctx.runCodemode({
              scope,
              code: `async () => {
  for (const [path, content] of Object.entries(${JSON.stringify(workspaceFiles)})) {
    await state.writeFile({ path: "/workspace/" + path, content });
  }
}`,
            });
            const { diagnostics, verifyError } = await writePage(ctx, filesPage);
            assert.deepEqual(diagnostics, [], diagnostics.join("\n"));
            assert.equal(verifyError, null);
          }),
          then.assert("the page shows each file as it reads", async (ctx) => {
            const loaded = await loadBuiltPage(ctx);
            assert(loaded.kind === "ready", JSON.stringify(loaded));
            assert.deepEqual(
              Object.values(loaded.definition.files).map(({ path, format }) => [path, format]),
              [
                ["/workspace/finance/targets.json", "json"],
                ["/workspace/finance/budget.csv", "csv"],
                ["/workspace/ops/q4-plan.md", "markdown"],
              ],
            );
            const { markup, files } = await renderPage(ctx, loaded.definition);
            assert.include(markup, "€50k");
            assert.deepEqual(tables(markup), {
              Budget: ["October | 1200.5 | ", "November, early | 900 | Says &quot;wait&quot;"],
            });
            assert.include(markup, "Ada");
            assert.include(markup, "# Q4 plan");
            // The frontmatter's date reads as a time, which pages bind as ISO 8601.
            const plan = Object.values(files).find(
              (data) => typeof data === "object" && data !== null && "body" in data,
            ) as { frontmatter: { due: string } };
            assert.equal(plan.frontmatter.due, "2026-12-01T00:00:00.000Z");
          }),
          then.assert(
            "a frontmatter field the file leaves out reads as null, keeping the body",
            async (ctx) => {
              await ctx.runCodemode({
                scope,
                code: `async () => await state.writeFile({ path: "/workspace/ops/q4-plan.md", content: "---\\nowner: Ada\\n---\\n# Q4 plan\\n" })`,
              });
              const loaded = await loadBuiltPage(ctx);
              assert(loaded.kind === "ready", JSON.stringify(loaded));
              const { files } = await renderPage(ctx, loaded.definition);
              const plan = Object.values(files).find(
                (data) => typeof data === "object" && data !== null && "body" in data,
              );
              assert.deepEqual(plan, {
                body: "# Q4 plan",
                frontmatter: { owner: "Ada", due: null },
              });
            },
          ),
          then.assert("a file that does not fit its declaration names the cell", async (ctx) => {
            await writePage(
              ctx,
              filesPage.replace('amount: "number"', 'amount: "number", region: "string"'),
            );
            const loaded = await loadBuiltPage(ctx);
            assert(loaded.kind === "ready", JSON.stringify(loaded));
            const error = await renderPage(ctx, loaded.definition).then(
              () => null,
              (failure: unknown) => (failure instanceof Error ? failure.message : String(failure)),
            );
            assert.equal(
              error,
              'The CSV\'s header has no "region" column. It has: month, amount, approved, note.',
            );
          }),
          then.assert("a page reads files only under /workspace", async (ctx) => {
            const { verifyError } = await writePage(
              ctx,
              filesPage.replace("/workspace/finance/targets.json", "/static/SYSTEM.md"),
            );
            assert.equal(verifyError, "files.f0.path: Pages read files under /workspace.");
          }),
        ],
      }),
    );
  });

  test("an open page sees an agent's rebuild as newer than the build it loaded", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: allLocalObjects,
        env: codemodeEnv(),
        name: "a page open in the browser while an agent rebuilds it",
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ when, then }) => [
          then.assert("the build the route loads is the one the replica holds", async (ctx) => {
            // Saved without building, so opening the page builds it.
            await writeSource(ctx, newestRunPage);
            const built = await loadVersionedPage(ctx);
            assert(built.page.kind === "ready", JSON.stringify(built.page));
            assert(built.buildUpdatedAt !== null);
            // Not later, so the page does not reload for the build its own load wrote. The replica's
            // time can trail the file's: the outbox reserves its time before the row is written.
            assert.isAtMost(await replicaBuildUpdatedAt(ctx), Date.parse(built.buildUpdatedAt));
            // Opened again, the page comes from the cache, at the same version.
            assert.equal((await loadVersionedPage(ctx)).buildUpdatedAt, built.buildUpdatedAt);
            ctx.vars.served = Date.parse(built.buildUpdatedAt);
          }),
          when.time.advance("1 minute"),
          then.assert("a rebuild reaches the replica as a later build", async (ctx) => {
            const { verifyError } = await writePage(ctx, paramsMetricPage);
            assert.equal(verifyError, null);
            assert.isAbove(await replicaBuildUpdatedAt(ctx), ctx.vars.served as number);
          }),
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
          then.assert("a misspelt relation names the relations", async (ctx) => {
            const { verifyError } = await writePage(ctx, queryPage("SELECT instanceId FROM run"));
            assert.equal(
              verifyError,
              "queries.q0: no such table: run. Read one of: runs, steps, workflow_events, events, event_state, event_sources, event_definitions, routes, route_schedules, route_dispatches, projects, kv_store, connections, agents, workflow_waits.",
            );
          }),
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
