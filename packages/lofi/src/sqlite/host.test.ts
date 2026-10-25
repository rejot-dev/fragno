import { afterEach, assert, describe, expect, it } from "vitest";

import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { BetterSQLite3DriverConfig } from "@fragno-dev/db/drivers";
import { column, idColumn, schema, type FragnoId } from "@fragno-dev/db/schema";
import BetterSqlite3 from "better-sqlite3";
import { SqliteDialect } from "kysely";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { migrate, withDatabase, type TypedUnitOfWork } from "@fragno-dev/db";

import type { LofiSqliteClient, LofiSqliteView, LofiSqliteViewResult } from "./client";
import { lofiSqliteTableName, quoteSqliteIdentifier } from "./layout";
import { openLofiSqliteMemoryFiles, openLofiSqliteTab } from "./testing";

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
};

type ScenarioStep =
  | { type: "openTab"; tab: string; beats: boolean }
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
  | { type: "waitForLeader"; tab: string }
  | { type: "check"; check: (ctx: ScenarioContext) => void };

const openTab = (tab: string): ScenarioStep => ({ type: "openTab", tab, beats: true });
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
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    return await fragment.callRouteRaw(
      "GET",
      url.pathname as never,
      { query: url.searchParams, signal: init?.signal ?? undefined } as never,
    );
  };
  const files = await openLofiSqliteMemoryFiles({ statementDelayMs: 0 });

  const ctx: ScenarioContext = {
    tabs: new Map(),
    views: new Map(),
    errors: [],
    vars: {},
    databasesOpened: 0,
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
      case "openTab":
        ctx.tabs.set(
          step.tab,
          await openLofiSqliteTab({
            replica: {
              baseUrl: "http://host.test",
              fetch: fetch as typeof globalThis.fetch,
              schemas: [{ schema: appSchema }],
              localSchemas: [],
              projections: [],
              ephemeralTables: [],
              onError: (error) => ctx.errors.push(error),
              retryDelayMs: 10,
            },
            engines: [],
            openDatabase: async (open) => {
              ctx.databasesOpened++;
              return await files.open(open);
            },
            heartbeatIntervalMs: step.beats ? 20 : 60 * 60_000,
            leaderTimeoutMs: 200,
          }),
        );
        break;
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
});
