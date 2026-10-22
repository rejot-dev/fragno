import { afterAll, assert, beforeAll, describe, test, vi } from "vitest";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import type { CodemodeExecutor } from "@fragno-dev/codemode/execution/codemode-activation-contract";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/remote/codemode-node-executor";
import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as ts from "typescript";

import { createStateStore } from "@json-render/react";
import { queryOnce } from "@tanstack/react-db";

import { artifactBuildPath } from "@/artifacts/build-cache.server";
import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
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
import { pageQuery, pageRows, pageValueText } from "./query";

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

const operationsPage = `export default page.define(({ collections, from, and, eq, gte, not, isNull, coalesce, count, max, bucket, now }) => {
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
  const hours = { every: "1 hour", since: now.minus("119 minutes") };
  const hourly = from({ run: runs })
    .where(({ run }) => not(isNull(bucket(run.createdAt, hours))))
    .groupBy(({ run }) => bucket(run.createdAt, hours))
    .select(({ run }) => ({ hour: bucket(run.createdAt, hours), runs: count(run.id) }))
    .orderBy(({ run }) => bucket(run.createdAt, hours), "asc");

  return ui.stack({ gap: "md" }, [
    ui.metric({ label: "Runs today", value: started.value("total", "0") }),
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
      payload: { instanceId },
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

/** Writes the source and runs the skill's verification call, which imports it and returns its preview. */
async function writePage(ctx: BackofficeScenarioContext, source: string) {
  await ctx.runCodemode({
    scope,
    code: `async () => await state.writeFile({ path: ${JSON.stringify(SOURCE_PATH)}, content: ${JSON.stringify(source)} })`,
  });
  const verifyError = await ctx
    .runCodemode({
      scope,
      code: `async () => {
  const { default: definition } = await import(${JSON.stringify(SOURCE_PATH)});
  return { $ui: page.preview(definition) };
}`,
    })
    .then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  return { diagnostics: checkPageSource(source), verifyError };
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

/** Renders a built page the way its route does, with each query's live results run once. */
async function renderPage(ctx: BackofficeScenarioContext, definition: PageDefinition) {
  const { queries, values, spec } = definition;
  const database = ctx.tanstack.automations.forOrg(orgId);
  await database.drain();

  const store = createStateStore({});
  for (const [name, query] of Object.entries(queries)) {
    const rows = pageRows(
      await queryOnce((builder) =>
        pageQuery(builder, database.collections, query, ctx.runtime.now()),
      ),
    );
    store.set(pageDataPath(name), rows);
    for (const [valueName, value] of Object.entries(values)) {
      if (value.query === name) {
        store.set(pageValuePath(valueName), pageValueText(value, rows));
      }
    }
  }
  return renderToStaticMarkup(createElement(BackofficeUiStoreRenderer, { spec, store }));
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
            const markup = await renderPage(ctx, loaded.definition);
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
            assert.deepEqual(tables(await renderPage(ctx, loaded.definition)), {
              "Newest run": ["ship-2"],
            });
          }),
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
            const fieldError =
              'run.statsu: workflowInstances has no "statsu" field. Fields: id, workflowName';
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

  test("an outage fails the page without caching, and the page builds once it recovers", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: allLocalObjects,
        env: codemodeEnv(),
        name: "a page opened while codemode is unreachable",
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert("the page fails while codemode is down", async (ctx) => {
            await writePage(ctx, newestRunPage);
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
        ],
      }),
    );
  });

  test("an import the build cannot read fails the page with where it is imported", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: allLocalObjects,
        env: codemodeEnv(),
        name: "a page that imports a deleted helper",
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert("the route reports the import as the page's error", async (ctx) => {
            await writePage(ctx, `import { caption } from "./helpers.js";\n${newestRunPage}`);
            const loaded = await loadBuiltPage(ctx);
            assert(loaded.kind === "failed", JSON.stringify(loaded));
            assert.include(loaded.message, `${SOURCE_PATH}:1:`);
            assert.include(loaded.message, "Import './helpers.js' cannot be read");
          }),
        ],
      }),
    );
  });
});
