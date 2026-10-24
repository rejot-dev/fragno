import { afterEach, assert, describe, expect, it } from "vitest";

import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { BetterSQLite3DriverConfig } from "@fragno-dev/db/drivers";
import { column, idColumn, referenceColumn, schema, type FragnoId } from "@fragno-dev/db/schema";
import BetterSqlite3 from "better-sqlite3";
import { SqliteDialect } from "kysely";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { migrate, withDatabase, type TypedUnitOfWork } from "@fragno-dev/db";

import { openLofiSqliteMemoryFiles } from "../sqlite/testing";
import { connectLofiZql, type LofiZqlResult, type LofiZqlSchemaClient } from "./client";
import { serveLofiZql, type LofiZqlHost } from "./host";

const appSchema = schema("app", (s) =>
  s
    .addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("email", column("string"))
        .addColumn("active", column("bool"))
        .addColumn("joinedAt", column("timestamp"))
        .addColumn("profile", column("json").nullable())
        .addColumn("avatar", column("binary").nullable()),
    )
    .addTable("posts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("authorId", referenceColumn({ table: "users" }))
        .addColumn("title", column("string"))
        .createIndex("idx_author", ["authorId"]),
    ),
);

type AppClient = LofiZqlSchemaClient<typeof appSchema>;

// ---------------------------------------------------------------------------------------------
// Scenario DSL: a fragment on fragno-db's SQLite backend serves the outbox. Each "tab" runs a ZQL
// host, as its worker would, and a client talking to it over a MessageChannel; wa-sqlite's
// in-memory VFS stands in for OPFS.
// ---------------------------------------------------------------------------------------------

type ScenarioContext = {
  tabs: Map<string, { host: LofiZqlHost; client: AppClient; port: MessagePort }>;
  /** Every result a watched view reported, by `<tab>/<view>`. */
  views: Map<string, { results: LofiZqlResult<unknown>[]; unwatch: () => void }>;
  errors: unknown[];
  vars: Record<string, FragnoId[]>;
};

type ScenarioStep =
  | { type: "openTab"; tab: string }
  | { type: "closeTab"; tab: string }
  | { type: "watch"; tab: string; view: string; query: (app: AppClient) => unknown }
  | { type: "unwatch"; tab: string; view: string }
  | {
      type: "write";
      storeIdsAs: string;
      write: (uow: TypedUnitOfWork<typeof appSchema>, vars: ScenarioContext["vars"]) => void;
    }
  | { type: "waitForView"; tab: string; view: string; data: unknown };

const openTab = (tab: string): ScenarioStep => ({ type: "openTab", tab });
const closeTab = (tab: string): ScenarioStep => ({ type: "closeTab", tab });
/** Subscribes to a store of the query's result, like a mounted component. */
const watch = (tab: string, view: string, query: (app: AppClient) => unknown): ScenarioStep => ({
  type: "watch",
  tab,
  view,
  query,
});
const unwatch = (tab: string, view: string): ScenarioStep => ({ type: "unwatch", tab, view });
const write = (
  storeIdsAs: string,
  write: (uow: TypedUnitOfWork<typeof appSchema>, vars: ScenarioContext["vars"]) => void,
): ScenarioStep => ({ type: "write", storeIdsAs, write });
/** Waits until the view's data matches `data`, compared like `toMatchObject`. */
const waitForView = (tab: string, view: string, data: unknown): ScenarioStep => ({
  type: "waitForView",
  tab,
  view,
  data,
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function runZqlScenario(steps: ScenarioStep[]): Promise<ScenarioContext> {
  const server = new BetterSqlite3(":memory:");
  const adapter = new SqlAdapter({
    dialect: new SqliteDialect({ database: server }),
    driverConfig: new BetterSQLite3DriverConfig(),
  });
  const fragment = instantiate(defineFragment("zql-app").extend(withDatabase(appSchema)).build())
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

  const ctx: ScenarioContext = { tabs: new Map(), views: new Map(), errors: [], vars: {} };
  cleanups.push(async () => {
    for (const { unwatch } of ctx.views.values()) {
      unwatch();
    }
    for (const { host, port } of ctx.tabs.values()) {
      await host.close();
      port.close();
    }
    await adapter.close();
    server.close();
  });

  for (const step of steps) {
    switch (step.type) {
      case "openTab": {
        const channel = new MessageChannel();
        const host = await serveLofiZql({
          replica: {
            baseUrl: "http://zql.test",
            fetch: fetch as typeof globalThis.fetch,
            schemas: [{ schema: appSchema }],
            localSchemas: [],
            projections: [],
            ephemeralTables: [],
            onError: (error) => ctx.errors.push(error),
            retryDelayMs: 10,
          },
          port: channel.port1,
          openDatabase: files.open,
        });
        const client = (
          await connectLofiZql({ port: channel.port2, schemas: [{ schema: appSchema }] })
        ).forSchema(appSchema);
        ctx.tabs.set(step.tab, { host, client, port: channel.port2 });
        break;
      }
      case "closeTab": {
        const { host, port } = ctx.tabs.get(step.tab)!;
        ctx.tabs.delete(step.tab);
        await host.close();
        port.close();
        break;
      }
      case "watch": {
        const { client } = ctx.tabs.get(step.tab)!;
        const store = client.store(step.query(client) as never);
        const results: LofiZqlResult<unknown>[] = [];
        const unwatch = store.subscribe((result) => {
          results.push(result);
        });
        ctx.views.set(`${step.tab}/${step.view}`, { results, unwatch });
        break;
      }
      case "unwatch": {
        const key = `${step.tab}/${step.view}`;
        ctx.views.get(key)!.unwatch();
        ctx.views.delete(key);
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
      case "waitForView":
        await expect
          .poll(() => ctx.views.get(`${step.tab}/${step.view}`)!.results.at(-1), {
            timeout: 2_000,
          })
          .toMatchObject({ status: "ready", data: step.data });
        break;
    }
  }
  return ctx;
}

const joinedAt = new Date("2026-01-02T03:04:05.000Z");
const user = (email: string, active = true) => ({ email, active, joinedAt, profile: null });

describe("Lofi ZQL", () => {
  it("maintains filtered, ordered, limited views with related rows as the outbox changes them", async () => {
    const ctx = await runZqlScenario([
      openTab("a"),
      write("users", (uow) => {
        uow.create("users", {
          ...user("ada@example.com"),
          profile: { langs: ["en"] },
          avatar: new Uint8Array([1]),
        });
        uow.create("users", user("bob@example.com", false));
      }),
      write("posts", (uow, vars) => {
        uow.create("posts", { authorId: vars["users"]![0]!, title: "b" });
        uow.create("posts", { authorId: vars["users"]![1]!, title: "c" });
        uow.create("posts", { authorId: vars["users"]![0]!, title: "d" });
      }),
      watch("a", "firstTwo", (app) =>
        app.query.posts.orderBy("title", "asc").limit(2).related("author"),
      ),
      watch("a", "byActiveAuthors", (app) =>
        app.query.posts
          .whereExists("author", (author) => author.where("active", true))
          .orderBy("title", "asc"),
      ),
      watch("a", "ada", (app) => app.query.users.where("email", "ada@example.com").one()),
      waitForView("a", "firstTwo", [
        { title: "b", author: { email: "ada@example.com" } },
        { title: "c", author: { email: "bob@example.com" } },
      ]),
      waitForView("a", "byActiveAuthors", [{ title: "b" }, { title: "d" }]),
      waitForView("a", "ada", {
        email: "ada@example.com",
        active: true,
        joinedAt: joinedAt.getTime(),
        profile: { langs: ["en"] },
        _version: 0,
      }),

      // A post sorting first pushes the last one out of the window.
      write("first", (uow, vars) => {
        uow.create("posts", { authorId: vars["users"]![1]!, title: "a" });
      }),
      waitForView("a", "firstTwo", [
        { title: "a", author: { email: "bob@example.com" } },
        { title: "b", author: { email: "ada@example.com" } },
      ]),

      // Editing a related row reaches every post that relates to it, and the EXISTS filter.
      write("activated", (uow, vars) => {
        uow.update("users", vars["users"]![1]!, (b) =>
          b.set({ email: "bobby@example.com", active: true }),
        );
      }),
      waitForView("a", "firstTwo", [
        { title: "a", author: { email: "bobby@example.com" } },
        { title: "b", author: { email: "ada@example.com" } },
      ]),
      waitForView("a", "byActiveAuthors", [
        { title: "a" },
        { title: "b" },
        { title: "c" },
        { title: "d" },
      ]),

      // Removing posts from the window refills it from beyond, including with a post the same batch
      // creates, which every change before its own must not see.
      write("removed", (uow, vars) => {
        uow.delete("posts", vars["first"]![0]!);
        uow.update("posts", vars["posts"]![0]!, (b) => b.set({ title: "e" }));
        uow.create("posts", { authorId: vars["users"]![0]!, title: "ba" });
      }),
      waitForView("a", "firstTwo", [
        { title: "ba", author: { email: "ada@example.com" } },
        { title: "c", author: { email: "bobby@example.com" } },
      ]),
      waitForView("a", "ada", { email: "ada@example.com", _version: 0 }),

      // A view watched later starts from the current rows.
      unwatch("a", "firstTwo"),
      watch("a", "all", (app) => app.query.posts.orderBy("title", "desc").related("author")),
      waitForView("a", "all", [
        { title: "e", author: { email: "ada@example.com" } },
        { title: "d", author: { email: "ada@example.com" } },
        { title: "c", author: { email: "bobby@example.com" } },
        { title: "ba", author: { email: "ada@example.com" } },
      ]),

      // Each change of a batch is pushed against the rows before it, also across tables: the
      // author's creation must not find the post created after it.
      write("cy", (uow) => {
        const cy = uow.create("users", user("cy@example.com"));
        uow.create("posts", { authorId: cy, title: "f" });
      }),
      waitForView("a", "all", [
        { title: "f", author: { email: "cy@example.com" } },
        { title: "e", author: { email: "ada@example.com" } },
        { title: "d", author: { email: "ada@example.com" } },
        { title: "c", author: { email: "bobby@example.com" } },
        { title: "ba", author: { email: "ada@example.com" } },
      ]),
    ]);
    expect(ctx.errors).toEqual([]);
  });

  it("builds a tab's views again from the rows another tab writes, and incrementally once it writes itself", async () => {
    const ctx = await runZqlScenario([
      openTab("a"),
      openTab("b"),
      watch("b", "users", (app) => app.query.users.orderBy("email", "asc")),
      waitForView("b", "users", []),
      write("ada", (uow) => {
        uow.create("users", user("ada@example.com"));
      }),
      waitForView("b", "users", [{ email: "ada@example.com" }]),
      // Tab b takes over writing.
      closeTab("a"),
      write("bob", (uow) => {
        uow.create("users", user("bob@example.com"));
      }),
      waitForView("b", "users", [{ email: "ada@example.com" }, { email: "bob@example.com" }]),
      write("removed", (uow, vars) => {
        uow.delete("users", vars["ada"]![0]!);
      }),
      waitForView("b", "users", [{ email: "bob@example.com" }]),
    ]);
    expect(ctx.errors).toEqual([]);
  });
});
