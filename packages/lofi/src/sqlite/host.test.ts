import { afterEach, assert, describe, expect, it } from "vitest";

import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { BetterSQLite3DriverConfig } from "@fragno-dev/db/drivers";
import { fetchFragnoInternalDescription } from "@fragno-dev/db/outbox";
import { column, idColumn, schema, type FragnoId } from "@fragno-dev/db/schema";
import BetterSqlite3 from "better-sqlite3";
import { SqliteDialect } from "kysely";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { migrate, withDatabase, type TypedUnitOfWork } from "@fragno-dev/db";

import type { LofiSqliteClient, LofiSqliteView, LofiSqliteViewResult } from "./client";
import { guardedSqlViewEngine, type LofiSqliteGuardedQuery } from "./guarded-views";
import { lofiSqliteTableName, quoteSqliteIdentifier } from "./layout";
import { lofiSqliteReadViews, readViewEngine, type LofiSqliteReads } from "./read-views";
import { openLofiSqliteMemoryFiles, openLofiSqliteTab } from "./testing";
import type { LofiSqliteViewEngine } from "./views";

const appSchema = schema("app", (s) =>
  s
    .addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("email", column("string"))
        .addColumn("active", column("bool")),
    )
    .addTable("posts", (t) => t.addColumn("id", idColumn()).addColumn("title", column("string"))),
);

const table = (name: string) =>
  quoteSqliteIdentifier(lofiSqliteTableName({ schema: appSchema }, name));

const usersView = (client: LofiSqliteClient) =>
  client.sql({
    sql: `SELECT "email", "active" FROM ${table("users")} ORDER BY "email"`,
    params: [],
    columns: {
      email: appSchema.tables.users.columns.email,
      active: appSchema.tables.users.columns.active,
    },
  });

const postCountView = (client: LofiSqliteClient) =>
  client.sql({
    sql: `SELECT count(*) AS "count" FROM ${table("posts")}`,
    params: [],
    columns: { count: "integer" },
  });

const appReads = {
  // Two queries, which see the same state, and data that is not rows.
  activity: (reader, args: { since: number }) => ({
    since: new Date(args.since),
    activeUsers: reader
      .query({
        sql: `SELECT "email" FROM ${table("users")} WHERE "active" = 1 ORDER BY "email"`,
        params: [],
        columns: { email: appSchema.tables.users.columns.email },
      })
      .map(({ email }) => email),
    posts: reader.query({
      sql: `SELECT count(*) AS "count" FROM ${table("posts")}`,
      params: [],
      columns: { count: "integer" },
    })[0]!.count,
  }),
  // Counts its runs, to show which batches run it again.
  postTitles: (reader) => {
    postTitleRuns += 1;
    return reader
      .query({
        sql: `SELECT "title" FROM ${table("posts")} ORDER BY "title"`,
        params: [],
        columns: { title: appSchema.tables.posts.columns.title },
      })
      .map(({ title }) => title);
  },
  // Fails while Ada is gone.
  ada: (reader) => {
    const [ada] = reader.query({
      sql: `SELECT "email" FROM ${table("users")} WHERE "email" = 'ada@example.com'`,
      params: [],
      columns: { email: appSchema.tables.users.columns.email },
    });
    if (!ada) {
      throw new Error("Ada is gone.");
    }
    return ada;
  },
  deleteUsers: (reader) =>
    reader.query({ sql: `DELETE FROM ${table("users")}`, params: [], columns: {} }),
} satisfies LofiSqliteReads;
const appReadViews = lofiSqliteReadViews<typeof appReads>("app-reads");
let postTitleRuns = 0;

// Pages read people through `people` and `active_people`, two at a time.
let activePeopleComputed = 0;
const guardedEngine = guardedSqlViewEngine({
  kind: "guarded",
  views: { people: `SELECT "id", "email", "active" FROM ${table("users")}` },
  derived: {
    active_people: {
      columns: ["count"],
      compute: (reader) => {
        activePeopleComputed += 1;
        return [
          [
            reader.query({
              sql: `SELECT count(*) AS "count" FROM ${table("users")} WHERE "active" = 1`,
              params: [],
              columns: { count: "integer" },
            })[0]!.count,
          ],
        ];
      },
    },
  },
  limits: { rows: 2, bytes: 200, operations: 100, length: 1_000 },
});
// An engine with no views, which records the tables of each refresh and fails while `failures`
// is above zero.
const flaky = { failures: 0, refreshes: [] as Array<string[] | null> };
const flakyEngine: LofiSqliteViewEngine = {
  kind: "flaky",
  open: () => ({
    materialize() {},
    destroy() {},
    refresh(changed) {
      flaky.refreshes.push(changed === null ? null : [...changed].sort());
      if (flaky.failures > 0) {
        flaky.failures -= 1;
        throw new Error("The flaky engine failed.");
      }
    },
  }),
};

const guardedView =
  (sql: string, params: unknown[] = []) =>
  (client: LofiSqliteClient) =>
    client.view("guarded", { sql, params } as LofiSqliteGuardedQuery);

// ---------------------------------------------------------------------------------------------
// Scenario DSL: a fragment on fragno-db's SQLite backend serves the outbox. Each "tab" runs a host,
// as its worker would, and a client talking to it over a MessageChannel; wa-sqlite's in-memory VFS
// stands in for OPFS, and Node's Web Locks and BroadcastChannel for the browser's.
// ---------------------------------------------------------------------------------------------

type ScenarioContext = {
  tabs: Map<string, Awaited<ReturnType<typeof openLofiSqliteTab>>>;
  /** Every result a watched view reported, by `<tab>/<view>`. */
  views: Map<string, { results: LofiSqliteViewResult<unknown>[]; unwatch: () => void }>;
  errors: unknown[];
  vars: Record<string, FragnoId[]>;
  /** How many tabs opened the database. */
  databasesOpened: number;
  /** The identity `GET /_internal` reports for the backend. */
  adapterIdentity: string;
};

type ScenarioStep =
  | {
      type: "openTab";
      tab: string;
      beats: boolean;
      /** The backend identity the tab expects, `"backend"` for the backend's, or none. */
      expects?: string;
      /** The tab's connection fails with this message. */
      fails?: string;
    }
  | { type: "closeTab"; tab: string }
  | {
      type: "watch";
      tab: string;
      view: string;
      query: (client: LofiSqliteClient) => LofiSqliteView<unknown>;
    }
  | {
      type: "write";
      storeIdsAs: string;
      write: (uow: TypedUnitOfWork<typeof appSchema>, vars: ScenarioContext["vars"]) => void;
    }
  | { type: "waitForResult"; tab: string; view: string; result: unknown }
  | { type: "waitForStatus"; tab: string; status: unknown }
  /** Whether the backend answers; while it does not, every request fails with a 503. */
  | { type: "backend"; available: boolean }
  | { type: "waitForLeader"; tab: string }
  | { type: "check"; check: (ctx: ScenarioContext) => void };

const openTab = (tab: string, expects?: string): ScenarioStep => ({
  type: "openTab",
  tab,
  beats: true,
  expects,
});
const failToOpenTab = (tab: string, expects: string, message: string): ScenarioStep => ({
  type: "openTab",
  tab,
  beats: true,
  expects,
  fails: message,
});
/** A tab whose worker runs but whose heartbeats never arrive, like a frozen leader's. */
const openSilentTab = (tab: string): ScenarioStep => ({ type: "openTab", tab, beats: false });
const closeTab = (tab: string): ScenarioStep => ({ type: "closeTab", tab });
/** Subscribes to the view, like a mounted component. */
const watch = (
  tab: string,
  view: string,
  query: (client: LofiSqliteClient) => LofiSqliteView<unknown>,
): ScenarioStep => ({ type: "watch", tab, view, query });
const write = (
  storeIdsAs: string,
  write: (uow: TypedUnitOfWork<typeof appSchema>, vars: ScenarioContext["vars"]) => void,
): ScenarioStep => ({ type: "write", storeIdsAs, write });
/** Waits until the view's data matches `data`, compared like `toMatchObject`. */
const waitForView = (tab: string, view: string, data: unknown): ScenarioStep => ({
  type: "waitForResult",
  tab,
  view,
  result: { status: "ready", data },
});
const waitForError = (tab: string, view: string, message: string): ScenarioStep => ({
  type: "waitForResult",
  tab,
  view,
  result: { status: "error", message: expect.stringContaining(message) },
});
/** Waits until the tab's replica status matches `status`, compared like `toMatchObject`. */
const waitForStatus = (tab: string, status: unknown): ScenarioStep => ({
  type: "waitForStatus",
  tab,
  status,
});
const backendDown = (): ScenarioStep => ({ type: "backend", available: false });
const backendUp = (): ScenarioStep => ({ type: "backend", available: true });
const waitForLeader = (tab: string): ScenarioStep => ({ type: "waitForLeader", tab });
const check = (check: (ctx: ScenarioContext) => void): ScenarioStep => ({ type: "check", check });

/** The data of every ready result the view reported, in order. */
function readyData(ctx: ScenarioContext, view: string): unknown[] {
  return ctx.views
    .get(view)!
    .results.flatMap((result) => (result.status === "ready" ? [result.data] : []));
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function runScenario(steps: ScenarioStep[]): Promise<ScenarioContext> {
  const server = new BetterSqlite3(":memory:");
  const adapter = new SqlAdapter({
    dialect: new SqliteDialect({ database: server }),
    driverConfig: new BetterSQLite3DriverConfig(),
  });
  const fragment = instantiate(defineFragment("host-app").extend(withDatabase(appSchema)).build())
    .withConfig({})
    .withRoutes([])
    .withOptions({ databaseAdapter: adapter, outbox: { enabled: true } })
    .build();
  await migrate(fragment);
  let backendAvailable = true;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!backendAvailable) {
      return new Response(null, { status: 503, statusText: "Service Unavailable" });
    }
    const url = new URL(input instanceof Request ? input.url : input.toString());
    return await fragment.callRouteRaw(
      "GET",
      url.pathname as never,
      { query: url.searchParams, signal: init?.signal ?? undefined } as never,
    );
  };
  const files = await openLofiSqliteMemoryFiles({ statementDelayMs: 0 });
  const { adapterIdentity } = await fetchFragnoInternalDescription({
    internalUrl: new URL("http://host.test/_internal"),
    fetch: fetch as typeof globalThis.fetch,
  });

  const ctx: ScenarioContext = {
    tabs: new Map(),
    views: new Map(),
    errors: [],
    vars: {},
    databasesOpened: 0,
    adapterIdentity,
  };
  cleanups.push(async () => {
    for (const { unwatch } of ctx.views.values()) {
      unwatch();
    }
    for (const tab of ctx.tabs.values()) {
      await tab.close();
    }
    await adapter.close();
    server.close();
  });

  for (const step of steps) {
    switch (step.type) {
      case "openTab": {
        const opening = openLofiSqliteTab({
          replica: {
            baseUrl: "http://host.test",
            adapterIdentity: step.expects === "backend" ? ctx.adapterIdentity : step.expects,
            fetch: fetch as typeof globalThis.fetch,
            schemas: [{ schema: appSchema }],
            localSchemas: [],
            projections: [],
            ephemeralTables: [],
            onError: (error) => ctx.errors.push(error),
            retryDelayMs: 10,
          },
          engines: [
            readViewEngine({ kind: "app-reads", reads: appReads }),
            flakyEngine,
            guardedEngine,
          ],
          openDatabase: async (open) => {
            ctx.databasesOpened++;
            return await files.open(open);
          },
          heartbeatIntervalMs: step.beats ? 20 : 60 * 60_000,
          leaderTimeoutMs: 200,
        });
        if (step.fails === undefined) {
          ctx.tabs.set(step.tab, await opening);
        } else {
          await expect(opening).rejects.toThrow(step.fails);
        }
        break;
      }
      case "closeTab": {
        const tab = ctx.tabs.get(step.tab)!;
        ctx.tabs.delete(step.tab);
        await tab.close();
        break;
      }
      case "watch": {
        const store = step.query(ctx.tabs.get(step.tab)!.client);
        const results: LofiSqliteViewResult<unknown>[] = [];
        const unwatch = store.subscribe((result) => {
          results.push(result);
        });
        ctx.views.set(`${step.tab}/${step.view}`, { results, unwatch });
        break;
      }
      case "write": {
        const uow = adapter.createUnitOfWork(appSchema, appSchema.name);
        step.write(uow, ctx.vars);
        const { success } = await uow.executeMutations();
        assert(success);
        ctx.vars[step.storeIdsAs] = uow.getCreatedIds();
        break;
      }
      case "waitForResult":
        await expect
          .poll(() => ctx.views.get(`${step.tab}/${step.view}`)!.results.at(-1), {
            timeout: 2_000,
          })
          .toMatchObject(step.result as object);
        break;
      case "waitForStatus":
        await expect
          .poll(() => ctx.tabs.get(step.tab)!.client.getStatus(), { timeout: 2_000 })
          .toMatchObject(step.status as object);
        break;
      case "backend":
        backendAvailable = step.available;
        break;
      case "waitForLeader":
        await ctx.tabs.get(step.tab)!.host.leading;
        break;
      case "check":
        step.check(ctx);
        break;
    }
  }
  return ctx;
}

describe("Lofi SQLite host", () => {
  it("maintains every tab's SQL views in the leading tab, then in the next one", async () => {
    const ctx = await runScenario([
      openTab("a"),
      openTab("b"),
      watch("b", "users", usersView),
      watch("b", "posts", postCountView),
      waitForView("b", "users", []),
      // Tab a leads: only it opened the database, and it answers tab b's views.
      check((ctx) => {
        assert.equal(ctx.databasesOpened, 1);
      }),
      write("users", (uow) => {
        uow.create("users", { email: "bob@example.com", active: false });
        uow.create("users", { email: "ada@example.com", active: true });
      }),
      waitForView("b", "users", [
        { email: "ada@example.com", active: true },
        { email: "bob@example.com", active: false },
      ]),

      // A batch that leaves a view's rows as they were sends the view nothing.
      write("posts", (uow) => {
        uow.create("posts", { title: "Hello" });
      }),
      waitForView("b", "posts", [{ count: 1 }]),
      check((ctx) => {
        expect(readyData(ctx, "b/users")).toEqual([
          [],
          [
            { email: "ada@example.com", active: true },
            { email: "bob@example.com", active: false },
          ],
        ]);
      }),

      // A view that would write the replica is refused.
      watch("b", "writes", (client) =>
        client.sql({ sql: `DELETE FROM ${table("users")}`, params: [], columns: {} }),
      ),
      waitForError("b", "writes", "must not write"),

      // Tab b leads once tab a closes, and builds its views again.
      closeTab("a"),
      write("cy", (uow) => {
        uow.create("users", { email: "cy@example.com", active: true });
      }),
      waitForView("b", "users", [
        { email: "ada@example.com", active: true },
        { email: "bob@example.com", active: false },
        { email: "cy@example.com", active: true },
      ]),
      check((ctx) => {
        assert.equal(ctx.databasesOpened, 2);
      }),
    ]);
    expect(ctx.errors).toEqual([]);
  });

  it("maintains read views, which run several queries on one state", async () => {
    const ctx = await runScenario([
      openTab("a"),
      openTab("b"),
      watch("b", "activity", (client) => appReadViews(client, "activity", { since: 0 })),
      waitForView("b", "activity", { since: new Date(0), activeUsers: [], posts: 0 }),
      write("users", (uow) => {
        uow.create("users", { email: "ada@example.com", active: true });
        uow.create("posts", { title: "Hello" });
      }),
      waitForView("b", "activity", { activeUsers: ["ada@example.com"], posts: 1 }),

      // A batch that leaves the read's data as it was sends the view nothing.
      write("bob", (uow) => {
        uow.create("users", { email: "bob@example.com", active: false });
      }),
      write("post", (uow) => {
        uow.create("posts", { title: "Again" });
      }),
      waitForView("b", "activity", { activeUsers: ["ada@example.com"], posts: 2 }),
      check((ctx) => {
        expect(readyData(ctx, "b/activity")).toEqual([
          { since: new Date(0), activeUsers: [], posts: 0 },
          { since: new Date(0), activeUsers: ["ada@example.com"], posts: 1 },
          { since: new Date(0), activeUsers: ["ada@example.com"], posts: 2 },
        ]);
      }),

      // Reads that would write, and reads the worker does not have, fail their view.
      watch("b", "writes", (client) => appReadViews(client, "deleteUsers", undefined)),
      waitForError("b", "writes", "must not write"),
      watch("b", "unknown", (client) => client.view("app-reads", { read: "nope", args: null })),
      waitForError("b", "unknown", 'No read named "nope"'),
    ]);
    expect(ctx.errors).toEqual([]);
  });

  it("runs a view again only after batches that wrote a table it reads", async () => {
    let runsBefore = 0;
    const ctx = await runScenario([
      openTab("a"),
      watch("a", "titles", (client) => appReadViews(client, "postTitles", undefined)),
      watch("a", "posts", postCountView),
      write("post", (uow) => {
        uow.create("posts", { title: "Hello" });
      }),
      waitForView("a", "titles", ["Hello"]),
      waitForView("a", "posts", [{ count: 1 }]),
      check(() => {
        runsBefore = postTitleRuns;
      }),
      // Users are written, and the views that read users refresh, but the posts views do not run.
      watch("a", "users", usersView),
      write("users", (uow) => {
        uow.create("users", { email: "ada@example.com", active: true });
      }),
      waitForView("a", "users", [{ email: "ada@example.com" }]),
      check(() => {
        assert.equal(postTitleRuns, runsBefore);
      }),
      write("again", (uow) => {
        uow.create("posts", { title: "Again" });
      }),
      waitForView("a", "titles", ["Again", "Hello"]),
      check(() => {
        assert.equal(postTitleRuns, runsBefore + 1);
      }),
    ]);
    expect(ctx.errors).toEqual([]);
  });

  it("maintains guarded views, which only read, within limits", async () => {
    let computedBefore = 0;
    const ready = (columns: string[], rows: unknown[][], truncated = false) => ({
      status: "ready",
      columns,
      rows,
      truncated,
    });
    const failed = (message: string) => ({
      status: "error",
      message: expect.stringContaining(message),
    });
    const ctx = await runScenario([
      openTab("a"),
      watch(
        "a",
        "emails",
        guardedView(
          `SELECT upper("email") AS "email" FROM "people" WHERE "active" = ?1 ORDER BY 1`,
          [1],
        ),
      ),
      watch("a", "active", guardedView(`SELECT "count" FROM "active_people"`)),
      waitForView("a", "emails", ready(["email"], [])),
      waitForView("a", "active", ready(["count"], [[0]])),
      write("users", (uow) => {
        uow.create("users", { email: "bob@example.com", active: true });
        uow.create("users", { email: "ada@example.com", active: true });
        uow.create("users", { email: "cy@example.com", active: true });
      }),
      // The view holds two of the three rows.
      waitForView(
        "a",
        "emails",
        ready(["email"], [["ADA@EXAMPLE.COM"], ["BOB@EXAMPLE.COM"]], true),
      ),
      waitForView("a", "active", ready(["count"], [[3]])),
      check(() => {
        computedBefore = activePeopleComputed;
      }),
      // The derived relation reads only users, so writing posts does not compute it again.
      write("post", (uow) => {
        uow.create("posts", { title: "Hello" });
      }),
      watch("a", "posts", postCountView),
      waitForView("a", "posts", [{ count: 1 }]),
      check(() => {
        assert.equal(activePeopleComputed, computedBefore);
      }),

      watch("a", "misspelt", guardedView(`SELECT "email" FROM "person"`)),
      waitForView(
        "a",
        "misspelt",
        failed(`no such table: person. Read one of: people, active_people.`),
      ),
      watch("a", "function", guardedView(`SELECT hex(randomblob(4)) FROM "people"`)),
      waitForView("a", "function", failed("Queries cannot call randomblob().")),
      watch("a", "write", guardedView(`DELETE FROM "active_people"`)),
      waitForView("a", "write", failed("Queries only read")),
      watch("a", "two", guardedView(`SELECT 1; SELECT 2`)),
      waitForView("a", "two", failed("more than one statement")),
      watch("a", "params", guardedView(`SELECT ?1, ?2`, [1])),
      waitForView("a", "params", failed("takes 2 parameters, and was given 1")),
      watch(
        "a",
        "work",
        guardedView(
          `WITH RECURSIVE "n"("i") AS (SELECT 1 UNION ALL SELECT "i" + 1 FROM "n") SELECT count(*) FROM "n"`,
        ),
      ),
      waitForView("a", "work", failed("more than 100000 operations")),
      watch(
        "a",
        "bytes",
        guardedView(`SELECT ${Array(8).fill(`"email"`).join(" || ")} FROM "people" ORDER BY 1`),
      ),
      waitForView("a", "bytes", failed("more than 200 bytes")),
    ]);
    expect(ctx.errors).toEqual([]);
  });

  it("takes the lead from a leader whose heartbeats stopped", async () => {
    const ctx = await runScenario([
      openSilentTab("a"),
      watch("a", "users", usersView),
      waitForView("a", "users", []),
      openTab("b"),
      watch("b", "users", usersView),
      waitForLeader("b"),
      write("users", (uow) => {
        uow.create("users", { email: "ada@example.com", active: true });
      }),
      // Tab a stepped down and sent its views to tab b.
      waitForView("a", "users", [{ email: "ada@example.com" }]),
      waitForView("b", "users", [{ email: "ada@example.com" }]),
      check((ctx) => {
        assert.equal(ctx.databasesOpened, 2);
      }),
    ]);
    expect(ctx.errors).toEqual([]);
  });

  it("reports a read that fails to refresh to its view, and its recovery", async () => {
    const people = { status: "ready", columns: ["email"], truncated: false };
    const ctx = await runScenario([
      openTab("a"),
      write("ada", (uow) => {
        uow.create("users", { email: "ada@example.com", active: true });
      }),
      watch("a", "people", guardedView(`SELECT "email" FROM people ORDER BY "email"`)),
      waitForView("a", "people", { ...people, rows: [["ada@example.com"]] }),
      watch("a", "ada", (client) => appReadViews(client, "ada", undefined)),
      waitForView("a", "ada", { email: "ada@example.com" }),

      // The read fails in the same batch that the guarded view, of an engine refreshed after the
      // read engine, sees.
      write("bob", (uow, vars) => {
        uow.delete("users", vars["ada"]![0]!);
        uow.create("users", { email: "bob@example.com", active: true });
      }),
      waitForError("a", "ada", "Ada is gone."),
      waitForView("a", "people", { ...people, rows: [["bob@example.com"]] }),

      // Ada's return gives the read the data it had before it failed, which it reports again.
      write("ada again", (uow) => {
        uow.create("users", { email: "ada@example.com", active: true });
      }),
      waitForView("a", "ada", { email: "ada@example.com" }),
      check((ctx) => {
        expect(ctx.views.get("a/ada")!.results.map(({ status }) => status)).toEqual([
          "loading",
          "ready",
          "error",
          "ready",
        ]);
      }),
    ]);
    expect(ctx.errors).toEqual([]);
  });

  it("reports a SQL view that fails to refresh to its view, and its recovery", async () => {
    const ctx = await runScenario([
      openTab("a"),
      watch("a", "json", (client) =>
        client.sql({
          sql: `SELECT json("email") AS "email" FROM ${table("users")}`,
          params: [],
          columns: { email: "text" },
        }),
      ),
      waitForView("a", "json", []),
      write("ada", (uow) => {
        uow.create("users", { email: "ada@example.com", active: true });
      }),
      waitForError("a", "json", "malformed JSON"),
      // The view's rows are again what they were before it failed, which it reports again.
      write("gone", (uow, vars) => {
        uow.delete("users", vars["ada"]![0]!);
      }),
      waitForView("a", "json", []),
      check((ctx) => {
        expect(ctx.views.get("a/json")!.results.map(({ status }) => status)).toEqual([
          "loading",
          "ready",
          "error",
          "ready",
        ]);
      }),
    ]);
    expect(ctx.errors).toEqual([]);
  });

  it("refreshes the other engines while one fails, and gives it the tables again", async () => {
    const users = lofiSqliteTableName({ schema: appSchema }, "users");
    const posts = lofiSqliteTableName({ schema: appSchema }, "posts");
    const ctx = await runScenario([
      openTab("a"),
      watch("a", "people", guardedView(`SELECT "email" FROM people ORDER BY "email"`)),
      watch("a", "posts", postCountView),
      waitForView("a", "posts", [{ count: 0 }]),
      check(() => {
        flaky.failures = 1;
        flaky.refreshes = [];
      }),
      // The guarded engine, which refreshes after the failing one, still sees the batch.
      write("ada", (uow) => {
        uow.create("users", { email: "ada@example.com", active: true });
      }),
      waitForView("a", "people", { rows: [["ada@example.com"]] }),
      // The next batch writes only posts, and the failed engine gets users again with it.
      write("post", (uow) => {
        uow.create("posts", { title: "Hello" });
      }),
      waitForView("a", "posts", [{ count: 1 }]),
      check((ctx) => {
        expect(flaky.refreshes).toEqual([[users], [posts, users].sort()]);
        expect(ctx.errors).toEqual([new Error("The flaky engine failed.")]);
      }),
    ]);
    ctx.errors.length = 0;
  });

  it("builds a view whose first run fails once a later batch lets it run", async () => {
    const ctx = await runScenario([
      openTab("a"),
      write("post", (uow) => {
        uow.create("posts", { title: "Hello" });
      }),
      watch("a", "posts", postCountView),
      waitForView("a", "posts", [{ count: 1 }]),
      watch("a", "ada", (client) => appReadViews(client, "ada", undefined)),
      watch("a", "json", (client) =>
        client.sql({
          sql: `SELECT json("title") AS "title" FROM ${table("posts")}`,
          params: [],
          columns: { title: "text" },
        }),
      ),
      waitForError("a", "ada", "Ada is gone."),
      waitForError("a", "json", "malformed JSON"),

      write("ada", (uow) => {
        uow.create("users", { email: "ada@example.com", active: true });
      }),
      waitForView("a", "ada", { email: "ada@example.com" }),
      write("no post", (uow, vars) => {
        uow.delete("posts", vars["post"]![0]!);
      }),
      waitForView("a", "json", []),
      check((ctx) => {
        // The SQL view reads only posts, so writing users did not run it again.
        for (const view of ["a/ada", "a/json"]) {
          expect(ctx.views.get(view)!.results.map(({ status }) => status)).toEqual([
            "loading",
            "error",
            "ready",
          ]);
        }
      }),
    ]);
    expect(ctx.errors).toEqual([]);
  });

  it("keeps trying to open the replica while the backend is down", async () => {
    const unavailable = { error: "Fragno internal request failed: 503 Service Unavailable" };
    const ctx = await runScenario([
      openTab("a"),
      openTab("b"),
      watch("b", "users", usersView),
      waitForView("b", "users", []),

      // The leader closes while the backend is down, so tab b cannot open the replica in its place.
      backendDown(),
      closeTab("a"),
      waitForStatus("b", { phase: "caught-up", ...unavailable }),
      // A tab opened meanwhile connects, and its status says why it has no data.
      openTab("c"),
      waitForStatus("c", { phase: "catching-up", ...unavailable }),
      watch("c", "users", usersView),

      backendUp(),
      write("ada", (uow) => {
        uow.create("users", { email: "ada@example.com", active: true });
      }),
      waitForView("b", "users", [{ email: "ada@example.com" }]),
      waitForView("c", "users", [{ email: "ada@example.com" }]),
      waitForStatus("b", { phase: "caught-up", error: null }),
      waitForStatus("c", { phase: "caught-up", error: null }),
    ]);
    expect(ctx.errors.length).toBeGreaterThan(0);
    expect(new Set(ctx.errors.map(String))).toEqual(new Set([`Error: ${unavailable.error}`]));
    ctx.errors.length = 0;
  });

  it("shares a leader only with tabs that expect the same backend", async () => {
    const ctx = await runScenario([
      openTab("a", "backend"),
      write("ada", (uow) => {
        uow.create("users", { email: "ada@example.com", active: true });
      }),
      watch("a", "users", usersView),
      waitForView("a", "users", [{ email: "ada@example.com" }]),

      // A tab loaded after the backend was replaced does not read the old backend's replica
      // through tab a, and refuses to replicate a backend other than the one it expects.
      failToOpenTab("b", "replacement", "was replaced since the page loaded"),
      check((ctx) => {
        assert.equal(ctx.databasesOpened, 1);
      }),

      // A tab that expects the backend's identity shares tab a's replica.
      openTab("c", "backend"),
      watch("c", "users", usersView),
      waitForView("c", "users", [{ email: "ada@example.com" }]),
      check((ctx) => {
        assert.equal(ctx.databasesOpened, 1);
      }),
    ]);
    expect(ctx.errors).toEqual([]);
  });
});
