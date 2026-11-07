import { afterEach, assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import type { ArtifactSiteDataStatus } from "@fragno-dev/backoffice-api/v0/artifacts";
import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { withBackofficeActorCapabilityGrants } from "@/backoffice-runtime/authority-resolver";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjectFactory } from "@/backoffice-runtime/local-object-factory";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { blobsR2BucketsFromEnv } from "@/fragno/blobs-r2-buckets";
import { createFakeR2 } from "@/fragno/blobs-r2.test-utils";
import { artifactsToolFamily } from "@/fragno/runtime-tools/families/artifacts";
import {
  createCodemodeRouteBackedRuntimeContext,
  createRouteBackedRuntimeContext,
} from "@/fragno/runtime-tools/route-backed-runtime-context";
import { executeBackofficeRuntimeTool } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";

import { SiteReplicaObject } from "../../../workers/site-replica-object";
import { sqliteSiteReplicaStorage } from "../../backoffice-runtime/node/sqlite-site-replica-storage";
import { serveSiteAssets, siteStoreForServing } from "./assets.server";
import { buildSite as buildSiteDirectly } from "./build.server";
import {
  createSitePointerCache,
  inProcessSiteWorkerBindings,
  serveSite,
  type SitePointerCache,
} from "./serve.server";
import { siteBuildDirectory } from "./site-path";

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Moves the clock past the time a replaced build keeps its files. It keeps ticking, as builds tell
 * edits apart by when the files were written.
 */
function afterRetiredBuildsExpire() {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(Date.now() + 15 * 60 * 1000);
}

const orgId = "org-1";
const scope = { kind: "org" as const, orgId, jurisdiction: null };
const SITE_PATH = "/workspace/tools/shop.site";
const STATIC_SITE_PATH = "/workspace/docs.site";

const INDEX_HTML = '<!doctype html><title>Shop</title><link rel="stylesheet" href="style.css">';

/**
 * Serves the site's files and, under `/api/`, greets through a saved module and reports what
 * reached it of the viewer's request.
 */
function workerSource(greeting: string) {
  return `import { greet } from "./lib/greet.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    return Response.json(
      {
        message: greet(url.searchParams.get("name"), ${JSON.stringify(greeting)}),
        method: request.method,
        path: url.pathname,
        cookie: request.headers.get("cookie"),
      },
      { headers: { "set-cookie": "session=site" } },
    );
  },
};
`;
}

const GREET_MODULE = "export const greet = (name, greeting) => `${greeting}, ${name}`;";

async function writeFile(ctx: BackofficeScenarioContext, path: string, content: string) {
  await ctx.runCodemode({
    scope,
    code: `async () => await state.writeFile({ path: ${JSON.stringify(path)}, content: ${JSON.stringify(content)} })`,
  });
}

type SiteBuildResult =
  | { status: "built"; path: string }
  | { status: "failed"; path: string; message: string };

async function buildSite(ctx: BackofficeScenarioContext, path: string): Promise<SiteBuildResult> {
  const run = await ctx.runCodemode({
    scope,
    code: `async () => await artifacts.buildSite({ path: ${JSON.stringify(path)} })`,
    assertToolCalls: ["artifacts.buildSite"],
  });
  return run.result as SiteBuildResult;
}

function workspace(ctx: BackofficeScenarioContext) {
  const { stateBackend } = createCodemodeRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeSystemExecution(scope),
  });
  assert(stateBackend);
  return stateBackend;
}

// Runs once in the next file request a site Worker makes, after the host read the build pointer.
let beforeNextAssetRead: (() => Promise<void>) | null = null;

/**
 * Requests a site the way its route does, from a viewer signed in to Backoffice. Each request
 * reads the pointer afresh unless it shares `pointers` with others, as one isolate's requests do.
 */
async function request(
  ctx: BackofficeScenarioContext,
  sitePath: string,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    pointers?: SitePointerCache;
  } = {},
) {
  const runtime = ctx.runtime.services;
  const url = new URL(`https://backoffice.example/backoffice/sites/org/acme${path}`);
  return await serveSite({
    request: new Request(url, {
      method: init.method ?? "GET",
      headers: { cookie: "better-auth.session_token=viewer", ...init.headers },
    }),
    store: siteStoreForServing({ runtime, scope, sitePath, cache: null }),
    pointers: init.pointers ?? createSitePointerCache(() => 0),
    bindings: {
      ...inProcessSiteWorkerBindings(runtime),
      siteAssets: (props) => ({
        async fetch(assetRequest) {
          const interleaved = beforeNextAssetRead;
          beforeNextAssetRead = null;
          await interleaved?.();
          const store = siteStoreForServing({ runtime, scope, sitePath, cache: null });
          return await serveSiteAssets({ request: assetRequest, store, props });
        },
      }),
    },
    scope,
    sitePath,
    pathname: new URL(path, url).pathname,
  });
}

async function buildCount(ctx: BackofficeScenarioContext, sitePath: string) {
  const entries = await workspace(ctx).readdirWithFileTypes(siteBuildDirectory(sitePath));
  return entries.filter((entry) => entry.type === "directory").length;
}

async function greeting(ctx: BackofficeScenarioContext) {
  return (
    (await (await request(ctx, SITE_PATH, "/api/greet?name=Ada")).json()) as {
      message: string;
    }
  ).message;
}

test("a site serves its last good build: files from public/, everything else from its Worker", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: allLocalObjects,
      env: { SITES_ENABLED: "true" },
      name: "a site is built, served, rebuilt, and survives a broken build",
      setup: ({ given }) => [
        given.organization.exists({ id: orgId }),
        given.codemode.writeFile({
          orgId,
          path: `${SITE_PATH}/public/index.html`,
          content: INDEX_HTML,
        }),
        given.codemode.writeFile({
          orgId,
          path: `${SITE_PATH}/public/style.css`,
          content: "body { color: teal; }",
        }),
        given.codemode.writeFile({
          orgId,
          path: `${SITE_PATH}/worker.js`,
          content: workerSource("Hello"),
        }),
        given.codemode.writeFile({
          orgId,
          path: `${SITE_PATH}/lib/greet.js`,
          content: GREET_MODULE,
        }),
        given.codemode.writeFile({
          orgId,
          path: `${STATIC_SITE_PATH}/public/index.html`,
          content: "<!doctype html><title>Docs</title>",
        }),
        given.codemode.writeFile({
          orgId,
          path: `${STATIC_SITE_PATH}/public/guide/index.html`,
          content: '<!doctype html><title>Guide</title><a href="../">Docs</a>',
        }),
      ],
      steps: ({ then }) => [
        then.assert("an unbuilt site answers that it has no build", async (ctx) => {
          const response = await request(ctx, SITE_PATH, "/");
          assert.equal(response.status, 404);
          assert.equal(await response.text(), `${SITE_PATH} has not been built.`);
        }),
        then.assert("the build reports success", async (ctx) => {
          assert.deepEqual(await buildSite(ctx, SITE_PATH), {
            status: "built",
            path: SITE_PATH,
          });
          assert.deepEqual(await buildSite(ctx, STATIC_SITE_PATH), {
            status: "built",
            path: STATIC_SITE_PATH,
          });
        }),
        then.assert("the root serves index.html, revalidated by its ETag", async (ctx) => {
          const page = await request(ctx, SITE_PATH, "/");
          assert.equal(page.status, 200);
          assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
          assert.equal(await page.text(), INDEX_HTML);
          const etag = page.headers.get("etag");
          assert(etag);

          const unchanged = await request(ctx, SITE_PATH, "/", {
            headers: { "if-none-match": etag },
          });
          assert.equal(unchanged.status, 304);
          assert.equal(await unchanged.text(), "");

          const stylesheet = await request(ctx, SITE_PATH, "/style.css");
          assert.equal(stylesheet.headers.get("content-type"), "text/css; charset=utf-8");
          assert.equal(await stylesheet.text(), "body { color: teal; }");
        }),
        then.assert(
          "other requests reach the Worker without the viewer's session, and it sets no cookies",
          async (ctx) => {
            const response = await request(ctx, SITE_PATH, "/api/greet?name=Ada");
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("set-cookie"), null);
            assert.deepEqual(await response.json(), {
              message: "Hello, Ada",
              method: "GET",
              path: "/api/greet",
              cookie: null,
            });

            const posted = await request(ctx, SITE_PATH, "/api/greet", { method: "POST" });
            assert.deepEqual(await posted.json(), {
              message: "Hello, null",
              method: "POST",
              path: "/api/greet",
              cookie: null,
            });
            // Files answer only reads.
            const write = await request(ctx, SITE_PATH, "/style.css", { method: "PUT" });
            assert.equal(write.status, 405);
          },
        ),
        then.assert("a site without a Worker answers only with its files", async (ctx) => {
          assert.equal(
            await (await request(ctx, STATIC_SITE_PATH, "/")).text(),
            "<!doctype html><title>Docs</title>",
          );
          assert.equal((await request(ctx, STATIC_SITE_PATH, "/api/greet")).status, 404);
          // A directory's page links relative to it, so its path gains the trailing slash.
          const guide = await request(ctx, STATIC_SITE_PATH, "/guide");
          assert.equal(guide.status, 307);
          assert.equal(guide.headers.get("location"), "./guide/");
          const localized = await request(ctx, STATIC_SITE_PATH, "/guide?lang=fr");
          assert.equal(localized.headers.get("location"), "./guide/?lang=fr");
        }),
        then.assert(
          "a directory's redirect keeps its name as the request encoded it",
          async (ctx) => {
            for (const name of ["notes#2024", "日本", "a:b"]) {
              await writeFile(
                ctx,
                `${STATIC_SITE_PATH}/public/${name}/index.html`,
                `<title>${name}</title>`,
              );
            }
            assert.equal((await buildSite(ctx, STATIC_SITE_PATH)).status, "built");
            for (const name of ["notes#2024", "日本", "a:b"]) {
              const path = `/${encodeURIComponent(name)}`;
              const redirect = await request(ctx, STATIC_SITE_PATH, path);
              assert.equal(redirect.status, 307);
              const location = redirect.headers.get("location");
              assert(location);
              const target = new URL(location, `https://site.example${path}`).pathname;
              const page = await request(ctx, STATIC_SITE_PATH, target);
              assert.equal(await page.text(), `<title>${name}</title>`);
            }
          },
        ),
        then.assert(
          "an edit is served only once the site is rebuilt, which keeps the build it replaced",
          async (ctx) => {
            await writeFile(ctx, `${SITE_PATH}/worker.js`, workerSource("Welcome"));
            assert.equal(await greeting(ctx), "Hello, Ada");

            assert.deepEqual(await buildSite(ctx, SITE_PATH), {
              status: "built",
              path: SITE_PATH,
            });
            assert.equal(await greeting(ctx), "Welcome, Ada");
            assert.equal(await buildCount(ctx, SITE_PATH), 2);
          },
        ),
        then.assert(
          "an isolate trusts the pointer it read for a second, so one page load reads it once",
          async (ctx) => {
            let now = 0;
            const pointers = createSitePointerCache(() => now);
            const css = async () =>
              await (await request(ctx, SITE_PATH, "/style.css", { pointers })).text();
            assert.equal(await css(), "body { color: teal; }");

            await writeFile(ctx, `${SITE_PATH}/public/style.css`, "body { color: navy; }");
            assert.equal((await buildSite(ctx, SITE_PATH)).status, "built");
            now = 999;
            assert.equal(await css(), "body { color: teal; }");
            now = 1000;
            assert.equal(await css(), "body { color: navy; }");
          },
        ),
        then.assert(
          "a request that read the build before a rebuild still gets the files it named",
          async (ctx) => {
            let rebuilt = 0;
            beforeNextAssetRead = async () => {
              for (const color of ["plum", "gold"]) {
                await writeFile(ctx, `${SITE_PATH}/public/style.css`, `body { color: ${color}; }`);
                assert.equal((await buildSite(ctx, SITE_PATH)).status, "built");
                rebuilt += 1;
              }
            };
            const inFlight = await request(ctx, SITE_PATH, "/style.css");
            assert.equal(rebuilt, 2);
            assert.equal(inFlight.status, 200);
            assert.equal(await inFlight.text(), "body { color: navy; }");

            const next = await request(ctx, SITE_PATH, "/style.css");
            assert.equal(await next.text(), "body { color: gold; }");
          },
        ),
        then.assert(
          "replaced builds keep their files for 15 minutes, then the next build removes them",
          async (ctx) => {
            assert.isAbove(await buildCount(ctx, SITE_PATH), 2);
            afterRetiredBuildsExpire();
            await writeFile(ctx, `${SITE_PATH}/public/style.css`, "body { color: teal; }");
            assert.equal((await buildSite(ctx, SITE_PATH)).status, "built");
            // The build it served and the one it just replaced.
            assert.equal(await buildCount(ctx, SITE_PATH), 2);
            assert.equal(
              await (await request(ctx, SITE_PATH, "/style.css")).text(),
              "body { color: teal; }",
            );
          },
        ),
        then.assert("a failed build leaves the last good build serving", async (ctx) => {
          await writeFile(
            ctx,
            `${SITE_PATH}/worker.js`,
            'import { Hono } from "hono";\nexport default new Hono();',
          );
          assert.deepEqual(await buildSite(ctx, SITE_PATH), {
            status: "failed",
            path: SITE_PATH,
            message: "Site Workers import saved modules by path, not packages (hono).",
          });
          assert.equal(await greeting(ctx), "Welcome, Ada");
        }),
        then.assert("a Worker that cannot load or answer fails its build", async (ctx) => {
          await writeFile(ctx, `${SITE_PATH}/worker.js`, "export default {};");
          assert.deepEqual(await buildSite(ctx, SITE_PATH), {
            status: "failed",
            path: SITE_PATH,
            message: "worker.js must default-export an object with a fetch(request) method.",
          });

          await writeFile(
            ctx,
            `${SITE_PATH}/worker.js`,
            'throw new Error("missing configuration");\nexport default { fetch: () => new Response() };',
          );
          const failed = await buildSite(ctx, SITE_PATH);
          assert(failed.status === "failed");
          assert.include(failed.message, "missing configuration");
          assert.equal(await greeting(ctx), "Welcome, Ada");
        }),
        then.assert(
          "a site inside another site, or named by a wildcard, is rejected",
          async (ctx) => {
            await expect(buildSite(ctx, `${SITE_PATH}/inner.site`)).rejects.toThrow(
              `is inside the site ${SITE_PATH}; sites cannot nest.`,
            );
            // `/workspace/doc?.site` would otherwise list docs.site's files as its own.
            await expect(buildSite(ctx, "/workspace/doc?.site")).rejects.toThrow(
              "contains * or ?, which a site's path cannot.",
            );
          },
        ),
        then.assert(
          "an unreadable build pointer answers as such, and building again repairs it",
          async (ctx) => {
            await workspace(ctx).writeFile(
              `${siteBuildDirectory(STATIC_SITE_PATH)}/build.json`,
              "{",
            );
            const broken = await request(ctx, STATIC_SITE_PATH, "/");
            assert.equal(broken.status, 500);
            assert.include(await broken.text(), `Build ${STATIC_SITE_PATH} again to replace it.`);

            assert.equal((await buildSite(ctx, STATIC_SITE_PATH)).status, "built");
            assert.equal((await request(ctx, STATIC_SITE_PATH, "/")).status, 200);
          },
        ),
      ],
    }),
  );
});

const buckets = blobsR2BucketsFromEnv(
  {
    BLOBS_R2_ENDPOINT: "https://account-1.r2.cloudflarestorage.com",
    BLOBS_R2_BUCKET: "backoffice-blobs",
    BLOBS_R2_ACCESS_KEY_ID: "access-key",
    BLOBS_R2_SECRET_ACCESS_KEY: "secret-key",
    DOCS_PUBLIC_BASE_URL: "https://backoffice.example/",
  },
  "enforced",
);
assert(buckets);
const r2 = createFakeR2(buckets);

// The organization has no jurisdiction, so its sites live in the bucket of none.
const SITE_OBJECTS =
  "https://account-1.r2.cloudflarestorage.com/backoffice-blobs/sites/org%3Aorg-1/docs.site/";

/** Each stored object of the docs site, as `build.json` or `<build id>/<file>`. */
function storedSiteObjects() {
  return [...r2.objects.keys()].flatMap((url) =>
    url.startsWith(SITE_OBJECTS) ? [url.slice(SITE_OBJECTS.length)] : [],
  );
}

function storedBuilds() {
  return new Set(
    storedSiteObjects()
      .filter((object) => object !== "build.json")
      .map((object) => object.split("/")[0]),
  );
}

async function storedPointer() {
  const { fetch } = r2;
  const response = await fetch(`${SITE_OBJECTS}build.json`, {
    headers: { authorization: "AWS4-HMAC-SHA256 Credential=access-key/test" },
  });
  return (await response.json()) as {
    version: number;
    served: { build: string; sources: string };
    retired: { build: string; at: number }[];
  };
}

// Runs once before the next write of a site pointer reaches R2.
let beforeNextPointerWrite: (() => Promise<void>) | null = null;

const racedR2Fetch: typeof fetch = async (input, init) => {
  const { fetch } = r2;
  const request = new Request(input, init);
  if (request.method === "PUT" && request.url === `${SITE_OBJECTS}build.json`) {
    const interleaved = beforeNextPointerWrite;
    beforeNextPointerWrite = null;
    await interleaved?.();
  }
  return await fetch(request);
};

const DATA_SITE_PATH = "/workspace/data.site";

/**
 * Reads the scope's automation data with `env.DATA.sql` at each path, and answers a read that
 * fails with its message.
 */
const DATA_WORKER = `export default {
  async fetch(request, env) {
    const { sql } = env.DATA;
    const url = new URL(request.url);
    const answer = async (read) => {
      try {
        return Response.json(await read());
      } catch (error) {
        return Response.json({ error: error.name + ": " + error.message });
      }
    };
    switch (url.pathname) {
      case "/wide":
        // Fewer than 4 MB of characters, but more than 4 MB of UTF-8.
        return answer(() => sql\`WITH t(x) AS (SELECT \${"€".repeat(500000)}) SELECT x FROM t, (SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3)\`);
      case "/keys":
        // Catches its read's error, as a Worker may.
        return answer(() => sql\`SELECT key FROM kv_store ORDER BY key\`);
      case "/store": {
        const keys = url.searchParams.getAll("key");
        const since = new Date(Number(url.searchParams.get("since")));
        const stored = sql\`SELECT key, value, updatedAt FROM kv_store WHERE updatedAt >= \${since}\`;
        return answer(() => sql\`SELECT key, value FROM (\${stored}) WHERE key IN (\${keys}) ORDER BY key\`);
      }
      case "/agents":
        return answer(() => sql\`SELECT count(*) AS agents, sum(builtIn) AS builtIn FROM agents\`);
      case "/write":
        return answer(() => sql\`DELETE FROM kv_store_automations\`);
      case "/with-write":
        return answer(() => sql\`WITH gone AS (SELECT 1) DELETE FROM kv_store_automations\`);
      case "/two":
        return answer(() => sql\`SELECT 1; DELETE FROM kv_store_automations\`);
      case "/missing":
        return answer(() => sql\`SELECT * FROM orders\`);
      case "/undefined":
        return answer(() => sql\`SELECT * FROM kv_store WHERE key = \${undefined}\`);
      case "/too-many":
        return answer(() => sql\`SELECT value FROM json_each(\${JSON.stringify(Array.from({ length: 10001 }, (_, index) => index))})\`);
      default:
        return env.ASSETS.fetch(request);
    }
  },
};
`;

async function setStored(ctx: BackofficeScenarioContext, key: string, value: string) {
  await ctx.runCodemode({
    scope,
    code: `async () => await store.set({ key: ${JSON.stringify(key)}, value: ${JSON.stringify(value)} })`,
  });
}

async function siteDataStatus(ctx: BackofficeScenarioContext): Promise<ArtifactSiteDataStatus> {
  const run = await ctx.runCodemode({
    scope,
    code: "async () => await artifacts.siteDataStatus({})",
    assertToolCalls: ["artifacts.siteDataStatus"],
  });
  return run.result as ArtifactSiteDataStatus;
}

/** The site's answer at `path`, or its status when the site is unavailable. */
async function readData(ctx: BackofficeScenarioContext, path: string): Promise<unknown> {
  const response = await request(ctx, DATA_SITE_PATH, path);
  return response.status === 200 ? await response.json() : response.status;
}

test("a site's Worker reads the scope's automation data with sql, as pages read it", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: allLocalObjects,
      env: { SITES_ENABLED: "true" },
      name: "a site reads automation data",
      setup: ({ given }) => [
        given.organization.exists({ id: orgId }),
        given.codemode.writeFile({
          orgId,
          path: `${DATA_SITE_PATH}/worker.js`,
          content: DATA_WORKER,
        }),
      ],
      steps: ({ then }) => [
        then.assert("building the site starts copying the scope's data", async (ctx) => {
          assert.equal((await siteDataStatus(ctx)).status, "not-started");
          assert.deepEqual(await buildSite(ctx, DATA_SITE_PATH), {
            status: "built",
            path: DATA_SITE_PATH,
          });
          const status = await siteDataStatus(ctx);
          assert.equal(status.status, "catching-up");
          assert.equal(status.available, false);
          assert.notEqual(status.retryAt, null);
        }),
        then.assert(
          "until the scope's data is first copied, a request that reads it finds the site unavailable",
          async (ctx) => {
            await setStored(ctx, "plan", "pro");
            const response = await request(ctx, DATA_SITE_PATH, "/keys");
            assert.equal(response.status, 503);
            assert.equal(response.headers.get("retry-after"), "5");
            assert.equal(
              await response.text(),
              "This site is unavailable while its data is copied. Try again in a moment.",
            );
          },
        ),
        then.assert("the copy catches up in the background, and the site answers", async (ctx) => {
          await expect.poll(() => readData(ctx, "/keys")).toEqual([{ key: "plan" }]);
          const status = await siteDataStatus(ctx);
          assert.deepInclude(status, {
            status: "caught-up",
            available: true,
            following: true,
            progress: null,
            lastError: null,
          });
          assert.notEqual(status.lastAppliedAt, null);
          assert.isAbove(status.sizeBytes, 0);
        }),
        then.assert(
          "values are parameters: a list reads with IN, a Date as milliseconds, and queries nest",
          async (ctx) => {
            await setStored(ctx, "seats", "12");
            await setStored(ctx, "unread", "x");
            await expect
              .poll(() => readData(ctx, "/store?key=plan&key=seats&key=missing&since=0"))
              .toEqual([
                { key: "plan", value: "pro" },
                { key: "seats", value: "12" },
              ]);
            assert.deepEqual(
              await readData(ctx, `/store?key=plan&since=${Date.now() + 60_000}`),
              [],
            );
          },
        ),
        then.assert("what is stored later reaches the copy while sites read it", async (ctx) => {
          await setStored(ctx, "plan", "enterprise");
          await expect
            .poll(() => readData(ctx, "/store?key=plan&since=0"))
            .toEqual([{ key: "plan", value: "enterprise" }]);
        }),
        then.assert("agents read as pages read them, built-in ones included", async (ctx) => {
          const [agents] = (await readData(ctx, "/agents")) as {
            agents: number;
            builtIn: number;
          }[];
          assert(agents.builtIn > 0, "built-in agents are listed without any events");
          assert.equal(agents.agents, agents.builtIn);
        }),
        then.assert("queries only read, one statement at a time", async (ctx) => {
          assert.deepEqual(await readData(ctx, "/write"), {
            error: "Error: Queries only read: they cannot write.",
          });
          assert.deepEqual(await readData(ctx, "/two"), {
            error: "Error: A query is one statement; remove what follows its semicolon.",
          });
          assert.deepEqual(await readData(ctx, "/with-write"), {
            error: "Error: Queries only read: they cannot write.",
          });
          assert.deepEqual(await readData(ctx, "/store?key=plan&key=seats&since=0"), [
            { key: "plan", value: "enterprise" },
            { key: "seats", value: "12" },
          ]);
        }),
        then.assert("mistakes are named as a page's are", async (ctx) => {
          const missing = (await readData(ctx, "/missing")) as { error: string };
          expect(missing.error).toMatch(
            /^Error: no such table: orders\. Read one of: runs, steps, .*kv_store.*agents, workflow_waits\.$/u,
          );
          assert.deepEqual(await readData(ctx, "/undefined"), {
            error:
              "TypeError: sql`...` value 0 expects a string, number, boolean, null, Date, a list of them, or sql`...`; received undefined.",
          });
          assert.deepEqual(await readData(ctx, "/too-many"), {
            error: "Error: The query returns more than 10000 rows; add a LIMIT.",
          });
          assert.deepEqual(await readData(ctx, "/wide"), {
            error: "Error: The query returns more than 4 MB; select fewer columns or rows.",
          });
        }),
      ],
    }),
  );
});

/** What fails in a site replica, as a test turns it on. */
type ReplicaFaults = {
  /** Automations' description, which opening the copy reads first, answers 500. */
  describeDown?: boolean;
  /** Automations' outbox stream answers 500. */
  streamDown: boolean;
  /** Setting the alarm for later than now fails. */
  laterAlarmFails: boolean;
  /** Reading the replica's meta table fails. */
  metaReadFails: boolean;
};

function faultyReplica(faults: ReplicaFaults): LocalBackofficeObjectFactory<SiteReplicaObject> {
  return ({ runtime, state, nowEpochMs }) => {
    const storage = sqliteSiteReplicaStorage();
    return new SiteReplicaObject({
      storage: {
        ...storage,
        exec: (sql, params) => {
          if (faults.metaReadFails && sql.includes("FROM site_replica_meta")) {
            throw new Error("disk I/O error");
          }
          return storage.exec(sql, params);
        },
      },
      alarm: {
        get: () => state.storage.getAlarm(),
        set: async (scheduledTime) => {
          if (faults.laterAlarmFails && scheduledTime > nowEpochMs()) {
            throw new Error("The alarm could not be set.");
          }
          await state.storage.setAlarm(scheduledTime);
        },
      },
      now: nowEpochMs,
      fetchAutomations: (target) => {
        const automations = runtime.objects.automations.for(target);
        return async (input, init) => {
          const request = new Request(input, init);
          const { pathname } = new URL(request.url);
          if (
            (faults.streamDown && pathname.endsWith("/outbox/stream")) ||
            (faults.describeDown && pathname.endsWith("/_internal"))
          ) {
            return new Response("Unavailable", {
              status: 500,
              statusText: "Internal Server Error",
            });
          }
          return await automations.http.fetch(request);
        };
      },
    });
  };
}

test("a copy that cannot follow Automations reports why, and tries again on its own", async () => {
  const faults = { streamDown: true, laterAlarmFails: false, metaReadFails: false };
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: { ...allLocalObjects, SITE_REPLICA: faultyReplica(faults) },
      env: { SITES_ENABLED: "true" },
      name: "a site's data copy recovers on its own",
      setup: ({ given }) => [
        given.organization.exists({ id: orgId }),
        given.codemode.writeFile({
          orgId,
          path: `${DATA_SITE_PATH}/worker.js`,
          content: DATA_WORKER,
        }),
      ],
      steps: ({ when, then }) => [
        then.assert("a build's copy that fails says why, and when it tries again", async (ctx) => {
          await setStored(ctx, "plan", "pro");
          await buildSite(ctx, DATA_SITE_PATH);
          // Runs the alarm the build set.
          await ctx.drain();
          const status = await siteDataStatus(ctx);
          assert.deepInclude(status, { status: "failing", available: false });
          assert.equal(
            status.lastError?.message,
            "Outbox stream request failed: 500 Internal Server Error",
          );
          const retryIn = Date.parse(status.retryAt ?? "") - Date.parse(status.lastError?.at ?? "");
          assert.approximately(retryIn, 5_000, 1_000);
        }),
        then.assert("Automations answers again", () => {
          faults.streamDown = false;
        }),
        when.time.advance("5 seconds"),
        then.assert(
          "the retry catches up without a read, so the first read answers",
          async (ctx) => {
            const status = await siteDataStatus(ctx);
            assert.deepInclude(status, { status: "caught-up", available: true, retryAt: null });
            assert.equal(
              status.lastError?.message,
              "Outbox stream request failed: 500 Internal Server Error",
            );
            assert.deepEqual(await readData(ctx, "/keys"), [{ key: "plan" }]);
          },
        ),
      ],
    }),
  );
});

test("a copy that cannot set its next attempt, or read its own state, fails rather than stalling or starting over", async () => {
  const faults = {
    describeDown: true,
    streamDown: true,
    laterAlarmFails: true,
    metaReadFails: false,
  };
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: { ...allLocalObjects, SITE_REPLICA: faultyReplica(faults) },
      env: { SITES_ENABLED: "true" },
      name: "a site's data copy fails loudly",
      setup: ({ given }) => [
        given.organization.exists({ id: orgId }),
        given.codemode.writeFile({
          orgId,
          path: `${DATA_SITE_PATH}/worker.js`,
          content: DATA_WORKER,
        }),
      ],
      steps: ({ then }) => [
        then.assert(
          "an alarm that cannot set the next attempt fails, so it runs again",
          async (ctx) => {
            await buildSite(ctx, DATA_SITE_PATH);
            // The copy cannot open, nor set the next attempt.
            await expect(ctx.drain()).rejects.toThrow("alarms failed");
            // It cannot open, and sets the next attempt, which is all an alarm owes.
            faults.laterAlarmFails = false;
            await ctx.drain();
            const status = await siteDataStatus(ctx);
            assert.deepInclude(status, { status: "failing", available: false });
            assert.notEqual(status.retryAt, null);

            // The copy opens, and its stream stops without the next attempt being set.
            faults.describeDown = false;
            faults.laterAlarmFails = true;
            ctx.runtime.advanceTime(Date.parse(status.retryAt ?? "") - ctx.runtime.now());
            await expect(ctx.drain()).rejects.toThrow("alarms failed");
            faults.laterAlarmFails = false;
            await ctx.drain();
            assert.notEqual((await siteDataStatus(ctx)).retryAt, null);
          },
        ),
        then.assert("a copy whose state cannot be read says so", async (ctx) => {
          faults.metaReadFails = true;
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
              try {
                return await artifacts.siteDataStatus({});
              } catch (error) {
                return { error: error.message };
              }
            }`,
            assertToolCalls: ["artifacts.siteDataStatus"],
          });
          assert.match((run.result as { error?: string }).error ?? "", /disk I\/O error/u);
          faults.metaReadFails = false;
        }),
      ],
    }),
  );
});

/** Calls an `artifacts` tool as an agent granted only `grants`, which may hold more. */
async function callAsAgent(
  ctx: BackofficeScenarioContext,
  grants: readonly BackofficePermissionRequirement[],
  tool: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const actor = {
    scope: "internal",
    type: "agent",
    id: "site-builder",
    role: "assistant",
  } as const;
  const system = createBackofficeSystemExecution(scope);
  const execution = { ...system, actors: { ...system.actors, delegation: [actor] } };
  const kernel = new BackofficeKernel({
    ...ctx.runtime.services,
    authorityResolver: withBackofficeActorCapabilityGrants({
      resolver: ctx.runtime.services.authorityResolver,
      actor,
      grants,
    }),
  });
  const context = createBackofficeToolContext(
    createRouteBackedRuntimeContext({
      runtime: ctx.runtime.services,
      execution,
      kernel,
      emitter: { kind: "caller" },
    }),
  );
  const found = artifactsToolFamily.tools.find(({ name }) => name === tool);
  assert(found, tool);
  return await executeBackofficeRuntimeTool(found, input, context);
}

const PROBE_SITE_PATH = "/workspace/probe.site";

test("an agent builds a site only when it may read its sources and the data its worker.js reads", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: allLocalObjects,
      env: { SITES_ENABLED: "true" },
      name: "sites need the grants of what they read",
      setup: ({ given }) => [
        given.organization.exists({ id: orgId }),
        given.codemode.writeFile({
          orgId,
          path: "/workspace/private.js",
          content: 'export const secret = "hunter2";',
        }),
        given.codemode.writeFile({
          orgId,
          path: `${PROBE_SITE_PATH}/worker.js`,
          content: `import { secret } from "../private.js";
throw new Error(secret);
export default { fetch() { return new Response(); } };`,
        }),
        given.codemode.writeFile({
          orgId,
          path: `${STATIC_SITE_PATH}/public/index.html`,
          content: "<!doctype html><title>Docs</title>",
        }),
      ],
      steps: ({ then }) => [
        then.assert(
          "an agent that may write files but not read them cannot build, so builds reveal no source",
          async (ctx) => {
            const denied = await callAsAgent(
              ctx,
              [BACKOFFICE_PERMISSION.upload.modify],
              "buildSite",
              { path: PROBE_SITE_PATH },
            ).catch((error: unknown) => error);
            assert.instanceOf(denied, Error);
            assert.match(denied.message, /not granted upload\.read/u);
            assert.notInclude(denied.message, "hunter2");
          },
        ),
        then.assert(
          "an agent with only workspace grants cannot build a site whose worker.js reads data",
          async (ctx) => {
            // The agent's grants narrow only where the tool runs, not in the object that builds.
            const workspaceOnly = [
              BACKOFFICE_PERMISSION.upload.read,
              BACKOFFICE_PERMISSION.upload.modify,
            ];
            await expect(
              callAsAgent(ctx, workspaceOnly, "buildSite", { path: PROBE_SITE_PATH }),
            ).rejects.toThrow(/not granted workflow\.read/u);
          },
        ),
        then.assert(
          "a site with a worker.js is built only for whoever may read the data it reads",
          async (ctx) => {
            const refuse = vi.fn(async () => {
              throw new Error("Not granted store.read.");
            });
            const build = (sitePath: string) =>
              buildSiteDirectly({
                state: workspace(ctx),
                codemode: { run: async () => await Promise.reject(new Error("Not compiled.")) },
                workerLoader: ctx.runtime.services.workerLoader,
                siteStorage: ctx.runtime.services.siteStorage,
                scope,
                sitePath,
                authorizeWorker: refuse,
              });
            await expect(build(PROBE_SITE_PATH)).rejects.toThrow("Not granted store.read.");
            const store = siteStoreForServing({
              runtime: ctx.runtime.services,
              scope,
              sitePath: PROBE_SITE_PATH,
              cache: null,
            });
            assert.deepEqual(await store.readPointer(), { status: "none" });

            // A site of files reads no data; built before, it is not built again.
            assert.equal((await buildSite(ctx, STATIC_SITE_PATH)).status, "built");
            refuse.mockClear();
            assert.deepEqual(await build(STATIC_SITE_PATH), { kind: "built", worker: false });
            expect(refuse).not.toHaveBeenCalled();
          },
        ),
      ],
    }),
  );
});

test("a deployment with buckets keeps each site's builds and pointer in R2", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: allLocalObjects,
      env: { SITES_ENABLED: "true", siteStorage: { buckets, fetch: racedR2Fetch } },
      name: "a site's builds live in its organization's bucket",
      setup: ({ given }) => [
        given.organization.exists({ id: orgId }),
        given.codemode.writeFile({
          orgId,
          path: `${STATIC_SITE_PATH}/public/index.html`,
          content: "<!doctype html><title>Docs</title>",
        }),
      ],
      steps: ({ then }) => [
        then.assert(
          "a build's files, Worker, and index go to R2, and nothing to the workspace",
          async (ctx) => {
            assert.equal((await buildSite(ctx, STATIC_SITE_PATH)).status, "built");
            assert.equal(await workspace(ctx).stat(siteBuildDirectory(STATIC_SITE_PATH)), null);
            const [key] = storedBuilds();
            assert.sameMembers(storedSiteObjects(), [
              "build.json",
              `${key}/index.json`,
              `${key}/worker.json`,
              `${key}/public/index.html`,
            ]);
            const pointer = await storedPointer();
            assert.equal(pointer.version, 5);
            assert.equal(pointer.served.build, key);
            assert.deepEqual(pointer.retired, []);
          },
        ),
        then.assert("building an unchanged site publishes nothing", async (ctx) => {
          const before = await storedPointer();
          assert.equal((await buildSite(ctx, STATIC_SITE_PATH)).status, "built");
          assert.deepEqual(await storedPointer(), before);
          assert.equal(storedBuilds().size, 1);
        }),
        then.assert("the site serves from R2", async (ctx) => {
          const page = await request(ctx, STATIC_SITE_PATH, "/");
          assert.equal(await page.text(), "<!doctype html><title>Docs</title>");
        }),
        then.assert(
          "replaced builds stay in R2 for 15 minutes, then the next build removes them",
          async (ctx) => {
            for (const title of ["Docs 2", "Docs 3"]) {
              await writeFile(
                ctx,
                `${STATIC_SITE_PATH}/public/index.html`,
                `<title>${title}</title>`,
              );
              assert.equal((await buildSite(ctx, STATIC_SITE_PATH)).status, "built");
            }
            assert.equal(storedBuilds().size, 3);

            afterRetiredBuildsExpire();
            await writeFile(ctx, `${STATIC_SITE_PATH}/public/index.html`, "<title>Docs 4</title>");
            assert.equal((await buildSite(ctx, STATIC_SITE_PATH)).status, "built");
            assert.equal(
              await (await request(ctx, STATIC_SITE_PATH, "/")).text(),
              "<title>Docs 4</title>",
            );
            assert.equal(storedBuilds().size, 2);
            assert.equal(storedSiteObjects().length, 7);
          },
        ),
        then.assert(
          "a build that loses the pointer to another publishes over it, replacing the winner",
          async (ctx) => {
            const winner = crypto.randomUUID();
            beforeNextPointerWrite = async () => {
              const { fetch } = r2;
              await fetch(`${SITE_OBJECTS}build.json`, {
                method: "PUT",
                headers: { authorization: "AWS4-HMAC-SHA256 Credential=access-key/test" },
                body: JSON.stringify({
                  version: 5,
                  served: { build: winner, sources: "f".repeat(64) },
                  retired: [],
                }),
              });
            };
            await writeFile(ctx, `${STATIC_SITE_PATH}/public/index.html`, "<title>Docs 6</title>");
            assert.equal((await buildSite(ctx, STATIC_SITE_PATH)).status, "built");
            const pointer = await storedPointer();
            assert.equal(pointer.retired.at(-1)?.build, winner);
            assert.equal(
              await (await request(ctx, STATIC_SITE_PATH, "/")).text(),
              "<title>Docs 6</title>",
            );
          },
        ),
      ],
    }),
  );
});
