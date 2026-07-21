import { describe, expect, it, assert } from "vitest";

import { column, idColumn, schema } from "@fragno-dev/db/schema";
import Database from "better-sqlite3";

import { defineFragment, instantiate } from "@fragno-dev/core";
import type { DatabaseRequestContext } from "@fragno-dev/db";
import { withDatabase } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, createFragmentTestFetcher } from "@fragno-dev/test";

import {
  createCollection,
  createLiveQueryCollection,
  eq,
  type Collection,
  type CollectionConfig,
} from "@tanstack/db";
import {
  createNodeSQLitePersistence,
  persistedCollectionOptions,
} from "@tanstack/node-db-sqlite-persistence";

import { FRAGNO_OUTBOX_CHECKPOINT_METADATA_KEY, type FragnoOutboxCheckpoint } from "./checkpoint";
import { fragnoCollectionOptions, type FragnoCollectionUtils } from "./collection-options";
import { createFragnoOutboxCoordinator } from "./coordinator";
import type { FragnoCollectionRow } from "./protocol";
import { createFetchFragnoOutboxTransport, type FragnoOutboxTransport } from "./transport";

const appSchema = schema("coordinator_e2e", (s) =>
  s
    .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
    .addTable("posts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("authorId", column("string"))
        .addColumn("title", column("string")),
    ),
);

const TEST_BASE_URL = "http://tanstack-db-coordinator.test";
const PERSISTENCE_TIMEOUT_MS = 1_000;

type User = FragnoCollectionRow<(typeof appSchema.tables)["users"]>;
type Post = FragnoCollectionRow<(typeof appSchema.tables)["posts"]>;
type UsersCollection = Collection<User, string, FragnoCollectionUtils>;
type PostsCollection = Collection<Post, string, FragnoCollectionUtils>;

async function createCoordinatorHarness(name: string) {
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
  const internalUrl = new URL(
    `${serverFragment.fragment.mountRoute}/_internal`,
    TEST_BASE_URL,
  ).toString();
  const fetchedVersionstamps: string[] = [];
  const fetchTransport = createFetchFragnoOutboxTransport({ internalUrl, fetch });
  const transport: FragnoOutboxTransport = {
    getAdapterIdentity: (options) => fetchTransport.getAdapterIdentity(options),
    async list(options) {
      const entries = await fetchTransport.list(options);
      fetchedVersionstamps.push(...entries.map(({ versionstamp }) => versionstamp));
      return entries;
    },
  };
  const coordinator = createFragnoOutboxCoordinator({
    internalUrl,
    transport,
    pollIntervalMs: 60_000,
  });
  const database = new Database(":memory:");
  const persistence = createNodeSQLitePersistence({ database });
  const collections: Array<{ cleanup(): Promise<void> }> = [];

  const createUsersCollection = () => {
    const persistedOptions = persistedCollectionOptions({
      ...fragnoCollectionOptions({
        id: `${name}.users`,
        coordinator,
        target: { schema: appSchema, table: "users" },
      }),
      persistence,
      schemaVersion: 1,
    });
    const collectionOptions = persistedOptions as unknown as CollectionConfig<
      User,
      string,
      never,
      FragnoCollectionUtils
    >;
    const collection = createCollection(collectionOptions) as UsersCollection;
    collections.push(collection);
    return collection;
  };

  const createPostsCollection = () => {
    const persistedOptions = persistedCollectionOptions({
      ...fragnoCollectionOptions({
        id: `${name}.posts`,
        coordinator,
        target: { schema: appSchema, table: "posts" },
      }),
      persistence,
      schemaVersion: 1,
    });
    const collectionOptions = persistedOptions as unknown as CollectionConfig<
      Post,
      string,
      never,
      FragnoCollectionUtils
    >;
    const collection = createCollection(collectionOptions) as PostsCollection;
    collections.push(collection);
    return collection;
  };

  return {
    coordinator,
    fetchedVersionstamps,
    createUsersCollection,
    createPostsCollection,
    async createUserAndPost() {
      await serverFragment.fragment.inContext(async function (this: DatabaseRequestContext) {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            const mutations = forSchema(appSchema);
            mutations.create("users", { id: "user-1", name: "Ada" });
            mutations.create("posts", {
              id: "post-1",
              authorId: "user-1",
              title: "First",
            });
          })
          .execute();
      });
    },
    async updateUserAndPost() {
      await serverFragment.fragment.inContext(async function (this: DatabaseRequestContext) {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            const mutations = forSchema(appSchema);
            mutations.update("users", "user-1", (update) => update.set({ name: "Grace" }));
            mutations.update("posts", "post-1", (update) => update.set({ title: "Updated" }));
          })
          .execute();
      });
    },
    async updateUser() {
      await serverFragment.fragment.inContext(async function (this: DatabaseRequestContext) {
        await this.handlerTx()
          .mutate(({ forSchema }) =>
            forSchema(appSchema).update("users", "user-1", (update) =>
              update.set({ name: "Grace" }),
            ),
          )
          .execute();
      });
    },
    async readPersistedCheckpoint(collectionId: string) {
      const adapter = persistence.adapter;
      if (!adapter.loadCollectionMetadata) {
        throw new Error("The persistence adapter does not support collection metadata.");
      }

      const metadata = await adapter.loadCollectionMetadata(collectionId);
      return metadata.find(({ key }) => key === FRAGNO_OUTBOX_CHECKPOINT_METADATA_KEY)?.value as
        | FragnoOutboxCheckpoint
        | undefined;
    },
    async cleanup() {
      await Promise.all(collections.map((collection) => collection.cleanup()));
      coordinator.dispose();
      database.close();
      await setup.test.cleanup();
    },
  };
}

async function waitForPersistedCheckpoint(options: {
  expected: FragnoOutboxCheckpoint;
  read(): Promise<FragnoOutboxCheckpoint | undefined>;
}): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= PERSISTENCE_TIMEOUT_MS) {
    if (JSON.stringify(await options.read()) === JSON.stringify(options.expected)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Timed out waiting for persisted checkpoint ${options.expected.versionstamp}.`);
}

describe("Fragno outbox coordinator end-to-end", () => {
  it("synchronizes every registered collection through one collection utility call", async () => {
    const harness = await createCoordinatorHarness("shared-sync");

    try {
      await harness.createUserAndPost();
      const users = harness.createUsersCollection();
      const posts = harness.createPostsCollection();

      await Promise.all([users.preload(), posts.preload()]);
      await harness.coordinator.syncOnce();
      harness.fetchedVersionstamps.length = 0;

      await harness.updateUserAndPost();
      await users.utils.syncOnce();

      expect(users.get("user-1")).toMatchObject({ id: "user-1", name: "Grace" });
      expect(posts.get("post-1")).toMatchObject({ id: "post-1", title: "Updated" });

      const usersCheckpoint = users.utils.getCheckpoint();
      const postsCheckpoint = posts.utils.getCheckpoint();
      assert(usersCheckpoint && postsCheckpoint);
      expect(postsCheckpoint).toEqual(usersCheckpoint);
      expect(harness.fetchedVersionstamps).toEqual([usersCheckpoint.versionstamp]);

      await Promise.all([
        waitForPersistedCheckpoint({
          expected: usersCheckpoint,
          read: () => harness.readPersistedCheckpoint("shared-sync.users"),
        }),
        waitForPersistedCheckpoint({
          expected: postsCheckpoint,
          read: () => harness.readPersistedCheckpoint("shared-sync.posts"),
        }),
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("exposes an incomplete cross-collection join between sequential UOW commits", async () => {
    const harness = await createCoordinatorHarness("incomplete-join");

    try {
      await harness.createUserAndPost();
      const users = harness.createUsersCollection();
      const posts = harness.createPostsCollection();
      await Promise.all([users.preload(), posts.preload()]);
      await harness.coordinator.syncOnce();

      const joinedPosts = createLiveQueryCollection((query) =>
        query
          .from({ post: posts })
          .innerJoin({ user: users }, ({ post, user }) => eq(post.authorId, user.id))
          .select(({ post, user }) => ({
            id: post.id,
            authorName: user.name,
            title: post.title,
          })),
      );
      await joinedPosts.preload();

      const snapshots: Array<Array<{ authorName: string; title: string }>> = [];
      const subscription = joinedPosts.subscribeChanges(
        () => {
          snapshots.push(
            [...joinedPosts.values()].map(({ authorName, title }) => ({ authorName, title })),
          );
        },
        { includeInitialState: false },
      );

      try {
        expect([...joinedPosts.values()]).toEqual([
          expect.objectContaining({ authorName: "Ada", title: "First" }),
        ]);

        await harness.updateUserAndPost();
        await users.utils.syncOnce();
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Sequential collection commits intentionally remain observable until TanStack exposes a
        // cross-collection sync transaction. Keep this assertion as the executable limitation.
        const incompleteIndex = snapshots.findIndex(
          ([row]) => row?.authorName === "Grace" && row.title === "First",
        );
        const completeIndex = snapshots.findIndex(
          ([row]) => row?.authorName === "Grace" && row.title === "Updated",
        );

        assert(incompleteIndex >= 0);
        assert(completeIndex > incompleteIndex);
        expect([...joinedPosts.values()]).toEqual([
          expect.objectContaining({ authorName: "Grace", title: "Updated" }),
        ]);
      } finally {
        subscription.unsubscribe();
        await joinedPosts.cleanup();
      }
    } finally {
      await harness.cleanup();
    }
  });

  it("replays history for a late collection while an advanced collection skips stale entries", async () => {
    const harness = await createCoordinatorHarness("late-registration");

    try {
      await harness.createUserAndPost();
      const users = harness.createUsersCollection();
      await users.preload();
      await harness.coordinator.syncOnce();

      const createCheckpoint = users.utils.getCheckpoint();
      assert(createCheckpoint);

      await harness.updateUser();
      await users.utils.syncOnce();
      await harness.coordinator.syncOnce();

      const updateCheckpoint = users.utils.getCheckpoint();
      assert(updateCheckpoint);
      assert(updateCheckpoint.versionstamp > createCheckpoint.versionstamp);
      harness.fetchedVersionstamps.length = 0;

      const posts = harness.createPostsCollection();
      await posts.preload();
      await harness.coordinator.syncOnce();

      expect(users.get("user-1")).toMatchObject({ id: "user-1", name: "Grace" });
      expect(posts.get("post-1")).toMatchObject({ id: "post-1", title: "First" });
      expect(users.utils.getCheckpoint()).toEqual(updateCheckpoint);
      expect(posts.utils.getCheckpoint()).toEqual(updateCheckpoint);
      expect(harness.fetchedVersionstamps).toEqual([
        createCheckpoint.versionstamp,
        updateCheckpoint.versionstamp,
      ]);
    } finally {
      await harness.cleanup();
    }
  });
});
