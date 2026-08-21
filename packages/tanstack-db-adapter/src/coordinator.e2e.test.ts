import { assert, describe, expect, it } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FRAGNO_OUTBOX_PAGE_SIZE, outboxPageAfterVersionstamp } from "@fragno-dev/db/outbox";
import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";
import Database from "better-sqlite3";

import { defineFragment, instantiate } from "@fragno-dev/core";
import type { DatabaseRequestContext } from "@fragno-dev/db";
import { withDatabase } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, createFragmentTestFetcher } from "@fragno-dev/test";

import { createLiveQueryCollection, eq, type Collection } from "@tanstack/db";
import type {
  PersistedCollectionPersistence,
  PersistenceAdapter,
} from "@tanstack/db-sqlite-persistence-core";
import { createNodeSQLitePersistence } from "@tanstack/node-db-sqlite-persistence";

import {
  createFragnoOutboxCoordinator,
  type FragnoCollectionRow,
  type FragnoOutboxCoordinatorDependencies,
  type FragnoOutboxCoordinatorState,
} from "./coordinator";

const appSchema = schema("from_scratch_e2e", (s) =>
  s
    .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
    .addTable("posts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("authorId", referenceColumn({ table: "users" }))
        .addColumn("title", column("string")),
    )
    .addTable("comments", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("postId", referenceColumn({ table: "posts" }))
        .addColumn("authorId", referenceColumn({ table: "users" }))
        .addColumn("body", column("string")),
    ),
);

const TEST_BASE_URL = "http://tanstack-db-coordinator.test";

const nodePersistenceDependencies = {
  async openPersistence() {
    const database = new Database(":memory:");
    return {
      persistence: createNodeSQLitePersistence({ database }),
      async cleanup() {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        database.close();
      },
    };
  },
} satisfies FragnoOutboxCoordinatorDependencies;

function createDatabaseNameCapturingDependencies(databaseNames: string[]) {
  return {
    async openPersistence({ databaseName }: { databaseName: string }) {
      databaseNames.push(databaseName);
      return nodePersistenceDependencies.openPersistence();
    },
  } satisfies FragnoOutboxCoordinatorDependencies;
}

function createPersistentNodeDependencies(
  databasePath: string,
  writeDelay?: { milliseconds: number },
) {
  return {
    async openPersistence() {
      const database = new Database(databasePath);
      const persistence = createNodeSQLitePersistence({ database });
      return {
        persistence: writeDelay ? delayPersistenceWrites(persistence, writeDelay) : persistence,
        async cleanup() {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
          });
          database.close();
        },
      };
    },
  } satisfies FragnoOutboxCoordinatorDependencies;
}

function delayPersistenceWrites(
  persistence: PersistedCollectionPersistence,
  delay: { milliseconds: number },
): PersistedCollectionPersistence {
  const persistenceCache = new WeakMap<
    PersistedCollectionPersistence,
    PersistedCollectionPersistence
  >();
  const adapterCache = new WeakMap<PersistenceAdapter, PersistenceAdapter>();

  const wrapAdapter = (adapter: PersistenceAdapter): PersistenceAdapter => {
    const cached = adapterCache.get(adapter);
    if (cached) {
      return cached;
    }

    const wrapped: PersistenceAdapter = {
      loadSubset: (...args) => adapter.loadSubset(...args),
      async applyCommittedTx(...args) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delay.milliseconds);
        });
        await adapter.applyCommittedTx(...args);
      },
      ensureIndex: (...args) => adapter.ensureIndex(...args),
    };
    if (adapter.loadCollectionMetadata) {
      wrapped.loadCollectionMetadata = (...args) => adapter.loadCollectionMetadata!(...args);
    }
    if (adapter.scanRows) {
      wrapped.scanRows = (...args) => adapter.scanRows!(...args);
    }
    if (adapter.markIndexRemoved) {
      wrapped.markIndexRemoved = (...args) => adapter.markIndexRemoved!(...args);
    }
    if (adapter.getStreamPosition) {
      wrapped.getStreamPosition = (...args) => adapter.getStreamPosition!(...args);
    }
    adapterCache.set(adapter, wrapped);
    return wrapped;
  };

  const wrapPersistence = (
    resolvedPersistence: PersistedCollectionPersistence,
  ): PersistedCollectionPersistence => {
    const cached = persistenceCache.get(resolvedPersistence);
    if (cached) {
      return cached;
    }

    const wrapped: PersistedCollectionPersistence = {
      adapter: wrapAdapter(resolvedPersistence.adapter),
    };
    persistenceCache.set(resolvedPersistence, wrapped);
    if (resolvedPersistence.coordinator) {
      wrapped.coordinator = resolvedPersistence.coordinator;
    }
    if (resolvedPersistence.resolvePersistenceForCollection) {
      wrapped.resolvePersistenceForCollection = (options) =>
        wrapPersistence(resolvedPersistence.resolvePersistenceForCollection!(options));
    }
    if (resolvedPersistence.resolvePersistenceForMode) {
      wrapped.resolvePersistenceForMode = (mode) =>
        wrapPersistence(resolvedPersistence.resolvePersistenceForMode!(mode));
    }
    return wrapped;
  };

  return wrapPersistence(persistence);
}

function readDurableCheckpoint(databasePath: string): {
  versionstamp: string;
  uowId: string;
} | null {
  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database
      .prepare(
        `SELECT value
           FROM collection_metadata
          WHERE collection_id = ? AND key = ?`,
      )
      .get("fragno.outbox.internal.v1", "fragno.outbox.checkpoint.v1") as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as { versionstamp: string; uowId: string }) : null;
  } finally {
    database.close();
  }
}

type User = FragnoCollectionRow<(typeof appSchema.tables)["users"]>;
type Post = FragnoCollectionRow<(typeof appSchema.tables)["posts"]>;
type Comment = FragnoCollectionRow<(typeof appSchema.tables)["comments"]>;

async function createTestServer(name: string) {
  const fragmentDefinition = defineFragment(`tanstack-db-coordinator-${name}`)
    .extend(withDatabase(appSchema))
    .build();
  const fragmentBuilder = instantiate(fragmentDefinition)
    .withConfig({})
    .withRoutes([])
    .withOptions({
      mountRoute: "/coordinator",
      outbox: { enabled: true },
    });
  const setup = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment("server", fragmentBuilder)
    .build();

  const serverFragment = setup.fragments.server;
  const fetch = createFragmentTestFetcher(serverFragment.fragment, {
    baseUrl: TEST_BASE_URL,
  });
  const baseUrl = new URL(serverFragment.fragment.mountRoute, TEST_BASE_URL).toString();

  async function createDiscussion(): Promise<void> {
    await serverFragment.fragment.inContext(async function (this: DatabaseRequestContext) {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const mutations = forSchema(appSchema);
          mutations.create("users", { id: "user-1", name: "Ada" });
          mutations.create("users", { id: "user-2", name: "Grace" });
          mutations.create("posts", {
            id: "post-1",
            authorId: "user-1",
            title: "Analytical Engine",
          });
          mutations.create("comments", {
            id: "comment-1",
            postId: "post-1",
            authorId: "user-2",
            body: "Excellent.",
          });
        })
        .execute();
    });
  }

  async function updateDiscussion(): Promise<void> {
    await serverFragment.fragment.inContext(async function (this: DatabaseRequestContext) {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const mutations = forSchema(appSchema);
          mutations.update("users", "user-1", (update) => update.set({ name: "Ada Lovelace" }));
          mutations.update("posts", "post-1", (update) =>
            update.set({ title: "Notes on the Analytical Engine" }),
          );
          mutations.delete("comments", "comment-1");
          mutations.create("comments", {
            id: "comment-2",
            postId: "post-1",
            authorId: "user-1",
            body: "Published.",
          });
        })
        .execute();
    });
  }

  async function createUserHistory(entryCount: number): Promise<void> {
    for (let index = 0; index < entryCount; index += 1) {
      await serverFragment.fragment.inContext(async function (this: DatabaseRequestContext) {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).create("users", {
              id: `history-user-${index}`,
              name: `History User ${index}`,
            });
          })
          .execute();
      });
    }
  }

  return {
    baseUrl,
    fetch,
    createDiscussion,
    updateDiscussion,
    createUserHistory,
    cleanup: () => setup.test.cleanup(),
  };
}

function sortedRows<TRow extends { id: string }>(rows: Iterable<TRow>): TRow[] {
  return [...rows]
    .map(
      (row) =>
        Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("$"))) as TRow,
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

function waitForCollection<TRow extends object, TKey extends string | number>(
  collection: Collection<TRow, TKey>,
  assertion: () => boolean,
): Promise<void> {
  if (assertion()) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    const subscription = collection.subscribeChanges(
      () => {
        if (settled || !assertion()) {
          return;
        }

        settled = true;
        resolve();
        queueMicrotask(() => subscription.unsubscribe());
      },
      { includeInitialState: true },
    );
  });
}

describe("Fragno TanStack adapter from scratch end-to-end", () => {
  it("uses a deterministic OPFS-safe database filename", async () => {
    const server = await createTestServer("database-filename");
    const databaseNames: string[] = [];

    try {
      const coordinator = await createFragnoOutboxCoordinator(
        {
          baseUrl: server.baseUrl,
          fetch: server.fetch,
          schemas: [appSchema],
        },
        createDatabaseNameCapturingDependencies(databaseNames),
      );

      await coordinator.cleanup();
      assert.equal(databaseNames.length, 1);
      assert.match(databaseNames[0]!, /^fragno-v3-[0-9a-f]{32}\.sqlite$/);
      assert.ok(databaseNames[0]!.length <= 56);
    } finally {
      await server.cleanup();
    }
  });

  it("rejects startup when browser persistence opening stalls", async () => {
    const server = await createTestServer("persistence-opening-timeout");
    const coordinatorPromise = createFragnoOutboxCoordinator(
      { baseUrl: server.baseUrl, fetch: server.fetch, schemas: [appSchema] },
      {
        openPersistence() {
          return new Promise<never>(() => {});
        },
      },
    );

    try {
      await expect(coordinatorPromise).rejects.toThrow(
        "Fragno outbox startup timed out after 5000ms while opening browser persistence.",
      );
    } finally {
      await server.cleanup();
    }
  }, 10_000);

  it("checks the aligned outbox page before streaming from a persisted database", async () => {
    const server = await createTestServer("persisted-reload");
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "fragno-outbox-reload-"));
    const databasePath = join(temporaryDirectory, "persistence.sqlite");
    const persistenceDependencies = createPersistentNodeDependencies(databasePath);

    try {
      await server.createDiscussion();

      const firstCoordinator = await createFragnoOutboxCoordinator(
        {
          baseUrl: server.baseUrl,
          fetch: server.fetch,
          schemas: [appSchema],
        },
        persistenceDependencies,
      );
      firstCoordinator.collection(appSchema, "users");
      await firstCoordinator.preload();
      await waitForCollection(
        firstCoordinator.internal.collection,
        () => firstCoordinator.state === "live",
      );
      const persistedCheckpoint = firstCoordinator.internal.getCheckpoint();
      assert.ok(persistedCheckpoint);
      await firstCoordinator.cleanup();

      const outboxRequests: URL[] = [];
      const reloadFetch: typeof globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname.endsWith("/_internal/outbox")) {
          outboxRequests.push(url);
        }
        return server.fetch(input, init);
      };
      const secondCoordinator = await createFragnoOutboxCoordinator(
        {
          baseUrl: server.baseUrl,
          fetch: reloadFetch,
          schemas: [appSchema],
        },
        persistenceDependencies,
      );
      const users = secondCoordinator.collection(appSchema, "users");

      try {
        assert.deepEqual(secondCoordinator.internal.getCheckpoint(), persistedCheckpoint);
        await secondCoordinator.preload();
        await waitForCollection(
          secondCoordinator.internal.collection,
          () => secondCoordinator.state === "live",
        );

        expect(sortedRows<User>(users.values())).toEqual([
          { id: "user-1", name: "Ada" },
          { id: "user-2", name: "Grace" },
        ]);
        assert.equal(outboxRequests.length, 1);
        const catchUpRequest = outboxRequests[0]!;
        assert.equal(
          catchUpRequest.searchParams.get("afterVersionstamp"),
          outboxPageAfterVersionstamp(persistedCheckpoint.versionstamp) ?? null,
        );
        assert.equal(catchUpRequest.searchParams.get("limit"), String(FRAGNO_OUTBOX_PAGE_SIZE));
      } finally {
        await secondCoordinator.cleanup();
      }
    } finally {
      await server.cleanup();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("can go live before persistence finishes and explicitly flush the final checkpoint", async () => {
    const server = await createTestServer("durable-multi-page-catch-up");
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "fragno-outbox-durability-"));
    const databasePath = join(temporaryDirectory, "persistence.sqlite");
    const persistenceDependencies = createPersistentNodeDependencies(databasePath, {
      milliseconds: 15,
    });

    try {
      await server.createUserHistory(FRAGNO_OUTBOX_PAGE_SIZE + 1);

      const coordinator = await createFragnoOutboxCoordinator(
        {
          baseUrl: server.baseUrl,
          fetch: server.fetch,
          schemas: [appSchema],
        },
        persistenceDependencies,
      );
      const users = coordinator.collection(appSchema, "users");

      try {
        await coordinator.preload();
        await waitForCollection(
          coordinator.internal.collection,
          () => coordinator.state === "live",
        );
        assert.equal([...users.values()].length, FRAGNO_OUTBOX_PAGE_SIZE + 1);
        const liveCheckpoint = coordinator.internal.getCheckpoint();
        assert.ok(liveCheckpoint);

        expect(readDurableCheckpoint(databasePath)).not.toEqual(liveCheckpoint);

        await coordinator.flushPersistence();

        expect(readDurableCheckpoint(databasePath)).toEqual(liveCheckpoint);
      } finally {
        await coordinator.cleanup();
      }
    } finally {
      await server.cleanup();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("materializes multiple tables from one outbox history", async () => {
    const server = await createTestServer("multiple-tables");

    try {
      // Frontend setup starts here. Production code receives the mounted source and its schemas.
      const coordinator = await createFragnoOutboxCoordinator(
        {
          baseUrl: server.baseUrl,
          fetch: server.fetch,
          schemas: [appSchema],
        },
        nodePersistenceDependencies,
      );
      assert.equal(coordinator.state, "idle");
      const coordinatorStatus = createLiveQueryCollection((query) =>
        query.from({ status: coordinator.internal.collection }),
      );
      const users = coordinator.collection(appSchema, "users");
      const posts = coordinator.collection(appSchema, "posts");
      const comments = coordinator.collection(appSchema, "comments");
      const observedStates: FragnoOutboxCoordinatorState[] = [];
      let statusSubscription: ReturnType<typeof coordinatorStatus.subscribeChanges> | undefined;

      try {
        await coordinatorStatus.preload();
        statusSubscription = coordinatorStatus.subscribeChanges(
          () => {
            const nextState = coordinatorStatus.get("coordinator")?.state;
            if (nextState && observedStates.at(-1) !== nextState) {
              observedStates.push(nextState);
            }
          },
          { includeInitialState: true },
        );
        expect(coordinatorStatus.get("coordinator")).toMatchObject({
          state: "idle",
          checkpoint: null,
          error: null,
        });

        await server.createDiscussion();
        await coordinator.preload();
        await waitForCollection(
          coordinatorStatus,
          () => coordinatorStatus.get("coordinator")?.state === "live",
        );

        expect([...observedStates]).toEqual([
          "idle",
          "registering",
          "catching-up",
          "caught-up",
          "live",
        ]);
        expect(coordinatorStatus.get("coordinator")).toMatchObject({
          state: "live",
          checkpoint: {
            versionstamp: expect.any(String),
            uowId: expect.any(String),
          },
          error: null,
        });

        expect(sortedRows<User>(users.values())).toEqual([
          { id: "user-1", name: "Ada" },
          { id: "user-2", name: "Grace" },
        ]);
        expect(sortedRows<Post>(posts.values())).toEqual([
          {
            id: "post-1",
            authorId: "user-1",
            title: "Analytical Engine",
          },
        ]);
        expect(sortedRows<Comment>(comments.values())).toEqual([
          {
            id: "comment-1",
            postId: "post-1",
            authorId: "user-2",
            body: "Excellent.",
          },
        ]);
      } finally {
        const cleanup = coordinator.cleanup();
        expect(coordinatorStatus.get("coordinator")).toMatchObject({ state: "disposed" });
        assert.equal(observedStates.at(-1), "disposed");
        statusSubscription?.unsubscribe();
        await coordinatorStatus.cleanup();
        await cleanup;
        assert.equal(coordinator.state, "disposed");
      }
    } finally {
      await server.cleanup();
    }
  });

  it("streams mutations committed between finite catch-up and stream connection", async () => {
    const server = await createTestServer("catch-up-stream-handoff");
    const streamGate = Promise.withResolvers<void>();
    let shouldGateStream = true;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (shouldGateStream && url.pathname.endsWith("/_internal/outbox/stream")) {
        shouldGateStream = false;
        await streamGate.promise;
      }
      return server.fetch(input, init);
    };

    try {
      const coordinator = await createFragnoOutboxCoordinator(
        {
          baseUrl: server.baseUrl,
          fetch,
          schemas: [appSchema],
        },
        nodePersistenceDependencies,
      );
      const users = coordinator.collection(appSchema, "users");

      try {
        await server.createDiscussion();
        await coordinator.preload();
        assert.equal(coordinator.state, "caught-up");

        await server.updateDiscussion();
        streamGate.resolve();

        await waitForCollection(
          users,
          () => coordinator.state === "live" && users.get("user-1")?.name === "Ada Lovelace",
        );
      } finally {
        streamGate.resolve();
        await coordinator.cleanup();
      }
    } finally {
      await server.cleanup();
    }
  });

  it("applies live updates and deletes independently to each table", async () => {
    const server = await createTestServer("live-multiple-tables");

    try {
      // Frontend setup starts here. Every collection is generated from the same outbox definition.
      const coordinator = await createFragnoOutboxCoordinator(
        {
          baseUrl: server.baseUrl,
          fetch: server.fetch,
          schemas: [appSchema],
        },
        nodePersistenceDependencies,
      );
      const users = coordinator.collection(appSchema, "users");
      const posts = coordinator.collection(appSchema, "posts");
      const comments = coordinator.collection(appSchema, "comments");

      try {
        await server.createDiscussion();
        await coordinator.preload();
        await waitForCollection(
          coordinator.internal.collection,
          () => coordinator.state === "live",
        );
        await server.updateDiscussion();

        await waitForCollection(
          comments,
          () =>
            users.get("user-1")?.name === "Ada Lovelace" &&
            posts.get("post-1")?.title === "Notes on the Analytical Engine" &&
            comments.get("comment-1") === undefined &&
            comments.get("comment-2")?.body === "Published.",
        );

        expect(users.get("user-1")).toMatchObject({ name: "Ada Lovelace" });
        expect(posts.get("post-1")).toMatchObject({
          title: "Notes on the Analytical Engine",
        });
        expect(sortedRows<Comment>(comments.values())).toEqual([
          {
            id: "comment-2",
            postId: "post-1",
            authorId: "user-1",
            body: "Published.",
          },
        ]);
      } finally {
        await coordinator.cleanup();
      }
    } finally {
      await server.cleanup();
    }
  });

  it("feeds a live query joined across synchronized tables", async () => {
    const server = await createTestServer("joined-live-query");

    try {
      // Frontend setup starts here, including the coordinator, collections, and derived live query.
      const coordinator = await createFragnoOutboxCoordinator(
        {
          baseUrl: server.baseUrl,
          fetch: server.fetch,
          schemas: [appSchema],
        },
        nodePersistenceDependencies,
      );
      const users = coordinator.collection(appSchema, "users");
      const posts = coordinator.collection(appSchema, "posts");
      const authoredPosts = createLiveQueryCollection((query) =>
        query
          .from({ post: posts })
          .innerJoin({ author: users }, ({ post, author }) => eq(post.authorId, author.id))
          .select(({ post, author }) => ({
            id: post.id,
            title: post.title,
            authorName: author.name,
          })),
      );

      try {
        await server.createDiscussion();
        await coordinator.preload();
        await waitForCollection(
          coordinator.internal.collection,
          () => coordinator.state === "live",
        );
        await authoredPosts.preload();

        expect(sortedRows(authoredPosts.values())).toEqual([
          {
            id: "post-1",
            title: "Analytical Engine",
            authorName: "Ada",
          },
        ]);

        await server.updateDiscussion();
        await waitForCollection(authoredPosts, () =>
          [...authoredPosts.values()].some(
            (authoredPost) =>
              authoredPost.id === "post-1" &&
              authoredPost.authorName === "Ada Lovelace" &&
              authoredPost.title === "Notes on the Analytical Engine",
          ),
        );
      } finally {
        await authoredPosts.cleanup();
        await coordinator.cleanup();
      }
    } finally {
      await server.cleanup();
    }
  });
});
