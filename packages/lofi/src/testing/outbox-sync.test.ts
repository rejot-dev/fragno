import { beforeEach, describe, expect, it, vi, assert } from "vitest";

import { column, FragnoReference, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";
import {
  IDBCursor,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
} from "fake-indexeddb";

import { defineFragment, instantiate } from "@fragno-dev/core";
import {
  InMemoryAdapter,
  getInternalFragment,
  type ImplicitDatabaseDependencies,
  type InternalFragmentInstance,
  type OutboxEntry,
  withDatabase,
} from "@fragno-dev/db";

import { IndexedDbAdapter, LofiClient } from "../mod";

const appSchema = schema("app", (s) => {
  return s
    .addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("email", column("string"))
        .addColumn("age", column("integer"))
        .addColumn("createdAt", column("timestamp").nullable())
        .createIndex("idx_email", ["email"], { unique: true })
        .createIndex("idx_age", ["age"]),
    )
    .addTable("posts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("authorId", referenceColumn({ table: "users" }))
        .addColumn("title", column("string"))
        .createIndex("idx_author", ["authorId"]),
    );
});

const fragmentName = "lofi-outbox-sync-test";
const fragmentDef = defineFragment(fragmentName).extend(withDatabase(appSchema)).build();

const createDbName = () => `lofi-outbox-${Math.random().toString(16).slice(2)}`;

async function buildOutboxContext() {
  const adapter = new InMemoryAdapter({
    idSeed: "lofi-outbox-seed",
  });

  const fragment = instantiate(fragmentDef)
    .withConfig({})
    .withRoutes([])
    .withOptions({ databaseAdapter: adapter, outbox: { enabled: true } })
    .build();

  const deps = fragment.$internal.deps as ImplicitDatabaseDependencies;
  const createUnitOfWork = (name?: string) =>
    deps.databaseAdapter.createUnitOfWork(appSchema, deps.namespace, name);

  return {
    createUnitOfWork,
    internalFragment: getInternalFragment(adapter),
    cleanup: async () => {
      await adapter.close();
    },
  };
}

async function listOutbox(
  internalFragment: InternalFragmentInstance,
  options?: { afterVersionstamp?: string; limit?: number },
): Promise<OutboxEntry[]> {
  return internalFragment.inContext(async function () {
    return (await this.handlerTx()
      .withServiceCalls(() => [internalFragment.services.outboxService.list(options)] as const)
      .transform(({ serviceResult: [result] }) => result)
      .execute()) as OutboxEntry[];
  });
}

describe("outbox sync integration", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBCursor = IDBCursor;
    globalThis.IDBDatabase = IDBDatabase;
    globalThis.IDBIndex = IDBIndex;
    globalThis.IDBKeyRange = IDBKeyRange;
    globalThis.IDBObjectStore = IDBObjectStore;
    globalThis.IDBOpenDBRequest = IDBOpenDBRequest;
    globalThis.IDBRequest = IDBRequest;
    globalThis.IDBTransaction = IDBTransaction;
  });

  it("syncs outbox entries into IndexedDB and advances the cursor", async () => {
    const { createUnitOfWork, internalFragment, cleanup } = await buildOutboxContext();

    try {
      const betaUserId = await (async () => {
        const uow = createUnitOfWork("seed-users");
        uow.create("users", { email: "alpha@example.com", age: 30 });
        uow.create("users", { email: "beta@example.com", age: 20 });
        uow.create("users", { email: "gamma@example.com", age: 40 });
        const { success } = await uow.executeMutations();
        if (!success) {
          throw new Error("Failed to create users");
        }
        const ids = uow.getCreatedIds();
        return ids[1]!;
      })();

      if (!betaUserId.internalId) {
        throw new Error("Expected beta user to include internal id");
      }

      {
        const uow = createUnitOfWork("seed-post");
        uow.create("posts", {
          title: "Hello",
          authorId: FragnoReference.fromInternal(betaUserId.internalId),
        });
        const { success } = await uow.executeMutations();
        if (!success) {
          throw new Error("Failed to create post");
        }
      }

      const expectedEntries = await listOutbox(internalFragment);
      const expectedStamps = expectedEntries.map((entry) => entry.versionstamp);

      const requests: Array<{ after: string | null; limit: string | null }> = [];

      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(typeof input === "string" ? input : input.toString());
        const afterVersionstamp = url.searchParams.get("afterVersionstamp");
        const limitParam = url.searchParams.get("limit");
        requests.push({
          after: afterVersionstamp,
          limit: limitParam,
        });

        const limit = limitParam ? Number(limitParam) : expectedEntries.length;
        const startIndex = afterVersionstamp
          ? expectedEntries.findIndex((entry) => entry.versionstamp === afterVersionstamp) + 1
          : 0;
        const entries = expectedEntries.slice(startIndex, startIndex + limit);

        return new Response(JSON.stringify(entries), { status: 200 });
      });

      const adapter = new IndexedDbAdapter({
        dbName: createDbName(),
        endpointName: "app",
        schemas: [{ schema: appSchema }],
      });

      const onSyncApplied = vi.fn();
      const client = new LofiClient({
        outboxUrl: "https://example.com/outbox",
        endpointName: "app",
        adapter,
        fetch: fetcher as unknown as typeof fetch,
        limit: 1,
        onSyncApplied,
      });

      const result = await client.syncOnce();

      expect(result.appliedEntries).toBe(expectedEntries.length);
      expect(result.lastVersionstamp).toBe(expectedEntries.at(-1)?.versionstamp);
      expect(await adapter.getMeta("app::outbox")).toBe(expectedEntries.at(-1)?.versionstamp);
      expect(onSyncApplied).toHaveBeenCalledTimes(1);
      expect(onSyncApplied).toHaveBeenCalledWith(result);

      expect(requests).toHaveLength(expectedEntries.length + 1);
      expect(requests[0]?.after).toBeNull();
      expectedStamps.forEach((stamp, index) => {
        expect(requests[index + 1]?.after).toBe(stamp);
      });

      const query = adapter.createQueryEngine(appSchema);
      const ordered = await query.find("users", (b) =>
        b.whereIndex("idx_age").orderByIndex("idx_age", "asc"),
      );
      expect(ordered.map((row) => row.age)).toEqual([20, 30, 40]);

      const count = await query.find("users", (b) => b.whereIndex("idx_age").selectCount());
      expect(count).toBe(3);

      const joined = await query.find("posts", (b) =>
        b
          .whereIndex("idx_author")
          .joinOne("author", "users", (author) =>
            author.onIndex("primary", (eb) => eb("id", "=", eb.parent("authorId"))),
          ),
      );
      expect(joined).toHaveLength(1);
      assert(joined[0].author?.email === "beta@example.com");
    } finally {
      await cleanup();
    }
  });

  it("stores materialized outbox timestamps instead of db-now sentinels", async () => {
    const { createUnitOfWork, internalFragment, cleanup } = await buildOutboxContext();

    try {
      {
        const uow = createUnitOfWork("seed-user-timestamp");
        uow.create("users", {
          email: "timestamp@example.com",
          age: 50,
          createdAt: uow.now(),
        });
        const { success } = await uow.executeMutations();
        if (!success) {
          throw new Error("Failed to create timestamp user");
        }
      }

      const expectedEntries = await listOutbox(internalFragment);
      const adapter = new IndexedDbAdapter({
        dbName: createDbName(),
        endpointName: "app",
        schemas: [{ schema: appSchema }],
      });
      const client = new LofiClient({
        outboxUrl: "https://example.com/outbox",
        endpointName: "app",
        adapter,
        fetch: (async () => new Response(JSON.stringify(expectedEntries))) as typeof fetch,
      });

      await client.syncOnce();

      const query = adapter.createQueryEngine(appSchema);
      const user = await query.find("users", (b) =>
        b.whereIndex("idx_email", (eb) => eb("email", "=", "timestamp@example.com")),
      );

      expect(user).toHaveLength(1);
      expect(user[0].createdAt).toBeInstanceOf(Date);
      expect(user[0].createdAt).not.toMatchObject({ tag: "db-now" });
    } finally {
      await cleanup();
    }
  });

  it("skips duplicate outbox entries when re-synced", async () => {
    const { createUnitOfWork, internalFragment, cleanup } = await buildOutboxContext();

    try {
      {
        const uow = createUnitOfWork("seed-users-dup");
        uow.create("users", { email: "alpha@example.com", age: 30 });
        uow.create("users", { email: "beta@example.com", age: 20 });
        const { success } = await uow.executeMutations();
        if (!success) {
          throw new Error("Failed to create users");
        }
      }

      const expectedEntries = await listOutbox(internalFragment);

      const adapter = new IndexedDbAdapter({
        dbName: createDbName(),
        endpointName: "app",
        schemas: [{ schema: appSchema }],
      });

      const fetcher = vi.fn(
        async () => new Response(JSON.stringify(expectedEntries), { status: 200 }),
      );

      const onSyncApplied = vi.fn();
      const client = new LofiClient({
        outboxUrl: "https://example.com/outbox",
        endpointName: "app",
        adapter,
        fetch: fetcher as unknown as typeof fetch,
        limit: expectedEntries.length + 1,
        onSyncApplied,
      });

      const first = await client.syncOnce();
      expect(first.appliedEntries).toBe(expectedEntries.length);
      expect(onSyncApplied).toHaveBeenCalledTimes(1);

      const second = await client.syncOnce();
      assert(second.appliedEntries === 0);
      expect(onSyncApplied).toHaveBeenCalledTimes(1);

      const query = adapter.createQueryEngine(appSchema);
      const count = await query.find("users", (b) => b.whereIndex("idx_age").selectCount());
      expect(count).toBe(2);
    } finally {
      await cleanup();
    }
  });
});
