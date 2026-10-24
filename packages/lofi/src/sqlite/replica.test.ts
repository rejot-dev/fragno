import { afterEach, describe, expect, it, assert } from "vitest";

import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { BetterSQLite3DriverConfig } from "@fragno-dev/db/drivers";
import {
  column,
  FragnoId,
  FragnoReference,
  idColumn,
  referenceColumn,
  schema,
  type AnySchema,
  type TableBuilder,
} from "@fragno-dev/db/schema";
import BetterSqlite3 from "better-sqlite3";
import { SqliteDialect } from "kysely";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { migrate, withDatabase, type TypedUnitOfWork } from "@fragno-dev/db";

import { defineLocalProjection } from "../local/projection";
import {
  LOFI_SQLITE_ENDPOINT_NAME,
  openLofiSqliteReplica,
  type LofiSqliteReplica,
  type LofiSqliteReplicaOptions,
  type LofiSqliteReplicaStatus,
} from "./replica";
import { openLofiSqliteMemoryFiles } from "./testing";
import { decodeLofiSqliteRow } from "./values";

const LONG_TABLE_NAME = "workspaceMembershipInvitationAuditTrailEntriesForComplianceReview";

const addUsersTable = (t: TableBuilder<{}, {}>) =>
  t
    .addColumn("id", idColumn())
    .addColumn("email", column("string"))
    .addColumn("age", column("integer"))
    .addColumn("active", column("bool"))
    .addColumn("joinedAt", column("timestamp"))
    .addColumn("profile", column("json").nullable())
    .addColumn("balance", column("bigint"))
    .addColumn("avatar", column("binary").nullable())
    .createIndex("idx_email", ["email"], { unique: true });

const appSchema = schema("app", (s) =>
  s
    .addTable("users", addUsersTable)
    .addTable("posts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("authorId", referenceColumn({ table: "users" }))
        .addColumn("title", column("string"))
        .createIndex("idx_author_title", ["authorId", "title"]),
    )
    .addTable("typing", (t) =>
      t.addColumn("id", idColumn()).addColumn("userEmail", column("string")),
    )
    .addTable(LONG_TABLE_NAME, (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("action", column("string"))
        .createIndex("idx_action_recorded_for_compliance_review_purposes", ["action"]),
    ),
);

/** The same schema as the server's, but missing a table the server writes. */
const appSchemaWithoutPosts = schema("app", (s) => s.addTable("users", addUsersTable));

const otherSchema = schema("other", (s) =>
  s.addTable("notes", (t) => t.addColumn("id", idColumn()).addColumn("body", column("string"))),
);

const statsSchema = schema("stats", (s) =>
  s.addTable("authorStats", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("posts", column("integer"))
      .addColumn("updatedAt", column("timestamp")),
  ),
);

const statsSchemaV2 = schema("stats", (s) =>
  s
    .addTable("authorStats", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("posts", column("integer"))
        .addColumn("updatedAt", column("timestamp")),
    )
    .alterTable("authorStats", (t) => t.addColumn("note", column("string").nullable())),
);

const boardSchema = schema("board", (s) =>
  s
    .addTable("lists", (t) => t.addColumn("id", idColumn()).addColumn("title", column("string")))
    .addTable("cards", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("listId", referenceColumn({ table: "lists" }).nullable())
        .addColumn("label", column("string")),
    ),
);

const countPostsPerAuthor = defineLocalProjection({
  retrieve: ({ match, read }) =>
    read.getEach(
      [
        ...new Set(
          match.all(appSchema, "posts", "create").map((post) => String(post.values.authorId)),
        ),
      ],
      statsSchema,
      "authorStats",
      (authorId) => authorId,
    ),
  mutate: ({ mutations, retrieved, tx }) => {
    const stats = tx.forSchema(statsSchema);
    for (const { item: authorId, row } of retrieved) {
      const created = mutations.filter(
        (mutation) =>
          mutation.op === "create" &&
          mutation.table === "posts" &&
          String(mutation.values["authorId"]) === authorId,
      ).length;
      if (row) {
        stats.update("authorStats", row.id, (b) =>
          b.set({ posts: row.posts + created, updatedAt: b.now() }).check(),
        );
      } else {
        stats.create("authorStats", { id: authorId, posts: created, updatedAt: new Date() });
      }
    }
  },
});

/** Always expects a version the stats row never has, so its entry cannot commit. */
const rejectSecondPost = defineLocalProjection({
  retrieve: ({ match, read }) =>
    read.getEach(match.all(appSchema, "posts", "create"), statsSchema, "authorStats", (post) =>
      String(post.values.authorId),
    ),
  mutate: ({ retrieved, tx }) => {
    const stats = tx.forSchema(statsSchema);
    for (const { item: post, row } of retrieved) {
      if (row) {
        stats.update("authorStats", FragnoId.fromExternal(row.id.externalId, 99), (b) =>
          b.set({ posts: row.posts + 1 }).check(),
        );
      } else {
        stats.create("authorStats", {
          id: String(post.values.authorId),
          posts: 1,
          updatedAt: new Date(),
        });
      }
    }
  },
});

/**
 * Exercises every way a projection writes: creating over an existing id, updating a missing row,
 * deleting, and referencing rows by external id, by a `FragnoId` with or without an internal id,
 * and by a `FragnoReference`, including a row that does not exist yet.
 */
const boardProjection = defineLocalProjection({
  retrieve: ({ read }) => ({ shared: read.get(boardSchema, "lists", "shared") }),
  mutate: ({ match, retrieved, tx }) => {
    const board = tx.forSchema(boardSchema);
    for (const user of match.all(appSchema, "users", "create")) {
      const email = user.values.email;
      board.create("lists", { id: "shared", title: email });
      const list = board.create("lists", { id: `list-${email}`, title: email });
      board.create("cards", { id: `card-${email}`, listId: list, label: "same entry" });
      board.create("cards", {
        id: `late-${email}`,
        listId: "list-later@example.com",
        label: "late",
      });
      board.update("lists", "missing", (b) => b.set({ title: email }));
      if (retrieved.shared) {
        board.create("cards", {
          id: `copy-${email}`,
          listId: retrieved.shared.id,
          label: "FragnoId",
        });
        board.create("cards", {
          id: `ref-${email}`,
          listId: FragnoReference.fromInternal(retrieved.shared.id.internalId!),
          label: "FragnoReference",
        });
      }
    }
    if (match.all(appSchema, "users", "delete").length > 0) {
      board.delete("lists", "shared");
    }
  },
});

// ---------------------------------------------------------------------------------------------
// Scenario DSL: fragments on fragno-db's SQLite backend serve the outbox; each "tab" opens the
// replica through Node's Web Locks and BroadcastChannel, with wa-sqlite's in-memory VFS standing
// in for OPFS.
// ---------------------------------------------------------------------------------------------

type ReplicaConfig = Omit<LofiSqliteReplicaOptions, "baseUrl" | "fetch" | "onError">;

type ScenarioContext = {
  server: BetterSqlite3.Database;
  tabs: Map<string, LofiSqliteReplica>;
  notifications: Map<string, number>;
  /** Every status each tab reported, starting with the one it opened with. */
  statuses: Map<string, LofiSqliteReplicaStatus[]>;
  /** Mirrored users each closed tab had committed when it started closing. */
  usersAtClose: Map<string, number>;
  /** The SQL of every call any tab made to its database, in order. */
  databaseCalls: string[];
  errors: unknown[];
  vars: Record<string, FragnoId[]>;
};

type ScenarioStep =
  | { type: "openTab"; tab: string; replica: ReplicaConfig }
  | { type: "closeTab"; tab: string }
  | { type: "closeTabAfterEntries"; tab: string; entries: number }
  | { type: "setStreamAvailable"; available: boolean }
  | { type: "deliverStreamInBursts" }
  | { type: "grantAbortedLockRequests" }
  | {
      type: "write";
      schema: AnySchema;
      storeIdsAs: string;
      write: (uow: TypedUnitOfWork<AnySchema>, vars: ScenarioContext["vars"]) => void;
    }
  | { type: "waitForRows"; tab: string; sql: string; rows: unknown[] }
  | { type: "waitForError"; message: string }
  | { type: "waitForStatus"; tab: string; status: LofiSqliteReplicaStatus }
  | { type: "assert"; assert: (ctx: ScenarioContext) => void | Promise<void> };

const openTab = (tab: string, replica: ReplicaConfig): ScenarioStep => ({
  type: "openTab",
  tab,
  replica,
});
const closeTab = (tab: string): ScenarioStep => ({ type: "closeTab", tab });
/** Closes the tab from its change listener, while its catch-up is still applying entries. */
const closeTabAfterEntries = (tab: string, entries: number): ScenarioStep => ({
  type: "closeTabAfterEntries",
  tab,
  entries,
});
/** Answers stream requests with 503, as a backend outage would. */
const setStreamAvailable = (available: boolean): ScenarioStep => ({
  type: "setStreamAvailable",
  available,
});
/**
 * Delivers stream bytes in bursts, so frames that follow one another, such as the last entries and
 * the caught-up marker, reach the client in one chunk.
 */
const deliverStreamInBursts = (): ScenarioStep => ({ type: "deliverStreamInBursts" });
/**
 * Makes Web Locks behave as observed in Chrome: an aborted request rejects, but stays queued and
 * is granted later.
 */
const grantAbortedLockRequests = (): ScenarioStep => ({ type: "grantAbortedLockRequests" });
function write<TSchema extends AnySchema>(
  schema: TSchema,
  storeIdsAs: string,
  write: (uow: TypedUnitOfWork<TSchema>, vars: ScenarioContext["vars"]) => void,
): ScenarioStep {
  return { type: "write", schema, storeIdsAs, write: write as never };
}
const waitForRows = (tab: string, sql: string, rows: unknown[]): ScenarioStep => ({
  type: "waitForRows",
  tab,
  sql,
  rows,
});
const waitForError = (message: string): ScenarioStep => ({ type: "waitForError", message });
const waitForStatus = (tab: string, status: LofiSqliteReplicaStatus): ScenarioStep => ({
  type: "waitForStatus",
  tab,
  status,
});
const assertStep = (assert: (ctx: ScenarioContext) => void | Promise<void>): ScenarioStep => ({
  type: "assert",
  assert,
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** The server's outbox entries at or below the versionstamp the tab's replica has applied through. */
async function appliedEntries(
  server: BetterSqlite3.Database,
  tab: LofiSqliteReplica,
): Promise<number> {
  const [row] = await tab.execute(`SELECT "value" FROM "lofi_meta" WHERE "key" = ?`, [
    `applied-through:${LOFI_SQLITE_ENDPOINT_NAME}::outbox`,
  ]);
  if (!row) {
    return 0;
  }
  const { count } = server
    .prepare(`SELECT count(*) AS "count" FROM "fragno_db_outbox" WHERE "versionstamp" <= ?`)
    .get(row["value"]) as { count: number };
  return count;
}

async function runReplicaScenario(scenario: {
  serverSchemas: AnySchema[];
  /** Delays every replica statement, like a slow OPFS write, to keep a catch-up observable. */
  statementDelayMs: number;
  steps: ScenarioStep[];
}): Promise<void> {
  const server = new BetterSqlite3(":memory:");
  const adapter = new SqlAdapter({
    dialect: new SqliteDialect({ database: server }),
    driverConfig: new BetterSQLite3DriverConfig(),
  });
  const fragments = scenario.serverSchemas.map((serverSchema) =>
    instantiate(
      defineFragment(`replica-${serverSchema.name}`).extend(withDatabase(serverSchema)).build(),
    )
      .withConfig({})
      .withRoutes([])
      .withOptions({ databaseAdapter: adapter, outbox: { enabled: true } })
      .build(),
  );
  for (const fragment of fragments) {
    await migrate(fragment);
  }

  let streamAvailable = true;
  let streamInBursts = false;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (!streamAvailable && url.pathname.endsWith("/stream")) {
      return new Response("unavailable", { status: 503 });
    }
    const response = await fragments[0]!.callRouteRaw(
      "GET",
      url.pathname as never,
      {
        query: url.searchParams,
        signal: init?.signal ?? undefined,
      } as never,
    );
    return streamInBursts && url.pathname.endsWith("/stream") && response.body
      ? new Response(inBursts(response.body, 50), response)
      : response;
  };
  const files = await openLofiSqliteMemoryFiles({ statementDelayMs: scenario.statementDelayMs });

  const ctx: ScenarioContext = {
    server,
    tabs: new Map(),
    notifications: new Map(),
    statuses: new Map(),
    usersAtClose: new Map(),
    databaseCalls: [],
    errors: [],
    vars: {},
  };
  const openDatabase: typeof files.open = async (options) => {
    const database = await files.open(options);
    return {
      ...database,
      execute: (sql, params) => {
        ctx.databaseCalls.push(sql);
        return database.execute(sql, params);
      },
    };
  };
  cleanups.push(async () => {
    for (const tab of ctx.tabs.values()) {
      await tab.close();
    }
    await adapter.close();
    server.close();
  });

  for (const step of scenario.steps) {
    switch (step.type) {
      case "openTab": {
        const replica = await openLofiSqliteReplica(
          {
            ...step.replica,
            baseUrl: "http://replica.test",
            fetch: fetch as typeof globalThis.fetch,
            onError: (error) => ctx.errors.push(error),
          },
          { openDatabase },
        );
        ctx.notifications.set(step.tab, 0);
        replica.subscribe(() =>
          ctx.notifications.set(step.tab, ctx.notifications.get(step.tab)! + 1),
        );
        const statuses = [replica.getStatus()];
        ctx.statuses.set(step.tab, statuses);
        replica.subscribeStatus(() => statuses.push(replica.getStatus()));
        ctx.tabs.set(step.tab, replica);
        break;
      }
      case "closeTab":
        await ctx.tabs.get(step.tab)!.close();
        ctx.tabs.delete(step.tab);
        break;
      case "closeTabAfterEntries": {
        const tab = ctx.tabs.get(step.tab)!;
        ctx.tabs.delete(step.tab);
        // Counts from the tab's opening, through the listener the scenario registered first.
        await new Promise<void>((resolve) => {
          const unsubscribe = tab.subscribe(() => {
            if (ctx.notifications.get(step.tab)! >= step.entries) {
              unsubscribe();
              resolve();
            }
          });
        });
        const [row] = await tab.execute(`SELECT count(*) AS "count" FROM "users_app"`);
        ctx.usersAtClose.set(step.tab, row!["count"] as number);
        await tab.close();
        break;
      }
      case "setStreamAvailable":
        streamAvailable = step.available;
        break;
      case "deliverStreamInBursts":
        streamInBursts = true;
        break;
      case "grantAbortedLockRequests": {
        const locks = navigator.locks;
        const request = locks.request.bind(locks) as (
          name: string,
          options: LockOptions,
          callback: LockGrantedCallback<unknown>,
        ) => Promise<unknown>;
        Object.defineProperty(locks, "request", {
          configurable: true,
          value: (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => {
            const { signal, ...queued } = options;
            const granted = request(name, queued, callback);
            return new Promise((resolve, reject) => {
              granted.then(resolve, reject);
              signal?.addEventListener("abort", () => {
                reject(new DOMException("The request was aborted.", "AbortError"));
              });
            });
          },
        });
        cleanups.push(async () => {
          delete (locks as { request?: unknown }).request;
        });
        break;
      }
      case "write": {
        const uow = adapter.createUnitOfWork(step.schema, step.schema.name);
        step.write(uow, ctx.vars);
        const { success } = await uow.executeMutations();
        assert(success);
        ctx.vars[step.storeIdsAs] = uow.getCreatedIds();
        break;
      }
      case "waitForRows":
        await expect
          .poll(() => ctx.tabs.get(step.tab)!.execute(step.sql), { timeout: 5_000 })
          .toEqual(step.rows);
        break;
      case "waitForError":
        await expect
          .poll(() => ctx.errors.map(String), { timeout: 5_000 })
          .toContainEqual(expect.stringContaining(step.message));
        break;
      case "waitForStatus":
        await expect
          .poll(() => ctx.statuses.get(step.tab)!.at(-1), { timeout: 5_000 })
          .toEqual(step.status);
        break;
      case "assert":
        await step.assert(ctx);
        break;
    }
  }
}

/** Holds bytes back and passes on everything received every `intervalMs` as one chunk. */
function inBursts(
  body: ReadableStream<Uint8Array>,
  intervalMs: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let pending: Uint8Array[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  return new ReadableStream({
    start(controller) {
      const flush = () => {
        if (pending.length > 0) {
          controller.enqueue(new Uint8Array(Buffer.concat(pending)));
          pending = [];
        }
      };
      timer = setInterval(flush, intervalMs);
      void (async () => {
        try {
          for (let read = await reader.read(); !read.done; read = await reader.read()) {
            pending.push(read.value);
          }
          clearInterval(timer);
          flush();
          controller.close();
        } catch (error) {
          clearInterval(timer);
          controller.error(error);
        }
      })();
    },
    async cancel(reason) {
      clearInterval(timer);
      await reader.cancel(reason);
    },
  });
}

type Layout = Record<string, { columns: string[]; indexes: Record<string, string[]> }>;

/** Tables, columns, and named indexes, without SQLite's own and Lofi's bookkeeping tables. */
async function describeLayout(
  query: (sql: string) => Promise<ReadonlyArray<Record<string, unknown>>>,
  tables: (name: string) => boolean,
): Promise<Layout> {
  const layout: Layout = {};
  const names = await query(`SELECT "name" FROM sqlite_master WHERE "type" = 'table'`);
  for (const { name } of names) {
    if (!tables(name as string)) {
      continue;
    }
    const quoted = `"${name as string}"`;
    const columns = (await query(`PRAGMA table_info(${quoted})`)).map((row) => row["name"]);
    const indexes: Record<string, string[]> = {};
    for (const index of await query(`PRAGMA index_list(${quoted})`)) {
      const indexName = index["name"] as string;
      if (indexName.startsWith("sqlite_autoindex")) {
        continue;
      }
      indexes[indexName] = (await query(`PRAGMA index_info("${indexName}")`)).map(
        (row) => row["name"] as string,
      );
    }
    layout[name as string] = { columns: (columns as string[]).sort(), indexes };
  }
  return layout;
}

const user = (email: string) => ({
  email,
  age: 1,
  active: true,
  joinedAt: new Date(0),
  profile: null,
  balance: 0n,
});

const replica = (config: Partial<ReplicaConfig>): ReplicaConfig => ({
  schemas: [{ schema: appSchema }],
  localSchemas: [],
  projections: [],
  ephemeralTables: [],
  retryDelayMs: 20,
  ...config,
});

describe("SQLite replica", () => {
  it("mirrors creates, patch updates, deletes, and truncates in the backend's table layout", async () => {
    const joinedAt = new Date("2026-01-02T03:04:05.000Z");
    const balance = 2n ** 60n + 7n;

    await runReplicaScenario({
      serverSchemas: [appSchema],
      statementDelayMs: 0,
      steps: [
        openTab("a", replica({})),
        assertStep(async ({ server, tabs }) => {
          const isFragnoTable = (name: string) =>
            !name.startsWith("sqlite_") && !name.startsWith("lofi_") && !name.startsWith("fragno_");
          const serverLayout = await describeLayout(
            async (sql) => server.prepare(sql).all() as Record<string, unknown>[],
            isFragnoTable,
          );
          const replicaLayout = await describeLayout(
            (sql) => tabs.get("a")!.execute(sql),
            isFragnoTable,
          );
          expect(Object.keys(serverLayout)).toHaveLength(4);
          // Names longer than 63 characters are shortened with a hash on both sides.
          assert(Object.keys(serverLayout).some((name) => name.length === 63));
          expect(replicaLayout).toEqual(serverLayout);
        }),
        write(appSchema, "users", (uow) => {
          uow.create("users", {
            email: "ada@example.com",
            age: 36,
            active: true,
            joinedAt,
            profile: { langs: ["en"] },
            balance,
            avatar: new Uint8Array([1, 2, 3]),
          });
          uow.create("users", {
            email: "bob@example.com",
            age: 20,
            active: false,
            joinedAt,
            profile: null,
            balance: -1n,
          });
        }),
        write(appSchema, "posts", (uow, vars) => {
          uow.create("posts", { authorId: vars["users"]![0]!, title: "Hello" });
          uow.create("posts", { authorId: vars["users"]![1]!, title: "Bye" });
        }),
        waitForRows(
          "a",
          `SELECT u."email", u."age", u."active", u."joinedAt", u."profile", u."balance", u."_version", p."title"
           FROM "posts_app" p JOIN "users_app" u ON p."authorId" = u."_internalId" ORDER BY p."title"`,
          [
            {
              email: "bob@example.com",
              age: 20,
              active: 0,
              joinedAt: joinedAt.getTime(),
              profile: null,
              balance: -1,
              _version: 0,
              title: "Bye",
            },
            {
              email: "ada@example.com",
              age: 36,
              active: 1,
              joinedAt: joinedAt.getTime(),
              profile: '{"langs":["en"]}',
              balance,
              _version: 0,
              title: "Hello",
            },
          ],
        ),
        write(appSchema, "updated", (uow, vars) => {
          uow.update("users", vars["users"]![0]!, (b) => b.set({ age: 37 }));
          uow.delete("posts", vars["posts"]![1]!);
        }),
        waitForRows("a", `SELECT "email", "age", "_version" FROM "users_app" ORDER BY "email"`, [
          { email: "ada@example.com", age: 37, _version: 1 },
          { email: "bob@example.com", age: 20, _version: 0 },
        ]),
        waitForRows("a", `SELECT "title" FROM "posts_app"`, [{ title: "Hello" }]),
        assertStep(async ({ tabs }) => {
          const [row] = await tabs
            .get("a")!
            .execute(`SELECT * FROM "users_app" WHERE "email" = 'ada@example.com'`);
          const decoded = decodeLofiSqliteRow(appSchema.tables.users, row!);
          expect(decoded).toMatchObject({
            email: "ada@example.com",
            age: 37,
            active: true,
            joinedAt,
            profile: { langs: ["en"] },
            balance,
            avatar: new Uint8Array([1, 2, 3]),
          });
          expect(decoded["id"]).toBeInstanceOf(FragnoId);
          assert((decoded["id"] as FragnoId).version === 1);

          const [post] = await tabs.get("a")!.execute(`SELECT * FROM "posts_app"`);
          const decodedPost = decodeLofiSqliteRow(appSchema.tables.posts, post!);
          expect(decodedPost["authorId"]).toBeInstanceOf(FragnoReference);
          expect((decodedPost["authorId"] as FragnoReference).internalId).toBe(
            (decoded["id"] as FragnoId).internalId,
          );

          const { users } = appSchema.tables;
          const authors = await tabs.get("a")!.query({
            sql: `SELECT "users"."email", "users"."joinedAt", "users"."profile", "users"."active",
                    count("posts"."_internalId") AS "posts"
                  FROM "users_app" AS "users"
                  LEFT JOIN "posts_app" AS "posts" ON "posts"."authorId" = "users"."_internalId"
                  WHERE "users"."balance" > ?
                  GROUP BY "users"."_internalId"`,
            params: [0],
            columns: {
              email: "text",
              joinedAt: users.columns.joinedAt,
              profile: users.columns.profile,
              active: users.columns.active,
              posts: "integer",
            },
          });
          expect(authors).toEqual([
            {
              email: "ada@example.com",
              joinedAt,
              profile: { langs: ["en"] },
              active: true,
              posts: 1,
            },
          ]);
          // Timestamps exceed 32 bits, which wa-sqlite would bind as REAL and divide as floats.
          const [elapsed] = await tabs.get("a")!.query({
            sql: `SELECT ("joinedAt" - ?1) / ?2 AS "hours" FROM "users_app" WHERE "email" = ?3`,
            params: [joinedAt.getTime() - 90 * 60_000, 60 * 60_000, "ada@example.com"],
            columns: { hours: "integer" },
          });
          expect(elapsed).toEqual({ hours: 1 });
          await expect(
            tabs.get("a")!.query({
              sql: `SELECT "email" FROM "users_app"`,
              params: [],
              columns: { age: "integer" },
            }),
          ).rejects.toThrow('Query result has no column "age"');
        }),
        write(appSchema, "truncated", (uow, vars) => {
          uow.delete("users", vars["users"]![1]!, (b) => b.omitOutbox());
          uow.outbox.notifyTruncate("users", {
            match: { email: "bob@example.com" },
            externalIds: [vars["users"]![1]!.externalId],
          });
        }),
        waitForRows("a", `SELECT "email" FROM "users_app"`, [{ email: "ada@example.com" }]),
      ],
    });
  });

  it("keeps rows whose deletion never reached the outbox next to rows reusing their unique values", async () => {
    await runReplicaScenario({
      serverSchemas: [appSchema],
      statementDelayMs: 0,
      steps: [
        openTab("a", replica({})),
        write(appSchema, "first", (uow) => {
          uow.create("users", user("ada@example.com"));
        }),
        write(appSchema, "removed", (uow, vars) => {
          uow.delete("users", vars["first"]![0]!, (b) => b.omitOutbox());
        }),
        write(appSchema, "second", (uow) => {
          uow.create("users", { ...user("ada@example.com"), age: 2 });
        }),
        waitForRows(
          "a",
          `SELECT "email", "age" FROM "users_app" WHERE "email" = 'ada@example.com' ORDER BY "age"`,
          [
            { email: "ada@example.com", age: 1 },
            { email: "ada@example.com", age: 2 },
          ],
        ),
        assertStep(({ errors }) => {
          expect(errors).toEqual([]);
        }),
      ],
    });
  });

  it("skips ephemeral tables and schemas it does not mirror", async () => {
    await runReplicaScenario({
      serverSchemas: [appSchema, otherSchema],
      statementDelayMs: 0,
      steps: [
        openTab("a", replica({ ephemeralTables: [{ schema: "app", table: "typing" }] })),
        write(otherSchema, "notes", (uow) => {
          uow.create("notes", { body: "not mirrored" });
        }),
        write(appSchema, "mixed", (uow) => {
          uow.create("typing", { userEmail: "ada@example.com" });
          uow.create("users", user("ada@example.com"));
        }),
        waitForRows("a", `SELECT "email" FROM "users_app"`, [{ email: "ada@example.com" }]),
        waitForRows("a", `SELECT count(*) AS "count" FROM "typing_app"`, [{ count: 0 }]),
        assertStep(async ({ server, tabs, errors }) => {
          expect(errors).toEqual([]);
          const tab = tabs.get("a")!;
          expect(
            await tab.execute(`SELECT "name" FROM sqlite_master WHERE "name" = 'notes_other'`),
          ).toEqual([]);
          // The skipped entry still counts as processed, so the cursor moves past it.
          assert.strictEqual(await appliedEntries(server, tab), 2);
        }),
      ],
    });
  });

  it("stops at a table the client's schema does not know and keeps the earlier rows", async () => {
    await runReplicaScenario({
      serverSchemas: [appSchema],
      statementDelayMs: 0,
      steps: [
        openTab("a", replica({ schemas: [{ schema: appSchemaWithoutPosts }] })),
        write(appSchema, "users", (uow) => {
          uow.create("users", user("ada@example.com"));
        }),
        write(appSchema, "posts", (uow, vars) => {
          uow.create("posts", { authorId: vars["users"]![0]!, title: "Hello" });
        }),
        waitForError("Unknown outbox table: app.posts"),
        assertStep(async ({ server, tabs }) => {
          const tab = tabs.get("a")!;
          expect(await tab.execute(`SELECT "email" FROM "users_app"`)).toEqual([
            { email: "ada@example.com" },
          ]);
          assert.strictEqual(await appliedEntries(server, tab), 1);
        }),
      ],
    });
  });

  it("runs projections into local tables in the same transaction as the entry", async () => {
    await runReplicaScenario({
      serverSchemas: [appSchema],
      statementDelayMs: 0,
      steps: [
        openTab(
          "a",
          replica({ localSchemas: [{ schema: statsSchema }], projections: [countPostsPerAuthor] }),
        ),
        write(appSchema, "users", (uow) => {
          uow.create("users", user("ada@example.com"));
        }),
        write(appSchema, "first", (uow, vars) => {
          uow.create("posts", { authorId: vars["users"]![0]!, title: "One" });
        }),
        write(appSchema, "second", (uow, vars) => {
          uow.create("posts", { authorId: vars["users"]![0]!, title: "Two" });
          uow.create("posts", { authorId: vars["users"]![0]!, title: "Three" });
        }),
        assertStep(async ({ tabs, vars }) => {
          await expect
            .poll(() =>
              tabs
                .get("a")!
                .execute(`SELECT "id", "posts", "_version", "updatedAt" FROM "authorStats_stats"`),
            )
            .toEqual([
              {
                id: vars["users"]![0]!.externalId,
                posts: 3,
                _version: 1,
                updatedAt: expect.any(Number),
              },
            ]);
        }),
      ],
    });
  });

  it("applies every kind of projection write and reference", async () => {
    let sharedInternalId: unknown;
    const cardsSql = `SELECT c."id", l."id" AS "list" FROM "cards_board" c
      LEFT JOIN "lists_board" l ON c."listId" = l."_internalId" ORDER BY c."id"`;

    await runReplicaScenario({
      serverSchemas: [appSchema],
      statementDelayMs: 0,
      steps: [
        openTab(
          "a",
          replica({ localSchemas: [{ schema: boardSchema }], projections: [boardProjection] }),
        ),
        write(appSchema, "ada", (uow) => {
          uow.create("users", user("ada@example.com"));
        }),
        waitForRows("a", cardsSql, [
          { id: "card-ada@example.com", list: "list-ada@example.com" },
          { id: "late-ada@example.com", list: null },
        ]),
        assertStep(async ({ tabs }) => {
          const [shared] = await tabs
            .get("a")!
            .execute(`SELECT "_internalId" FROM "lists_board" WHERE "id" = 'shared'`);
          sharedInternalId = shared!["_internalId"];
        }),
        write(appSchema, "later", (uow) => {
          uow.create("users", user("later@example.com"));
        }),
        // A reference to a row that arrives later stays NULL.
        waitForRows("a", cardsSql, [
          { id: "card-ada@example.com", list: "list-ada@example.com" },
          { id: "card-later@example.com", list: "list-later@example.com" },
          { id: "copy-later@example.com", list: "shared" },
          { id: "late-ada@example.com", list: null },
          { id: "late-later@example.com", list: "list-later@example.com" },
          { id: "ref-later@example.com", list: "shared" },
        ]),
        assertStep(async ({ tabs }) => {
          const tab = tabs.get("a")!;
          // Creating over an existing id merges into the row and keeps its identity and version.
          expect(
            await tab.execute(
              `SELECT "title", "_internalId", "_version" FROM "lists_board" WHERE "id" = 'shared'`,
            ),
          ).toEqual([{ title: "later@example.com", _internalId: sharedInternalId, _version: 0 }]);
          // Updating a missing row writes nothing.
          expect(await tab.execute(`SELECT * FROM "lists_board" WHERE "id" = 'missing'`)).toEqual(
            [],
          );
        }),
        write(appSchema, "removed", (uow, vars) => {
          uow.delete("users", vars["ada"]![0]!);
        }),
        waitForRows("a", `SELECT "id" FROM "lists_board" ORDER BY "id"`, [
          { id: "list-ada@example.com" },
          { id: "list-later@example.com" },
        ]),
        assertStep(({ errors }) => {
          expect(errors).toEqual([]);
        }),
      ],
    });
  });

  it("rolls back the source rows of an entry whose projection fails", async () => {
    await runReplicaScenario({
      serverSchemas: [appSchema],
      statementDelayMs: 0,
      steps: [
        openTab(
          "a",
          replica({ localSchemas: [{ schema: statsSchema }], projections: [rejectSecondPost] }),
        ),
        write(appSchema, "users", (uow) => {
          uow.create("users", user("ada@example.com"));
        }),
        write(appSchema, "first", (uow, vars) => {
          uow.create("posts", { authorId: vars["users"]![0]!, title: "One" });
        }),
        waitForRows("a", `SELECT "posts" FROM "authorStats_stats"`, [{ posts: 1 }]),
        write(appSchema, "second", (uow, vars) => {
          uow.create("posts", { authorId: vars["users"]![0]!, title: "Two" });
        }),
        waitForError("Projection update check failed"),
        assertStep(async ({ server, tabs }) => {
          const tab = tabs.get("a")!;
          expect(await tab.execute(`SELECT "title" FROM "posts_app"`)).toEqual([{ title: "One" }]);
          assert.strictEqual(await appliedEntries(server, tab), 2);
        }),
      ],
    });
  });

  it("skips entries it applied when an open ephemeral stream held its cursor back", async () => {
    // A typing row opens a stream that never ends, so the stored cursor stays before it.
    const replicaWithStream = replica({
      ephemeralTables: [
        {
          schema: "app",
          table: "typing",
          stream: { key: (values) => String(values["userEmail"]), boundary: () => "start" },
        },
      ],
      localSchemas: [{ schema: statsSchema }],
      projections: [countPostsPerAuthor],
    });
    await runReplicaScenario({
      serverSchemas: [appSchema],
      statementDelayMs: 0,
      steps: [
        openTab("a", replicaWithStream),
        write(appSchema, "users", (uow) => {
          uow.create("users", user("ada@example.com"));
        }),
        write(appSchema, "typing", (uow) => {
          uow.create("typing", { userEmail: "ada@example.com" });
        }),
        write(appSchema, "first", (uow, vars) => {
          uow.create("posts", { authorId: vars["users"]![0]!, title: "One" });
        }),
        waitForRows("a", `SELECT "posts" FROM "authorStats_stats"`, [{ posts: 1 }]),
        closeTab("a"),
        // The next writer resumes before the typing row, so the first post arrives again.
        openTab("b", replicaWithStream),
        write(appSchema, "second", (uow, vars) => {
          uow.create("posts", { authorId: vars["users"]![0]!, title: "Two" });
        }),
        waitForRows("b", `SELECT "title" FROM "posts_app" ORDER BY "title"`, [
          { title: "One" },
          { title: "Two" },
        ]),
        assertStep(async ({ tabs, errors }) => {
          expect(errors).toEqual([]);
          expect(await tabs.get("b")!.execute(`SELECT "posts" FROM "authorStats_stats"`)).toEqual([
            { posts: 2 },
          ]);
        }),
      ],
    });
  });

  it("hands the writer role to another tab and resumes from the stored cursor", async () => {
    await runReplicaScenario({
      serverSchemas: [appSchema],
      statementDelayMs: 0,
      steps: [
        openTab("a", replica({})),
        openTab("b", replica({})),
        write(appSchema, "ada", (uow) => {
          uow.create("users", user("ada@example.com"));
        }),
        waitForRows("b", `SELECT "email" FROM "users_app"`, [{ email: "ada@example.com" }]),
        assertStep(async ({ notifications, tabs }) => {
          expect(tabs.get("a")!.databaseName).toBe(tabs.get("b")!.databaseName);
          await expect.poll(() => notifications.get("b")).toBeGreaterThan(0);
        }),
        closeTab("a"),
        write(appSchema, "bob", (uow) => {
          uow.create("users", user("bob@example.com"));
        }),
        waitForRows("b", `SELECT "email" FROM "users_app" ORDER BY "email"`, [
          { email: "ada@example.com" },
          { email: "bob@example.com" },
        ]),
        closeTab("b"),
        write(appSchema, "cy", (uow) => {
          uow.create("users", user("cy@example.com"));
        }),
        openTab("c", replica({})),
        waitForRows("c", `SELECT "email" FROM "users_app" ORDER BY "email"`, [
          { email: "ada@example.com" },
          { email: "bob@example.com" },
          { email: "cy@example.com" },
        ]),
        assertStep(async ({ server, tabs, errors }) => {
          expect(errors).toEqual([]);
          assert.strictEqual(await appliedEntries(server, tabs.get("c")!), 3);
        }),
      ],
    });
  });

  it("keeps a writer when a closed tab's aborted lock request is granted later", async () => {
    await runReplicaScenario({
      serverSchemas: [appSchema],
      statementDelayMs: 0,
      steps: [
        grantAbortedLockRequests(),
        openTab("a", replica({})),
        openTab("closed", replica({})),
        openTab("b", replica({})),
        closeTab("closed"),
        closeTab("a"),
        write(appSchema, "ada", (uow) => {
          uow.create("users", user("ada@example.com"));
        }),
        waitForRows("b", `SELECT "email" FROM "users_app"`, [{ email: "ada@example.com" }]),
      ],
    });
  });

  it("resumes a catch-up of several pages after its tab closes partway", async () => {
    const entries = 120;

    await runReplicaScenario({
      serverSchemas: [appSchema],
      statementDelayMs: 2,
      steps: [
        ...Array.from({ length: entries }, (_, index) =>
          write(appSchema, `user-${index}`, (uow) => {
            uow.create("users", user(`user-${index}@example.com`));
          }),
        ),
        openTab("a", replica({})),
        openTab("reader", replica({})),
        closeTabAfterEntries("a", 30),
        assertStep(({ usersAtClose }) => {
          expect(usersAtClose.get("a")).toBeGreaterThanOrEqual(30);
          expect(usersAtClose.get("a")).toBeLessThan(entries);
        }),
        waitForRows("reader", `SELECT count(*) AS "count" FROM "users_app"`, [{ count: entries }]),
        assertStep(async ({ server, tabs, errors }) => {
          expect(errors).toEqual([]);
          const tab = tabs.get("reader")!;
          assert.strictEqual(await appliedEntries(server, tab), entries);
          expect(
            await tab.execute(`SELECT count(DISTINCT "email") AS "count" FROM "users_app"`),
          ).toEqual([{ count: entries }]);
        }),
      ],
    });
  });

  it("applies each transaction in at most two database calls, one for its reads and one for its writes", async () => {
    const entries = 120;

    await runReplicaScenario({
      serverSchemas: [appSchema],
      statementDelayMs: 0,
      steps: [
        ...Array.from({ length: entries }, (_, index) =>
          write(appSchema, `user-${index}`, (uow) => {
            uow.create("users", user(`user-${index}@example.com`));
          }),
        ),
        openTab("a", replica({})),
        waitForRows("a", `SELECT count(*) AS "count" FROM "users_app"`, [{ count: entries }]),
        assertStep(({ databaseCalls, errors }) => {
          expect(errors).toEqual([]);
          // Reads of the test go between transactions, which the replica serializes.
          const transactions: string[][] = [];
          let current: string[] | null = null;
          for (const sql of databaseCalls) {
            if (sql.startsWith("BEGIN IMMEDIATE")) {
              current = [];
            }
            current?.push(sql);
            if (current && sql.endsWith("COMMIT")) {
              transactions.push(current);
              current = null;
            }
          }
          expect(current).toBeNull();
          for (const calls of transactions) {
            expect(calls.length).toBeLessThanOrEqual(2);
          }
          const inserts = databaseCalls.join("\n").split(`INSERT INTO "users_app"`).length - 1;
          expect(inserts).toBe(entries);
          // Entries that arrive together share a transaction.
          expect(transactions.length).toBeLessThan(entries);
        }),
      ],
    });
  });

  it("reports catch-up progress to every tab, and stays caught up after it, also in later sessions", async () => {
    const entries = 120;

    await runReplicaScenario({
      serverSchemas: [appSchema],
      statementDelayMs: 2,
      steps: [
        ...Array.from({ length: entries }, (_, index) =>
          write(appSchema, `user-${index}`, (uow) => {
            uow.create("users", user(`user-${index}@example.com`));
          }),
        ),
        deliverStreamInBursts(),
        openTab("a", replica({})),
        openTab("reader", replica({})),
        waitForStatus("reader", { phase: "caught-up", error: null }),
        assertStep(async ({ statuses, tabs }) => {
          // The writer reports caught-up only after the last entry commits.
          expect(
            await tabs.get("reader")!.execute(`SELECT count(*) AS "count" FROM "users_app"`),
          ).toEqual([{ count: entries }]);
          for (const tab of ["a", "reader"]) {
            const reported = statuses.get(tab)!;
            expect(reported[0]).toEqual({ phase: "catching-up", fraction: null, error: null });
            expect(reported.at(-1)).toEqual({ phase: "caught-up", error: null });
            const fractions = reported.flatMap((status) =>
              status.phase === "catching-up" && status.fraction !== null ? [status.fraction] : [],
            );
            expect(fractions).toEqual([...fractions].sort((left, right) => left - right));
            assert(fractions.some((fraction) => fraction > 0 && fraction < 1));
          }
        }),
        openTab("late", replica({})),
        waitForStatus("late", { phase: "caught-up", error: null }),
        closeTab("a"),
        write(appSchema, "ada", (uow) => {
          uow.create("users", user("ada@example.com"));
        }),
        waitForRows("late", `SELECT count(*) AS "count" FROM "users_app"`, [
          { count: entries + 1 },
        ]),
        assertStep(({ statuses, errors }) => {
          expect(errors).toEqual([]);
          for (const tab of ["reader", "late"]) {
            const reported = statuses.get(tab)!;
            const caughtUpAt = reported.findIndex((status) => status.phase === "caught-up");
            assert(reported.slice(caughtUpAt).every((status) => status.phase === "caught-up"));
          }
        }),
        closeTab("reader"),
        closeTab("late"),
        openTab("returning", replica({})),
        assertStep(({ statuses }) => {
          // A complete, if older, copy opens at once; the stream replays what changed meanwhile.
          expect(statuses.get("returning")![0]).toEqual({ phase: "caught-up", error: null });
        }),
      ],
    });
  });

  it("releases the writer role after a stream failure and recovers when the backend returns", async () => {
    await runReplicaScenario({
      serverSchemas: [appSchema],
      statementDelayMs: 0,
      steps: [
        setStreamAvailable(false),
        openTab("a", replica({})),
        openTab("b", replica({})),
        write(appSchema, "ada", (uow) => {
          uow.create("users", user("ada@example.com"));
        }),
        waitForError("Outbox stream request failed: 503"),
        assertStep(async ({ errors }) => {
          // Each failed attempt releases the lock and competes again, so failures repeat.
          await expect.poll(() => errors.length).toBeGreaterThan(2);
        }),
        // Whichever tab failed last, both show the failure while they wait for the data.
        waitForStatus("a", {
          phase: "catching-up",
          fraction: null,
          error: expect.stringContaining("Outbox stream request failed: 503"),
        }),
        waitForStatus("b", {
          phase: "catching-up",
          fraction: null,
          error: expect.stringContaining("Outbox stream request failed: 503"),
        }),
        setStreamAvailable(true),
        waitForRows("a", `SELECT "email" FROM "users_app"`, [{ email: "ada@example.com" }]),
        waitForRows("b", `SELECT "email" FROM "users_app"`, [{ email: "ada@example.com" }]),
        waitForStatus("a", { phase: "caught-up", error: null }),
        waitForStatus("b", { phase: "caught-up", error: null }),
      ],
    });
  });

  it("opens a fresh database that replays the outbox when a registered schema changes", async () => {
    await runReplicaScenario({
      serverSchemas: [appSchema],
      statementDelayMs: 0,
      steps: [
        openTab("v1", replica({ localSchemas: [{ schema: statsSchema }] })),
        write(appSchema, "ada", (uow) => {
          uow.create("users", user("ada@example.com"));
        }),
        waitForRows("v1", `SELECT "email" FROM "users_app"`, [{ email: "ada@example.com" }]),
        openTab("v2", replica({ localSchemas: [{ schema: statsSchemaV2 }] })),
        waitForRows("v2", `SELECT "email" FROM "users_app"`, [{ email: "ada@example.com" }]),
        assertStep(async ({ tabs }) => {
          const v2 = tabs.get("v2")!;
          expect(v2.databaseName).not.toBe(tabs.get("v1")!.databaseName);
          expect(
            await v2.execute(`SELECT "name" FROM pragma_table_info('authorStats_stats')`),
          ).toEqual([
            { name: "id" },
            { name: "posts" },
            { name: "updatedAt" },
            { name: "_internalId" },
            { name: "_version" },
            { name: "note" },
          ]);
        }),
      ],
    });
  });
});
