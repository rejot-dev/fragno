import { assert, describe, expect, expectTypeOf, it } from "vitest";

import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";
import {
  decodeFragnoStateValue,
  encodeFragnoStateValue,
  type FragnoStateChangeEvent,
} from "@fragno-dev/db/state-protocol";
import Database from "better-sqlite3";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, createFragmentTestFetcher } from "@fragno-dev/test";

import { BasicIndex, createLiveQueryCollection, eq } from "@tanstack/db";
import type {
  PersistedCollectionCoordinator,
  PersistedCollectionPersistence,
  PersistedIndexSpec,
  PersistedTx,
  PersistenceAdapter,
  ProtocolEnvelope,
} from "@tanstack/db-sqlite-persistence-core";
import { createNodeSQLitePersistence } from "@tanstack/node-db-sqlite-persistence";

import { parseStreamOffset } from "./consumer/stream-offset";
import {
  createFragnoStateSchema,
  createFragnoStreamDB,
  type FragnoStreamDBStatus,
  type FragnoStreamRow,
} from "./stream-db";
import {
  createCollectionRegistry,
  createSourceCollectionActivationBridge,
  restorePersistedMaterializedRows,
} from "./tanstack/state-sink";

const appSchema = schema("stream_app", (s) =>
  s
    .addTable("user", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("createdAt", column("timestamp")),
    )
    .addTable("post", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("authorId", referenceColumn({ table: "user" }))
        .addColumn("title", column("string"))
        .addColumn("updatedAt", column("timestamp")),
    ),
);

const commentSchema = schema("comment", (s) =>
  s.addTable("comment", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("content", column("string"))
      .addColumn("postReference", column("string")),
  ),
);

const signalSchema = schema("signal", (s) =>
  s.addTable("total", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("reference", column("string"))
      .addColumn("total", column("integer")),
  ),
);

const defaultsSchema = schema("stream_defaults", (s) =>
  s.addTable("item", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("name", column("string"))
      .addColumn("enabled", column("bool").defaultTo(true))
      .addColumn("runtimeLabel", column("string").defaultTo$("generated"))
      .addColumn("note", column("string").nullable()),
  ),
);

const replayDefaultsV1Schema = schema("stream_replay_defaults", (s) =>
  s.addTable("item", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);

const replayDefaultsSchema = schema("stream_replay_defaults", (s) =>
  s
    .addTable("item", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
    .alterTable("item", (t) =>
      t
        .addColumn("enabled", column("bool").defaultTo(true))
        .addColumn("note", column("string").nullable()),
    ),
);

const appStateInput = {
  users: { schema: appSchema, table: "user" },
  posts: { schema: appSchema, table: "post" },
} as const;
const commentStateInput = {
  comments: { schema: commentSchema, table: "comment" },
} as const;
const signalStateInput = {
  totals: { schema: signalSchema, table: "total" },
} as const;

const appState = createFragnoStateSchema(appStateInput);
const commentState = createFragnoStateSchema(commentStateInput);
const defaultsState = createFragnoStateSchema({
  items: { schema: defaultsSchema, table: "item" },
});
const replayDefaultsState = createFragnoStateSchema({
  items: { schema: replayDefaultsSchema, table: "item" },
});
const commentSignalState = createFragnoStateSchema({
  ...commentStateInput,
  ...signalStateInput,
});
const appCommentState = createFragnoStateSchema({
  ...appStateInput,
  ...commentStateInput,
});
const commentAppState = createFragnoStateSchema({
  ...commentStateInput,
  ...appStateInput,
});

const appFragmentDefinition = defineFragment("tanstack-db-app")
  .extend(withDatabase(appSchema))
  .build();
const commentFragmentDefinition = defineFragment("tanstack-db-comment")
  .extend(withDatabase(commentSchema))
  .build();
const signalFragmentDefinition = defineFragment("tanstack-db-signal")
  .extend(withDatabase(signalSchema))
  .build();
const defaultsFragmentDefinition = defineFragment("tanstack-db-defaults")
  .extend(withDatabase(defaultsSchema))
  .build();
const replayDefaultsFragmentDefinition = defineFragment("tanstack-db-replay-defaults")
  .extend(withDatabase(replayDefaultsV1Schema))
  .build();

const streamServerOptions = {
  mountRoute: "",
  outbox: { enabled: true },
} as const;

const buildSQLiteStreamTestServer = async () => {
  const result = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment("app", instantiate(appFragmentDefinition).withOptions(streamServerOptions))
    .withFragment(
      "comments",
      instantiate(commentFragmentDefinition).withOptions(streamServerOptions),
    )
    .withFragment("signals", instantiate(signalFragmentDefinition).withOptions(streamServerOptions))
    .withFragment(
      "defaults",
      instantiate(defaultsFragmentDefinition).withOptions(streamServerOptions),
    )
    .build();

  const fragment = result.fragments.app.fragment;
  return {
    ...result,
    fragment,
    fetch: createFragmentTestFetcher(fragment),
    url: "http://fragno.test/_internal/outbox/durable/state",
  };
};

const offsetFor = (value: number) => value.toString(16).padStart(25, "0");

type MutableStateChangeEvent = {
  type: string;
  key: string;
  value?: unknown;
  headers: FragnoStateChangeEvent["headers"];
};

const transformStateEventResponse = async (
  response: Response,
  transform: (events: MutableStateChangeEvent[]) => void,
): Promise<Response> => {
  if (response.status === 204 || response.status === 304) {
    return response;
  }

  const events = (await response.json()) as MutableStateChangeEvent[];
  transform(events);
  return new Response(JSON.stringify(events), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const createStateEventTransformFetcher =
  (fetcher: typeof fetch, transform: (events: MutableStateChangeEvent[]) => void): typeof fetch =>
  async (input, init) =>
    transformStateEventResponse(await fetcher(input, init), transform);

const replaceEventValue = (
  event: MutableStateChangeEvent,
  transform: (value: Record<string, unknown>) => void,
): void => {
  const decoded = decodeFragnoStateValue(event.value);
  transform(decoded.value);
  event.value = encodeFragnoStateValue(decoded.mode, decoded.value);
};

const insertEventFrom = (
  template: MutableStateChangeEvent,
  key: string,
  row: Record<string, unknown>,
): MutableStateChangeEvent => ({
  type: template.type,
  key,
  value: encodeFragnoStateValue("row", row),
  headers: { ...template.headers, operation: "insert" },
});

const updateEventFrom = (
  template: MutableStateChangeEvent,
  key: string,
  patch: Record<string, unknown>,
): MutableStateChangeEvent => ({
  type: template.type,
  key,
  value: encodeFragnoStateValue("patch", patch),
  headers: { ...template.headers, operation: "update" },
});

const deleteEventFrom = (
  template: MutableStateChangeEvent,
  key: string,
): MutableStateChangeEvent => ({
  type: template.type,
  key,
  headers: { ...template.headers, operation: "delete" },
});

const createInvalidUserNameFetcher = (fetcher: typeof fetch): typeof fetch =>
  createStateEventTransformFetcher(fetcher, (events) => {
    const userEvent = events.find((event) => event.type === appState.users.type);
    assert(userEvent);
    replaceEventValue(userEvent, (value) => {
      value["name"] = 42;
    });
  });

const createControllableLiveFailureFetcher = (fetcher: typeof fetch) => {
  let releaseFailure!: () => void;
  const failureReleased = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });

  return {
    releaseFailure,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(input instanceof Request ? input.url : String(input));
      if (requestUrl.searchParams.get("live") !== "long-poll") {
        return fetcher(input, init);
      }

      await failureReleased;
      return new Response("{", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Stream-Next-Offset": requestUrl.searchParams.get("offset") ?? offsetFor(0),
          "Stream-Up-To-Date": "true",
        },
      });
    },
  } satisfies { releaseFailure: () => void; fetch: typeof fetch };
};

const waitForCondition = async (
  condition: () => boolean,
  message: string,
  timeoutMs = 1_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const coordinatorMessage = (
  collectionId: string,
  senderId: string,
  payload: unknown,
): ProtocolEnvelope<unknown> => ({
  v: 1,
  dbName: collectionId,
  collectionId,
  senderId,
  ts: Date.now(),
  payload,
});

const createClientSQLitePersistence = () => {
  const database = new Database(":memory:");
  const provider = createNodeSQLitePersistence({ database });

  return {
    database,
    provider,
    adapterFor(schemaVersion = 1) {
      return (
        provider.resolvePersistenceForCollection?.({
          collectionId: "fragno-stream-test",
          mode: "sync-present",
          schemaVersion,
        }) ?? provider
      ).adapter;
    },
    close() {
      database.close();
    },
  };
};

class TestCoordinatorGroup {
  readonly #subscribers = new Map<
    string,
    Map<string, Set<(message: ProtocolEnvelope<unknown>) => void>>
  >();
  readonly #leaders = new Map<string, boolean>();

  createCoordinator(nodeId: string, leader: boolean): PersistedCollectionCoordinator {
    this.#leaders.set(nodeId, leader);
    return {
      getNodeId: () => nodeId,
      subscribe: (collectionId, listener) => {
        const collectionSubscribers = this.#subscribers.get(collectionId) ?? new Map();
        const nodeSubscribers = collectionSubscribers.get(nodeId) ?? new Set();
        nodeSubscribers.add(listener);
        collectionSubscribers.set(nodeId, nodeSubscribers);
        this.#subscribers.set(collectionId, collectionSubscribers);
        return () => nodeSubscribers.delete(listener);
      },
      publish: (collectionId, message) => this.publish(collectionId, message),
      isLeader: () => this.#leaders.get(nodeId) ?? false,
      ensureLeadership: async () => {},
      requestEnsurePersistedIndex: async (
        _collectionId: string,
        _signature: string,
        _spec: PersistedIndexSpec,
      ) => {},
    };
  }

  setLeader(nodeId: string, leader: boolean): void {
    this.#leaders.set(nodeId, leader);
  }

  publish(collectionId: string, message: ProtocolEnvelope<unknown>): void {
    for (const [subscriberNodeId, listeners] of this.#subscribers.get(collectionId) ?? []) {
      if (subscriberNodeId === message.senderId) {
        continue;
      }
      for (const listener of listeners) {
        listener(message);
      }
    }
  }

  get collectionIds(): string[] {
    return [...this.#subscribers.keys()];
  }

  get subscriberCount(): number {
    let count = 0;
    for (const collectionSubscribers of this.#subscribers.values()) {
      for (const listeners of collectionSubscribers.values()) {
        count += listeners.size;
      }
    }
    return count;
  }
}

class RejectingPersistenceAdapter implements PersistenceAdapter {
  readonly #adapter: PersistenceAdapter;
  readonly #error: Error;

  constructor(adapter: PersistenceAdapter, error: Error) {
    this.#adapter = adapter;
    this.#error = error;
  }

  loadSubset(...args: Parameters<PersistenceAdapter["loadSubset"]>) {
    return this.#adapter.loadSubset(...args);
  }

  async applyCommittedTx(_collectionId: string, _tx: PersistedTx): Promise<void> {
    throw this.#error;
  }

  ensureIndex(...args: Parameters<PersistenceAdapter["ensureIndex"]>) {
    return this.#adapter.ensureIndex(...args);
  }

  loadCollectionMetadata(
    ...args: Parameters<NonNullable<PersistenceAdapter["loadCollectionMetadata"]>>
  ) {
    assert(this.#adapter.loadCollectionMetadata);
    return this.#adapter.loadCollectionMetadata(...args);
  }

  scanRows(...args: Parameters<NonNullable<PersistenceAdapter["scanRows"]>>) {
    assert(this.#adapter.scanRows);
    return this.#adapter.scanRows(...args);
  }

  markIndexRemoved(...args: Parameters<NonNullable<PersistenceAdapter["markIndexRemoved"]>>) {
    assert(this.#adapter.markIndexRemoved);
    return this.#adapter.markIndexRemoved(...args);
  }

  getStreamPosition(...args: Parameters<NonNullable<PersistenceAdapter["getStreamPosition"]>>) {
    assert(this.#adapter.getStreamPosition);
    return this.#adapter.getStreamPosition(...args);
  }
}

class RejectingLoadPersistenceAdapter implements PersistenceAdapter {
  readonly #adapter: PersistenceAdapter;
  readonly #error: Error;
  readonly #successfulLoadsBeforeFailure: number;
  #loadCount = 0;

  constructor(adapter: PersistenceAdapter, error: Error, successfulLoadsBeforeFailure = 0) {
    this.#adapter = adapter;
    this.#error = error;
    this.#successfulLoadsBeforeFailure = successfulLoadsBeforeFailure;
  }

  loadSubset(...args: Parameters<PersistenceAdapter["loadSubset"]>) {
    this.#loadCount += 1;
    if (this.#loadCount <= this.#successfulLoadsBeforeFailure) {
      return this.#adapter.loadSubset(...args);
    }
    return Promise.reject(this.#error);
  }

  applyCommittedTx(...args: Parameters<PersistenceAdapter["applyCommittedTx"]>) {
    return this.#adapter.applyCommittedTx(...args);
  }

  ensureIndex(...args: Parameters<PersistenceAdapter["ensureIndex"]>) {
    return this.#adapter.ensureIndex(...args);
  }
}

class HydrationRowsPersistenceAdapter implements PersistenceAdapter {
  readonly #adapter: PersistenceAdapter;
  readonly #rows: Awaited<ReturnType<PersistenceAdapter["loadSubset"]>>;

  constructor(
    adapter: PersistenceAdapter,
    rows: Awaited<ReturnType<PersistenceAdapter["loadSubset"]>>,
  ) {
    this.#adapter = adapter;
    this.#rows = rows;
  }

  async loadSubset(): Promise<Awaited<ReturnType<PersistenceAdapter["loadSubset"]>>> {
    return structuredClone(this.#rows);
  }

  applyCommittedTx(...args: Parameters<PersistenceAdapter["applyCommittedTx"]>) {
    return this.#adapter.applyCommittedTx(...args);
  }

  ensureIndex(...args: Parameters<PersistenceAdapter["ensureIndex"]>) {
    return this.#adapter.ensureIndex(...args);
  }
}

class PausedPersistenceAdapter implements PersistenceAdapter {
  readonly writeStarted: Promise<void>;
  readonly #writesReleased: Promise<void>;
  readonly #adapter: PersistenceAdapter;
  #resolveWriteStarted!: () => void;
  #releaseWrites!: () => void;

  constructor(adapter: PersistenceAdapter) {
    this.#adapter = adapter;
    this.writeStarted = new Promise((resolve) => {
      this.#resolveWriteStarted = resolve;
    });
    this.#writesReleased = new Promise((resolve) => {
      this.#releaseWrites = resolve;
    });
  }

  loadSubset(...args: Parameters<PersistenceAdapter["loadSubset"]>) {
    return this.#adapter.loadSubset(...args);
  }

  async applyCommittedTx(collectionId: string, tx: PersistedTx) {
    this.#resolveWriteStarted();
    await this.#writesReleased;
    await this.#adapter.applyCommittedTx(collectionId, tx);
  }

  ensureIndex(...args: Parameters<PersistenceAdapter["ensureIndex"]>) {
    return this.#adapter.ensureIndex(...args);
  }

  loadCollectionMetadata(
    ...args: Parameters<NonNullable<PersistenceAdapter["loadCollectionMetadata"]>>
  ) {
    assert(this.#adapter.loadCollectionMetadata);
    return this.#adapter.loadCollectionMetadata(...args);
  }

  scanRows(...args: Parameters<NonNullable<PersistenceAdapter["scanRows"]>>) {
    assert(this.#adapter.scanRows);
    return this.#adapter.scanRows(...args);
  }

  markIndexRemoved(...args: Parameters<NonNullable<PersistenceAdapter["markIndexRemoved"]>>) {
    assert(this.#adapter.markIndexRemoved);
    return this.#adapter.markIndexRemoved(...args);
  }

  getStreamPosition(...args: Parameters<NonNullable<PersistenceAdapter["getStreamPosition"]>>) {
    assert(this.#adapter.getStreamPosition);
    return this.#adapter.getStreamPosition(...args);
  }

  releaseWrites(): void {
    this.#releaseWrites();
  }
}

describe("createFragnoStreamDB SQLite integration", () => {
  it("exposes materialized stream row and status types", () => {
    type UserStreamRow = FragnoStreamRow<typeof appSchema.tables.user>;
    type ExpectedUserStreamRow = { id: string; name: string; createdAt: Date };
    expectTypeOf<UserStreamRow>().toMatchTypeOf<ExpectedUserStreamRow>();
    expectTypeOf<ExpectedUserStreamRow>().toMatchTypeOf<UserStreamRow>();
    expectTypeOf<
      FragnoStreamRow<typeof appSchema.tables.post>["authorId"]
    >().toEqualTypeOf<string>();
    expectTypeOf<FragnoStreamRow<typeof defaultsSchema.tables.item>>().toEqualTypeOf<{
      id: string;
      name: string;
      enabled: boolean;
      runtimeLabel: string;
      note: string | null;
    }>();

    const assertStatusContract = (status: FragnoStreamDBStatus) => {
      if (status.status === "error") {
        expectTypeOf(status.error).toEqualTypeOf<Error>();
      } else {
        expectTypeOf(status.error).toEqualTypeOf<null>();
      }
    };
    assertStatusContract({ status: "idle", offset: "-1", error: null });
  });

  it("starts synchronization when a returned collection gains a subscriber", async () => {
    const server = await buildSQLiteStreamTestServer();
    let requestCount = 0;

    await server.fragments.app.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).create("user", {
            id: "user-1",
            name: "Subscription Ada",
            createdAt: new Date("2026-07-17T10:00:00.000Z"),
          });
        })
        .execute();
    });

    const db = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: async (input, init) => {
          requestCount += 1;
          return server.fetch(input, init);
        },
      },
      live: false,
    });

    await db.drain();
    expect(requestCount).toBe(0);
    expect(db.status).toEqual({ status: "idle", offset: "-1", error: null });

    const users = db.collections.users;
    const subscription = users.subscribeChanges(() => {});

    try {
      const status = await db.drain();
      expect(requestCount).toBe(1);
      expect(users.get("user-1")).toMatchObject({ name: "Subscription Ada" });
      expect(status).toMatchObject({ status: "ready", offset: expect.any(String) });
    } finally {
      subscription.unsubscribe();
      await db.close();
      await server.test.cleanup();
    }
  });

  it("keeps collection preload pending until initial durable stream catch-up", async () => {
    const server = await buildSQLiteStreamTestServer();
    let releaseRequest!: () => void;
    let resolveRequestStarted!: () => void;
    const requestReleased = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const requestStarted = new Promise<void>((resolve) => {
      resolveRequestStarted = resolve;
    });

    await server.fragments.app.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).create("user", {
            id: "user-1",
            name: "Preload Ada",
            createdAt: new Date("2026-07-17T10:00:00.000Z"),
          });
        })
        .execute();
    });

    const db = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: async (input, init) => {
          resolveRequestStarted();
          await requestReleased;
          return server.fetch(input, init);
        },
      },
      live: false,
    });

    try {
      const collectionPreload = db.collections.users.preload();
      await requestStarted;

      const preloadState = await Promise.race([
        collectionPreload.then(() => "resolved" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
      ]);
      expect(preloadState).toBe("pending");
    } finally {
      releaseRequest();
      await db.close();
      await server.test.cleanup();
    }
  });

  it("keeps derived live queries loading until initial durable stream catch-up", async () => {
    const server = await buildSQLiteStreamTestServer();
    let releaseRequest!: () => void;
    let resolveRequestStarted!: () => void;
    const requestReleased = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const requestStarted = new Promise<void>((resolve) => {
      resolveRequestStarted = resolve;
    });

    await server.fragments.app.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).create("user", {
            id: "user-1",
            name: "Derived Ada",
            createdAt: new Date("2026-07-17T10:00:00.000Z"),
          });
        })
        .execute();
    });

    const db = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: async (input, init) => {
          resolveRequestStarted();
          await requestReleased;
          return server.fetch(input, init);
        },
      },
      live: false,
    });
    const derivedUsers = createLiveQueryCollection({
      query: (query) =>
        query
          .from({ user: db.collections.users })
          .select(({ user }) => ({ id: user.id, name: user.name })),
      getKey: (user) => user.id,
      startSync: false,
      gcTime: 0,
    });

    try {
      const derivedPreload = derivedUsers.preload();
      await requestStarted;

      assert(derivedUsers.status === "loading");
      const preloadState = await Promise.race([
        derivedPreload.then(() => "resolved" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
      ]);
      expect(preloadState).toBe("pending");

      releaseRequest();
      await derivedPreload;
      expect(derivedUsers.get("user-1")).toMatchObject({
        id: "user-1",
        name: "Derived Ada",
      });
    } finally {
      releaseRequest();
      await derivedUsers.cleanup();
      await db.close();
      await server.test.cleanup();
    }
  });

  it("rejects collection preload when initial durable stream synchronization fails", async () => {
    const server = await buildSQLiteStreamTestServer();

    await server.fragments.app.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).create("user", {
            id: "user-1",
            name: "Invalid Ada",
            createdAt: new Date("2026-07-17T10:00:00.000Z"),
          });
        })
        .execute();
    });

    const db = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: createInvalidUserNameFetcher(server.fetch),
      },
      live: false,
    });

    let unsubscribeStatus: (() => void) | undefined;
    const streamError = new Promise<Error>((resolve) => {
      unsubscribeStatus = db.subscribeStatus((status) => {
        if (status.status === "error") {
          resolve(status.error);
        }
      });
    });

    try {
      const collectionPreload = db.collections.users.preload();
      expect((await streamError).message).toContain("Invalid streamed row for user");
      await expect(collectionPreload).rejects.toThrow("Invalid streamed row for user");
    } finally {
      unsubscribeStatus?.();
      await db.close();
      await server.test.cleanup();
    }
  });

  it("queues live synchronization behind an in-flight finite synchronization", async () => {
    const server = await buildSQLiteStreamTestServer();
    const requests: URL[] = [];
    let releaseFiniteRequest!: () => void;
    let resolveFiniteRequestStarted!: () => void;
    let resolveLiveRequestStarted!: () => void;
    const finiteRequestReleased = new Promise<void>((resolve) => {
      releaseFiniteRequest = resolve;
    });
    const finiteRequestStarted = new Promise<void>((resolve) => {
      resolveFiniteRequestStarted = resolve;
    });
    const liveRequestStarted = new Promise<void>((resolve) => {
      resolveLiveRequestStarted = resolve;
    });
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url);
      if (requests.length === 1) {
        resolveFiniteRequestStarted();
        await finiteRequestReleased;
      }
      if (url.searchParams.get("live") === "long-poll") {
        resolveLiveRequestStarted();
      }
      return server.fetch(input, init);
    };
    const db = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: fetcher,
      },
    });

    try {
      const finiteSync = db.syncOnce();
      await finiteRequestStarted;
      expect(requests).toHaveLength(1);

      const subscription = db.collections.users.subscribeChanges(() => {});
      expect(requests).toHaveLength(1);

      releaseFiniteRequest();
      await finiteSync;
      await liveRequestStarted;
      assert(requests.some((request) => request.searchParams.get("live") === "long-poll"));
      subscription.unsubscribe();
    } finally {
      releaseFiniteRequest();
      await db.close();
      await server.test.cleanup();
    }
  });

  it("materializes creates, patch updates, deletes, dates, and references", async () => {
    const server = await buildSQLiteStreamTestServer();
    const createdAt = new Date("2026-07-17T10:00:00.000Z");
    const updatedAt = new Date("2026-07-17T10:01:00.000Z");

    await server.fragments.app.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const userId = forSchema(appSchema).create("user", {
            id: "user-1",
            name: "Ada",
            createdAt,
          });
          forSchema(appSchema).create("post", {
            id: "post-1",
            authorId: userId,
            title: "First",
            updatedAt: createdAt,
          });
        })
        .execute();
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).update("post", "post-1", (update) =>
            update.set({ title: "Updated", updatedAt }),
          );
        })
        .execute();
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).delete("user", "user-1");
        })
        .execute();
    });

    const db = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: server.fetch,
      },
      live: false,
    });

    try {
      await db.syncOnce();

      const collections = db.collections;
      expect(collections.users.get("user-1")).toBeUndefined();
      expect(collections.posts.get("post-1")).toEqual(
        expect.objectContaining({
          id: "post-1",
          authorId: "user-1",
          title: "Updated",
          updatedAt,
        }),
      );
      expect(db.status).toMatchObject({ status: "ready", offset: expect.any(String), error: null });
    } finally {
      await db.close();
      await server.test.cleanup();
    }
  });

  it("materializes omitted database defaults and nullable columns", async () => {
    const server = await buildSQLiteStreamTestServer();

    await server.fragments.defaults.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(defaultsSchema).create("item", { name: "Complete row" });
        })
        .execute();
    });

    const db = createFragnoStreamDB({
      state: defaultsState,
      streamOptions: {
        url: server.url,
        fetch: server.fetch,
      },
      live: false,
    });

    try {
      await db.syncOnce();
      expect(db.collections.items.toArray).toEqual([
        expect.objectContaining({
          name: "Complete row",
          enabled: true,
          runtimeLabel: "generated",
          note: null,
        }),
      ]);
    } finally {
      await db.close();
      await server.test.cleanup();
    }
  });

  it("materializes current static defaults while replaying historical creates", async () => {
    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment(
        "replayDefaults",
        instantiate(replayDefaultsFragmentDefinition).withOptions(streamServerOptions),
        { migrateToVersion: 1 },
      )
      .build();
    const fragment = fragments.replayDefaults.fragment;

    await fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(replayDefaultsV1Schema).create("item", {
            id: "item-1",
            name: "Created before defaults were added",
          });
        })
        .execute();
    });

    assert(test.adapter.prepareMigrations);
    await test.adapter
      .prepareMigrations(replayDefaultsSchema, replayDefaultsSchema.name)
      .execute(1, replayDefaultsSchema.version, { updateVersionInMigration: false });

    const db = createFragnoStreamDB({
      state: replayDefaultsState,
      streamOptions: {
        url: "http://fragno.test/_internal/outbox/durable/state",
        fetch: createFragmentTestFetcher(fragment),
      },
      live: false,
    });

    try {
      await db.syncOnce();
      expect(db.collections.items.get("item-1")).toEqual(
        expect.objectContaining({
          name: "Created before defaults were added",
          enabled: true,
          note: null,
        }),
      );
    } finally {
      await db.close();
      await test.cleanup();
    }
  });

  it("supports reactive left joins across collections from different schemas", async () => {
    const server = await buildSQLiteStreamTestServer();
    const db = createFragnoStreamDB({
      state: commentSignalState,
      streamOptions: {
        url: server.url,
        fetch: server.fetch,
      },
      live: false,
    });

    await server.fragments.comments.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(commentSchema).create("comment", {
            id: "comment-1",
            content: "A durable note",
            postReference: "post-1",
          });
        })
        .execute();
    });

    await db.syncOnce();
    const comments = db.collections.comments;
    const totals = db.collections.totals;
    totals.createIndex((row) => row.reference, { indexType: BasicIndex });
    const joined = createLiveQueryCollection((query) =>
      query
        .from({ comment: comments })
        .leftJoin({ total: totals }, ({ comment, total }) =>
          eq(comment.postReference, total.reference),
        ),
    );

    try {
      await joined.preload();
      expect(joined.toArray).toEqual([
        expect.objectContaining({
          comment: expect.objectContaining({ id: "comment-1", content: "A durable note" }),
        }),
      ]);
      assert(joined.toArray[0]?.total === undefined);

      await server.fragments.signals.fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(signalSchema).create("total", {
              id: "total-1",
              reference: "post-1",
              total: 4,
            });
          })
          .execute();
      });
      await db.syncOnce();
      expect(joined.toArray).toEqual([
        expect.objectContaining({
          comment: expect.objectContaining({ id: "comment-1", content: "A durable note" }),
          total: expect.objectContaining({ id: "total-1", total: 4 }),
        }),
      ]);
    } finally {
      await joined.cleanup();
      await db.close();
      await server.test.cleanup();
    }
  });

  it("validates the complete batch before opening collection transactions", async () => {
    const server = await buildSQLiteStreamTestServer();
    await server.fragments.app.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const userId = forSchema(appSchema).create("user", {
            id: "user-1",
            name: "Ada",
            createdAt: new Date("2026-07-17T10:00:00.000Z"),
          });
          forSchema(appSchema).create("post", {
            id: "post-1",
            authorId: userId,
            title: "Valid title",
            updatedAt: new Date("2026-07-17T10:00:00.000Z"),
          });
        })
        .execute();
    });

    let requestCount = 0;
    const fetcher: typeof fetch = async (input, init) => {
      requestCount += 1;
      const response = await server.fetch(input, init);
      if (requestCount !== 1) {
        return response;
      }

      return transformStateEventResponse(response, (events) => {
        const postEvent = events.find((event) => event.type === appState.posts.type);
        assert(postEvent);
        replaceEventValue(postEvent, (value) => {
          value["title"] = 42;
        });
      });
    };
    const db = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: fetcher,
      },
      live: false,
    });

    try {
      await expect(db.syncOnce()).rejects.toThrow("Invalid streamed row for post");
      expect(db.collections.users.get("user-1")).toBeUndefined();

      await db.syncOnce();
      assert(db.collections.users.get("user-1")?.name === "Ada");
    } finally {
      await db.close();
      await server.test.cleanup();
    }
  });

  it("supports repeated finite synchronization from the last offset", async () => {
    const server = await buildSQLiteStreamTestServer();
    const db = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: server.fetch,
      },
      live: false,
    });

    try {
      await server.fragments.app.fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).create("user", {
              id: "user-1",
              name: "Ada",
              createdAt: new Date("2026-07-17T10:00:00.000Z"),
            });
          })
          .execute();
      });
      await db.syncOnce();
      assert(db.collections.users.get("user-1")?.name === "Ada");
      const firstOffset = db.status.offset;

      await server.fragments.app.fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).update("user", "user-1", (update) =>
              update.set({ name: "Ada Lovelace" }),
            );
          })
          .execute();
      });
      await db.syncOnce();
      assert(db.collections.users.get("user-1")?.name === "Ada Lovelace");
      expect(db.status.offset).not.toBe(firstOffset);
    } finally {
      await db.close();
      await server.test.cleanup();
    }
  });

  it("shares one in-flight finite synchronization across concurrent callers", async () => {
    const server = await buildSQLiteStreamTestServer();
    await server.fragments.app.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).create("user", {
            id: "user-1",
            name: "Newest Ada",
            createdAt: new Date("2026-07-17T10:02:00.000Z"),
          });
        })
        .execute();
    });

    let requestCount = 0;
    let releaseRequest!: () => void;
    let resolveRequestStarted!: () => void;
    const requestReleased = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const requestStarted = new Promise<void>((resolve) => {
      resolveRequestStarted = resolve;
    });
    const fetcher: typeof fetch = async (input, init) => {
      requestCount += 1;
      resolveRequestStarted();
      await requestReleased;
      return server.fetch(input, init);
    };
    const db = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: fetcher,
      },
      live: false,
    });

    try {
      const firstSync = db.syncOnce();
      const secondSync = db.syncOnce();
      await requestStarted;
      expect(requestCount).toBe(1);

      releaseRequest();
      await Promise.all([firstSync, secondSync]);

      assert(requestCount === 1);
      expect(db.status).toMatchObject({ status: "ready", offset: expect.any(String) });
      expect(db.collections.users.get("user-1")).toMatchObject({ name: "Newest Ada" });
    } finally {
      releaseRequest();
      await db.close();
      await server.test.cleanup();
    }
  });

  it("rejects a stream response that moves the durable offset backward", async () => {
    const server = await buildSQLiteStreamTestServer();
    await server.fragments.app.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).create("user", {
            id: "user-1",
            name: "Newest Ada",
            createdAt: new Date("2026-07-17T10:02:00.000Z"),
          });
        })
        .execute();
    });

    let requestCount = 0;
    const fetcher: typeof fetch = async (input, init) => {
      requestCount += 1;
      const response = await server.fetch(input, init);
      if (requestCount === 1) {
        return response;
      }

      const headers = new Headers(response.headers);
      headers.set("Stream-Next-Offset", offsetFor(0));
      return new Response(response.body, { status: response.status, headers });
    };
    const db = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: fetcher,
      },
      live: false,
    });

    try {
      await db.syncOnce();
      const currentOffset = db.status.offset;

      await server.fragments.app.fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).update("user", "user-1", (update) =>
              update.set({ name: "Older Ada" }),
            );
          })
          .execute();
      });
      await expect(db.syncOnce()).rejects.toThrow("offset moved backward");

      expect(db.status).toMatchObject({ status: "error", offset: currentOffset });
      expect(db.collections.users.get("user-1")).toMatchObject({ name: "Newest Ada" });
    } finally {
      await db.close();
      await server.test.cleanup();
    }
  });

  it("hydrates client SQLite state and resumes against the Kysely SQLite state route", async () => {
    const server = await buildSQLiteStreamTestServer();
    const clientPersistence = createClientSQLitePersistence();
    const persistence = {
      provider: clientPersistence.provider,
      scope: "account-1",
      version: 1,
    };

    await server.fragments.app.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).create("user", {
            id: "user-1",
            name: "Persisted Ada",
            createdAt: new Date("2026-07-17T10:00:00.000Z"),
          });
        })
        .execute();
    });

    const initialDb = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: server.fetch,
      },
      live: false,
      persistence,
    });
    let resumedDb: ReturnType<typeof createFragnoStreamDB> | undefined;

    try {
      await initialDb.syncOnce();
      const persistedOffset = initialDb.status.offset;
      await initialDb.close();

      await server.fragments.app.fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).update("user", "user-1", (update) =>
              update.set({ name: "Persisted Ada Lovelace" }),
            );
          })
          .execute();
      });

      const requests: URL[] = [];
      resumedDb = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: server.url,
          fetch: async (input, init) => {
            requests.push(new URL(input instanceof Request ? input.url : String(input)));
            return server.fetch(input, init);
          },
        },
        live: false,
        persistence,
      });
      await resumedDb.syncOnce();

      expect(requests[0]?.searchParams.get("offset")).toBe(persistedOffset);
      expect(resumedDb.collections["users"].get("user-1")).toEqual(
        expect.objectContaining({
          name: "Persisted Ada Lovelace",
          createdAt: new Date("2026-07-17T10:00:00.000Z"),
        }),
      );
    } finally {
      await initialDb.close();
      await resumedDb?.close();
      clientPersistence.close();
      await server.test.cleanup();
    }
  });

  it("receives mutations committed after hydration but before the stream request opens", async () => {
    const server = await buildSQLiteStreamTestServer();
    const clientPersistence = createClientSQLitePersistence();
    const persistence = {
      provider: clientPersistence.provider,
      scope: "account-1",
      version: 1,
    };

    await server.fragments.app.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).create("user", {
            id: "user-1",
            name: "Hydrated Ada",
            createdAt: new Date("2026-07-17T10:00:00.000Z"),
          });
        })
        .execute();
    });

    const initialDb = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: server.fetch,
      },
      live: false,
      persistence,
    });
    let resumedDb: ReturnType<typeof createFragnoStreamDB> | undefined;

    try {
      await initialDb.syncOnce();
      const hydratedOffset = initialDb.status.offset;
      await initialDb.close();

      let mutationCommittedBeforeOpen = false;
      resumedDb = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: server.url,
          fetch: async (input, init) => {
            if (!mutationCommittedBeforeOpen) {
              mutationCommittedBeforeOpen = true;
              await server.fragments.app.fragment.inContext(async function () {
                await this.handlerTx()
                  .mutate(({ forSchema }) => {
                    forSchema(appSchema).update("user", "user-1", (update) =>
                      update.set({ name: "Between Hydration and Open Ada" }),
                    );
                  })
                  .execute();
              });
            }
            return server.fetch(input, init);
          },
        },
        live: false,
        persistence,
      });

      await resumedDb.syncOnce();

      assert(mutationCommittedBeforeOpen);
      expect(resumedDb.status.offset).not.toBe(hydratedOffset);
      expect(resumedDb.collections["users"].get("user-1")).toMatchObject({
        name: "Between Hydration and Open Ada",
      });
    } finally {
      await initialDb.close();
      await resumedDb?.close();
      clientPersistence.close();
      await server.test.cleanup();
    }
  });

  it("replays history when the persisted state definition changes", async () => {
    const server = await buildSQLiteStreamTestServer();
    const clientPersistence = createClientSQLitePersistence();
    const persistence = {
      provider: clientPersistence.provider,
      scope: "account-1",
      version: 1,
    };

    await server.fragments.app.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).create("user", {
            id: "user-1",
            name: "Registered Ada",
            createdAt: new Date("2026-07-17T10:00:00.000Z"),
          });
        })
        .execute();
    });
    await server.fragments.comments.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(commentSchema).create("comment", {
            id: "comment-1",
            content: "Created before registration",
            postReference: "post-1",
          });
        })
        .execute();
    });

    const initialDb = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: server.fetch,
      },
      live: false,
      persistence,
    });
    let expandedDb: ReturnType<typeof createFragnoStreamDB> | undefined;

    try {
      await initialDb.syncOnce();
      await initialDb.close();

      expandedDb = createFragnoStreamDB({
        state: appCommentState,
        streamOptions: {
          url: server.url,
          fetch: server.fetch,
        },
        live: false,
        persistence,
      });
      await expandedDb.syncOnce();

      expect(expandedDb.collections["comments"].get("comment-1")).toMatchObject({
        content: "Created before registration",
      });
    } finally {
      await initialDb.close();
      await expandedDb?.close();
      clientPersistence.close();
      await server.test.cleanup();
    }
  });

  it("uses one coordinated source stream across tabs", async () => {
    const server = await buildSQLiteStreamTestServer();
    await server.fragments.app.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).create("user", {
            id: "user-1",
            name: "Shared Ada",
            createdAt: new Date("2026-07-17T10:00:00.000Z"),
          });
        })
        .execute();
    });

    const clientPersistence = createClientSQLitePersistence();
    const persistenceAdapter = clientPersistence.adapterFor();
    const coordinators = new TestCoordinatorGroup();
    let leaderRequestCount = 0;
    let followerRequestCount = 0;
    const leaderFetcher: typeof fetch = async (input, init) => {
      leaderRequestCount += 1;
      return server.fetch(input, init);
    };
    const followerFetcher: typeof fetch = async () => {
      followerRequestCount += 1;
      throw new Error("The follower must not open the source stream.");
    };
    const createTab = (nodeId: string, leader: boolean, fetcher: typeof fetch) =>
      createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: server.url,
          fetch: fetcher,
        },
        persistence: {
          provider: {
            adapter: persistenceAdapter,
            coordinator: coordinators.createCoordinator(nodeId, leader),
          },
          scope: "account-1",
          version: 1,
        },
      });
    const leaderDb = createTab("leader", true, leaderFetcher);
    const followerDb = createTab("follower", false, followerFetcher);

    const leaderSubscription = leaderDb.collections.users.subscribeChanges(() => {});
    const followerSubscription = followerDb.collections.users.subscribeChanges(() => {});

    try {
      await Promise.all([leaderDb.drain(), followerDb.drain()]);
      expect(coordinators.subscriberCount).toBeGreaterThan(0);
      expect(followerDb.collections.users.get("user-1")).toMatchObject({
        name: "Shared Ada",
      });
      expect(followerDb.status).toMatchObject({ status: "ready", offset: expect.any(String) });

      assert(leaderRequestCount >= 1);
      assert(followerRequestCount === 0);
    } finally {
      leaderSubscription.unsubscribe();
      followerSubscription.unsubscribe();
      await Promise.all([leaderDb.close(), followerDb.close()]);
      clientPersistence.close();
      await server.test.cleanup();
    }
  });

  it("propagates a terminal leader error to coordinated followers", async () => {
    const server = await buildSQLiteStreamTestServer();
    await server.fragments.app.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).create("user", {
            id: "user-1",
            name: "Invalid Shared Ada",
            createdAt: new Date("2026-07-17T10:00:00.000Z"),
          });
        })
        .execute();
    });

    const clientPersistence = createClientSQLitePersistence();
    const persistenceAdapter = clientPersistence.adapterFor();
    const coordinators = new TestCoordinatorGroup();
    const leaderFetcher: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "terminal leader failure" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    const createTab = (nodeId: string, leader: boolean, fetcher: typeof fetch) =>
      createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: server.url,
          fetch: fetcher,
        },
        live: false,
        persistence: {
          provider: {
            adapter: persistenceAdapter,
            coordinator: coordinators.createCoordinator(nodeId, leader),
          },
          scope: "account-1",
          version: 1,
        },
      });
    const leaderDb = createTab("leader", true, leaderFetcher);
    const followerDb = createTab("follower", false, async () => {
      throw new Error("The follower must not open the source stream.");
    });

    let unsubscribeLeaderStatus: (() => void) | undefined;
    const leaderError = new Promise<Error>((resolve) => {
      unsubscribeLeaderStatus = leaderDb.subscribeStatus((status) => {
        if (status.status === "error") {
          resolve(status.error);
        }
      });
    });

    try {
      const followerOutcome = followerDb.preload().then(
        () => "resolved" as const,
        () => "rejected" as const,
      );
      const leaderPreload = leaderDb.preload();
      const observedLeaderError = await leaderError;
      expect(observedLeaderError).toBeInstanceOf(Error);
      await expect(leaderPreload).rejects.toBe(observedLeaderError);

      const followerState = await Promise.race([
        followerOutcome,
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
      ]);
      expect(followerState).toBe("rejected");
    } finally {
      unsubscribeLeaderStatus?.();
      await Promise.all([leaderDb.close(), followerDb.close()]);
      clientPersistence.close();
      await server.test.cleanup();
    }
  });

  it("awaits a persisted commit before acknowledging its stream batch", async () => {
    const server = await buildSQLiteStreamTestServer();
    await server.fragments.app.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).create("user", {
            id: "user-1",
            name: "Persisted Before Ready Ada",
            createdAt: new Date("2026-07-17T10:00:00.000Z"),
          });
        })
        .execute();
    });

    const clientPersistence = createClientSQLitePersistence();
    const persistenceAdapter = new PausedPersistenceAdapter(clientPersistence.adapterFor());
    const db = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: server.fetch,
      },
      live: false,
      persistence: {
        provider: { adapter: persistenceAdapter },
        scope: "account-1",
        version: 1,
      },
    });
    const synchronization = db.syncOnce();

    try {
      await persistenceAdapter.writeStarted;
      const synchronizationState = await Promise.race([
        synchronization.then(() => "resolved" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
      ]);
      expect(synchronizationState).toBe("pending");
    } finally {
      persistenceAdapter.releaseWrites();
      await synchronization.catch(() => undefined);
      await db.close();
      clientPersistence.close();
      await server.test.cleanup();
    }
  });

  it("waits for pending persistence writes before close resolves", async () => {
    const server = await buildSQLiteStreamTestServer();
    await server.fragments.app.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).create("user", {
            id: "user-1",
            name: "Persisted Ada",
            createdAt: new Date("2026-07-17T10:00:00.000Z"),
          });
        })
        .execute();
    });

    const clientPersistence = createClientSQLitePersistence();
    const persistenceAdapter = new PausedPersistenceAdapter(clientPersistence.adapterFor());
    const db = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: server.fetch,
      },
      live: false,
      persistence: {
        provider: { adapter: persistenceAdapter },
        scope: "account-1",
        version: 1,
      },
    });

    const synchronization = db.syncOnce();

    try {
      await persistenceAdapter.writeStarted;

      let closeResolved = false;
      const closePromise = db.close().then(() => {
        closeResolved = true;
      });
      await Promise.resolve();
      assert(!closeResolved);

      persistenceAdapter.releaseWrites();
      await Promise.all([synchronization.catch(() => undefined), closePromise]);
      assert(closeResolved);
    } finally {
      persistenceAdapter.releaseWrites();
      await db.close();
      clientPersistence.close();
      await server.test.cleanup();
    }
  });

  it("requires a user or tenant-specific scope for persisted collections", () => {
    const clientPersistence = createClientSQLitePersistence();
    try {
      expect(() =>
        createFragnoStreamDB({
          state: appState,
          streamOptions: {
            url: "https://example.com/_internal/outbox/durable/state",
          },
          live: false,
          persistence: {
            provider: clientPersistence.provider,
            scope: " ",
            version: 1,
          },
        }),
      ).toThrow("persistence requires a non-empty scope");
    } finally {
      clientPersistence.close();
    }
  });

  it("uses one persistence version for the authoritative source collection", async () => {
    const clientPersistence = createClientSQLitePersistence();
    const resolvedVersions: Array<number | undefined> = [];
    const secondarySchema = schema("secondary", (s) =>
      s.addTable("item", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
    );
    const provider: PersistedCollectionPersistence = {
      ...clientPersistence.provider,
      resolvePersistenceForCollection(options) {
        resolvedVersions.push(options.schemaVersion);
        return (
          clientPersistence.provider.resolvePersistenceForCollection?.(options) ??
          clientPersistence.provider
        );
      },
    };

    const db = createFragnoStreamDB({
      state: createFragnoStateSchema({
        ...appStateInput,
        secondaryItems: { schema: secondarySchema, table: "item" },
      }),
      streamOptions: {
        url: "https://example.com/_internal/outbox/durable/state",
      },
      live: false,
      persistence: {
        provider,
        scope: "account-1",
        version: 7,
      },
    });

    try {
      expect(resolvedVersions).toEqual([7]);
    } finally {
      await db.close();
      clientPersistence.close();
    }
  });

  it("rejects invalid persistence versions", () => {
    const clientPersistence = createClientSQLitePersistence();
    try {
      expect(() =>
        createFragnoStreamDB({
          state: appState,
          streamOptions: {
            url: "https://example.com/_internal/outbox/durable/state",
          },
          live: false,
          persistence: {
            provider: clientPersistence.provider,
            scope: "account-1",
            version: -1,
          },
        }),
      ).toThrow("persistence requires a non-negative integer version");
    } finally {
      clientPersistence.close();
    }
  });

  it("replays from the beginning when the cache version changes", async () => {
    const server = await buildSQLiteStreamTestServer();
    await server.fragments.app.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).create("user", {
            id: "user-1",
            name: "Versioned Ada",
            createdAt: new Date("2026-07-17T10:00:00.000Z"),
          });
        })
        .execute();
    });

    const clientPersistence = createClientSQLitePersistence();
    const createPersistence = (version: number) => ({
      provider: clientPersistence.provider,
      scope: "account-1",
      version,
    });
    const initialDb = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: server.fetch,
      },
      live: false,
      persistence: createPersistence(1),
    });
    let nextDb: ReturnType<typeof createFragnoStreamDB> | undefined;

    try {
      await initialDb.syncOnce();
      await initialDb.close();

      const requests: URL[] = [];
      nextDb = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: server.url,
          fetch: async (input, init) => {
            requests.push(new URL(input instanceof Request ? input.url : String(input)));
            return server.fetch(input, init);
          },
        },
        live: false,
        persistence: createPersistence(2),
      });
      await nextDb.syncOnce();
      assert(requests[0]?.searchParams.get("offset") === "-1");
    } finally {
      await initialDb.close();
      await nextDb?.close();
      clientPersistence.close();
      await server.test.cleanup();
    }
  });

  it("uses logical schema names and explicit null namespaces", async () => {
    const nullNamespaceSchema = schema("null_namespace", (s) =>
      s.addTable("item", (t) => t.addColumn("id", idColumn()).addColumn("value", column("string"))),
    );
    const nullNamespaceDefinition = defineFragment("tanstack-db-null-namespace")
      .extend(withDatabase(nullNamespaceSchema))
      .build();
    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment(
        "items",
        instantiate(nullNamespaceDefinition).withOptions({
          ...streamServerOptions,
          databaseNamespace: null,
        }),
      )
      .build();
    const fragment = fragments.items.fragment;

    await fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(nullNamespaceSchema).create("item", { id: "item-1", value: "visible" });
        })
        .execute();
    });

    const db = createFragnoStreamDB({
      state: createFragnoStateSchema({
        items: { schema: nullNamespaceSchema, table: "item", namespace: null },
      }),
      streamOptions: {
        url: "http://fragno.test/_internal/outbox/durable/state",
        fetch: createFragmentTestFetcher(fragment),
      },
      live: false,
    });

    try {
      await db.preload();
      assert(db.collections.items.get("item-1")?.value === "visible");
    } finally {
      await db.close();
      await test.cleanup();
    }
  });

  it("ignores State Protocol event types that are not registered by the consumer", async () => {
    const unrelatedSchema = schema("other", (s) =>
      s.addTable("item", (t) => t.addColumn("id", idColumn()).addColumn("value", column("bool"))),
    );
    const driftedAppSchema = schema(appSchema.name, (s) =>
      s.addTable("comment", (t) =>
        t.addColumn("id", idColumn()).addColumn("body", column("string")),
      ),
    );
    const unrelatedDefinition = defineFragment("tanstack-db-unrelated")
      .extend(withDatabase(unrelatedSchema))
      .build();
    const driftedDefinition = defineFragment("tanstack-db-drifted-app")
      .extend(withDatabase(driftedAppSchema))
      .build();
    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("drifted", instantiate(driftedDefinition).withOptions(streamServerOptions))
      .withFragment("unrelated", instantiate(unrelatedDefinition).withOptions(streamServerOptions))
      .build();
    const fragment = fragments.drifted.fragment;
    const fetcher = createFragmentTestFetcher(fragment);
    const partialConsumer = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: "http://fragno.test/_internal/outbox/durable/state",
        fetch: fetcher,
      },
      live: false,
    });

    try {
      await fragments.unrelated.fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(unrelatedSchema).create("item", { id: "other-1", value: true });
          })
          .execute();
      });
      await expect(partialConsumer.syncOnce()).resolves.toMatchObject({ status: "ready" });

      await fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(driftedAppSchema).create("comment", { id: "comment-1", body: "Unknown" });
          })
          .execute();
      });
      await expect(partialConsumer.syncOnce()).resolves.toMatchObject({ status: "ready" });
      expect(partialConsumer.collections.users.toArray).toEqual([]);
    } finally {
      await partialConsumer.close();
      await test.cleanup();
    }
  });

  it("allows one logical schema to expose collections from distinct physical namespaces", async () => {
    const db = createFragnoStreamDB({
      state: createFragnoStateSchema({
        primaryUsers: { schema: appSchema, table: "user" },
        primaryPosts: { schema: appSchema, table: "post" },
        secondaryUsers: { schema: appSchema, table: "user", namespace: "second" },
        secondaryPosts: { schema: appSchema, table: "post", namespace: "second" },
      }),
      streamOptions: {
        url: "https://example.com/_internal/outbox/durable/state",
      },
      live: false,
    });

    try {
      expect(Object.keys(db.collections)).toEqual([
        "primaryUsers",
        "primaryPosts",
        "secondaryUsers",
        "secondaryPosts",
      ]);
    } finally {
      await db.close();
    }
  });

  it("syncs from the Kysely SQLite backend through the production State Protocol route", async () => {
    const server = await buildSQLiteStreamTestServer();
    await server.fragments.app.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).create("user", {
            id: "user-1",
            name: "Grace",
            createdAt: new Date("2026-07-17T11:00:00.000Z"),
          });
        })
        .execute();
    });

    const db = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: server.fetch,
      },
      live: false,
    });

    try {
      await db.syncOnce();
      expect(db.collections.users.toArray).toEqual([
        expect.objectContaining({ name: "Grace", createdAt: new Date("2026-07-17T11:00:00.000Z") }),
      ]);
    } finally {
      await db.close();
      await server.test.cleanup();
    }
  });

  it("rejects readiness calls after a later terminal live-stream error", async () => {
    const server = await buildSQLiteStreamTestServer();
    await server.fragments.app.fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).create("user", {
            id: "user-1",
            name: "Initially Ready Ada",
            createdAt: new Date("2026-07-17T12:00:00.000Z"),
          });
        })
        .execute();
    });

    let releaseLiveFailure!: () => void;
    const liveFailureReleased = new Promise<void>((resolve) => {
      releaseLiveFailure = resolve;
    });
    const db = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: async (input, init) => {
          const requestUrl = new URL(input instanceof Request ? input.url : String(input));
          if (requestUrl.searchParams.get("live") !== "long-poll") {
            return server.fetch(input, init);
          }

          await liveFailureReleased;
          return new Response("{", {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Stream-Next-Offset": requestUrl.searchParams.get("offset") ?? offsetFor(0),
              "Stream-Up-To-Date": "true",
            },
          });
        },
      },
    });

    let unsubscribeStatus: (() => void) | undefined;
    const streamError = new Promise<Error>((resolve) => {
      unsubscribeStatus = db.subscribeStatus((status) => {
        if (status.status === "error") {
          resolve(status.error);
        }
      });
    });

    try {
      await db.preload();
      releaseLiveFailure();
      expect((await streamError).message).toContain("Failed to parse JSON response");

      const readinessResults = await Promise.allSettled([db.preload(), db.syncOnce()]);
      expect(readinessResults.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    } finally {
      releaseLiveFailure();
      unsubscribeStatus?.();
      await db.close();
      await server.test.cleanup();
    }
  });

  it("materializes post-catch-up mutations through the real long-poll route", async () => {
    const server = await buildSQLiteStreamTestServer();
    const db = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: server.fetch,
      },
    });

    try {
      await db.preload();
      const caughtUpOffset = db.status.offset;
      await server.fragments.app.fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).create("user", {
              id: "user-1",
              name: "Live Grace",
              createdAt: new Date("2026-07-17T12:00:00.000Z"),
            });
          })
          .execute();
      });

      await db.drain({ afterOffset: caughtUpOffset });
      expect(db.collections.users.toArray).toEqual([
        expect.objectContaining({ name: "Live Grace" }),
      ]);
    } finally {
      await db.close();
      await server.test.cleanup();
    }
  });

  it("switches from catch-up to Fragno-compatible long-poll", async () => {
    const server = await buildSQLiteStreamTestServer();
    const requests: URL[] = [];
    let resolveLiveRequestStarted!: () => void;
    const liveRequestStarted = new Promise<void>((resolve) => {
      resolveLiveRequestStarted = resolve;
    });
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url);
      if (url.searchParams.get("live") === "long-poll") {
        resolveLiveRequestStarted();
      }
      return server.fetch(input, init);
    };

    const db = createFragnoStreamDB({
      state: appState,
      streamOptions: {
        url: server.url,
        fetch: fetcher,
      },
    });

    try {
      await db.preload();
      await liveRequestStarted;
      expect(requests).toHaveLength(2);

      assert(requests[0]);
      assert(!requests[0].searchParams.has("live"));
      assert(requests[1]);
      assert(requests[1].searchParams.get("live") === "long-poll");
    } finally {
      await db.close();
      await server.test.cleanup();
    }
  });

  describe("lifecycle and readiness", () => {
    it("rejects synchronization, enters error, invokes onError once, and cleans up when persistence commit fails", async () => {
      const server = await buildSQLiteStreamTestServer();
      await server.fragments.app.fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).create("user", {
              id: "user-1",
              name: "Persistence Failure Ada",
              createdAt: new Date("2026-07-17T10:00:00.000Z"),
            });
          })
          .execute();
      });

      const clientPersistence = createClientSQLitePersistence();
      const persistenceError = new Error("persistence commit failed");
      const reportedErrors: Error[] = [];
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: server.url,
          fetch: server.fetch,
        },
        live: false,
        persistence: {
          provider: {
            adapter: new RejectingPersistenceAdapter(
              clientPersistence.adapterFor(),
              persistenceError,
            ),
          },
          scope: "account-1",
          version: 1,
        },
        onError: (error) => reportedErrors.push(error),
      });

      try {
        await expect(db.syncOnce()).rejects.toBe(persistenceError);
        expect(db.status).toEqual({ status: "error", offset: "-1", error: persistenceError });
        expect(reportedErrors).toEqual([persistenceError]);
        await expect(db.close()).rejects.toThrow(
          "Failed to persist one or more Fragno stream transactions",
        );
      } finally {
        await db.close().catch(() => undefined);
        clientPersistence.close();
        await server.test.cleanup();
      }
    });

    it("returns the same in-flight promise when close is called more than once", async () => {
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: "https://example.com/_internal/outbox/durable/state",
        },
        live: false,
      });

      const firstClose = db.close();
      expect(db.close()).toBe(firstClose);
      await firstClose;
      expect(db.status).toEqual({ status: "closed", offset: "-1", error: null });
    });

    it("rejects pending preload when the database closes before initial readiness", async () => {
      let resolveRequestStarted!: () => void;
      const requestStarted = new Promise<void>((resolve) => {
        resolveRequestStarted = resolve;
      });
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: "https://example.com/_internal/outbox/durable/state",
          fetch: async (_input, init) => {
            resolveRequestStarted();
            const signal = init?.signal;
            return new Promise<Response>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        },
      });

      const preload = db.preload();
      await requestStarted;
      const close = db.close();

      await expect(preload).rejects.toThrow("closed");
      await close;
    });

    it("rejects pending drain afterOffset when the database closes before advancing", async () => {
      const server = await buildSQLiteStreamTestServer();
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: server.url,
          fetch: server.fetch,
        },
        live: false,
      });

      try {
        await db.syncOnce();
        const drain = db.drain({ afterOffset: db.status.offset });
        const close = db.close();

        await expect(drain).rejects.toThrow("closed before its offset advanced");
        await close;
      } finally {
        await db.close();
        await server.test.cleanup();
      }
    });

    it("rejects preload, syncOnce, and drain after the database has closed", async () => {
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: "https://example.com/_internal/outbox/durable/state",
        },
        live: false,
      });
      await db.close();

      await expect(db.preload()).rejects.toThrow("Fragno stream database is closed");
      await expect(db.syncOnce()).rejects.toThrow("Fragno stream database is closed");
      await expect(db.drain()).rejects.toThrow("Fragno stream database is closed");
      expect(db.status).toEqual({ status: "closed", offset: "-1", error: null });
    });

    it("aborts an in-flight stream request without replacing closed status with an error", async () => {
      let resolveRequestStarted!: () => void;
      const requestStarted = new Promise<void>((resolve) => {
        resolveRequestStarted = resolve;
      });
      const reportedErrors: Error[] = [];
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: "https://example.com/_internal/outbox/durable/state",
          fetch: async (_input, init) => {
            resolveRequestStarted();
            const signal = init?.signal;
            return new Promise<Response>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        },
        live: false,
        onError: (error) => reportedErrors.push(error),
      });

      const synchronization = db.syncOnce();
      await requestStarted;
      await db.close();

      await expect(synchronization).rejects.toThrow("Stream request was aborted");
      expect(db.status).toEqual({ status: "closed", offset: "-1", error: null });
      expect(reportedErrors).toEqual([]);
    });

    it("rejects stateWhenReady when initial stream synchronization fails", async () => {
      const server = await buildSQLiteStreamTestServer();
      await server.fragments.app.fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).create("user", {
              id: "user-1",
              name: "Invalid State Ada",
              createdAt: new Date("2026-07-17T10:00:00.000Z"),
            });
          })
          .execute();
      });
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: server.url,
          fetch: createInvalidUserNameFetcher(server.fetch),
        },
        live: false,
      });

      try {
        await expect(db.collections.users.stateWhenReady()).rejects.toThrow(
          "Invalid streamed row for user",
        );
      } finally {
        await db.close();
        await server.test.cleanup();
      }
    });

    it("rejects toArrayWhenReady when initial stream synchronization fails", async () => {
      const server = await buildSQLiteStreamTestServer();
      await server.fragments.app.fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).create("user", {
              id: "user-1",
              name: "Invalid Array Ada",
              createdAt: new Date("2026-07-17T10:00:00.000Z"),
            });
          })
          .execute();
      });
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: server.url,
          fetch: createInvalidUserNameFetcher(server.fetch),
        },
        live: false,
      });

      try {
        await expect(db.collections.users.toArrayWhenReady()).rejects.toThrow(
          "Invalid streamed row for user",
        );
      } finally {
        await db.close();
        await server.test.cleanup();
      }
    });

    it("rejects collection readiness wrappers after a later terminal stream error", async () => {
      const server = await buildSQLiteStreamTestServer();
      const liveFailure = createControllableLiveFailureFetcher(server.fetch);
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: server.url,
          fetch: liveFailure.fetch,
        },
      });
      const terminalError = new Promise<Error>((resolve) => {
        db.subscribeStatus((status) => {
          if (status.status === "error") {
            resolve(status.error);
          }
        });
      });

      try {
        await db.preload();
        liveFailure.releaseFailure();
        const observedError = await terminalError;
        const users = db.collections.users;

        await expect(users.preload()).rejects.toBe(observedError);
        await expect(users.stateWhenReady()).rejects.toBe(observedError);
        await expect(users.toArrayWhenReady()).rejects.toBe(observedError);
      } finally {
        liveFailure.releaseFailure();
        await db.close();
        await server.test.cleanup();
      }
    });

    it("rejects drain afterOffset when the offset syntax is invalid", async () => {
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: "https://example.com/_internal/outbox/durable/state",
        },
        live: false,
      });

      try {
        await expect(db.drain({ afterOffset: "not-an-offset" })).rejects.toThrow(
          "drain afterOffset must be -1 or a 25-character lowercase hexadecimal offset",
        );
      } finally {
        await db.close();
      }
    });

    it("rejects drain afterOffset when the offset is outside the stream offset range", async () => {
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: "https://example.com/_internal/outbox/durable/state",
        },
        live: false,
      });

      try {
        await expect(db.drain({ afterOffset: "1000000000000000000000001" })).rejects.toThrow(
          "drain afterOffset is outside the Fragno Durable Streams offset range",
        );
      } finally {
        await db.close();
      }
    });

    it("rejects drain afterOffset when the active stream enters error state", async () => {
      const server = await buildSQLiteStreamTestServer();
      const liveFailure = createControllableLiveFailureFetcher(server.fetch);
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: server.url,
          fetch: liveFailure.fetch,
        },
      });

      try {
        await db.preload();
        const drain = db.drain({ afterOffset: db.status.offset });
        liveFailure.releaseFailure();

        await expect(drain).rejects.toThrow("Failed to parse JSON response");
      } finally {
        liveFailure.releaseFailure();
        await db.close();
        await server.test.cleanup();
      }
    });

    it("resolves drain afterOffset immediately when a newer ready checkpoint already exists", async () => {
      const server = await buildSQLiteStreamTestServer();
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: server.url,
          fetch: server.fetch,
        },
        live: false,
      });

      try {
        await db.syncOnce();
        await expect(db.drain({ afterOffset: "-1" })).resolves.toMatchObject({
          status: "ready",
          offset: db.status.offset,
        });
      } finally {
        await db.close();
        await server.test.cleanup();
      }
    });

    it("reports one terminal stream failure to onError exactly once", async () => {
      const server = await buildSQLiteStreamTestServer();
      const liveFailure = createControllableLiveFailureFetcher(server.fetch);
      const reportedErrors: Error[] = [];
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: server.url,
          fetch: liveFailure.fetch,
        },
        onError: (error) => reportedErrors.push(error),
      });
      const terminalError = new Promise<Error>((resolve) => {
        db.subscribeStatus((status) => {
          if (status.status === "error") {
            resolve(status.error);
          }
        });
      });

      try {
        await db.preload();
        liveFailure.releaseFailure();
        const observedError = await terminalError;
        await Promise.allSettled([db.preload(), db.syncOnce(), db.preload()]);

        expect(reportedErrors).toEqual([observedError]);
      } finally {
        liveFailure.releaseFailure();
        await db.close();
        await server.test.cleanup();
      }
    });
  });

  describe("coordinator behavior", () => {
    const createReadyCoordinatorPair = async () => {
      const server = await buildSQLiteStreamTestServer();
      const clientPersistence = createClientSQLitePersistence();
      const persistenceAdapter = clientPersistence.adapterFor();
      const coordinators = new TestCoordinatorGroup();
      const createTab = (nodeId: string, leader: boolean) =>
        createFragnoStreamDB({
          state: appState,
          streamOptions: {
            url: server.url,
            fetch: server.fetch,
          },
          live: false,
          persistence: {
            provider: {
              adapter: persistenceAdapter,
              coordinator: coordinators.createCoordinator(nodeId, leader),
            },
            scope: "account-1",
            version: 1,
          },
        });
      const leaderDb = createTab("leader", true);
      await leaderDb.syncOnce();
      const followerDb = createTab("follower", false);
      const followerPreload = followerDb.preload();
      await waitForCondition(
        () => coordinators.subscriberCount >= 2,
        "Follower did not subscribe to coordinator messages.",
      );
      const collectionId = coordinators.collectionIds[0];
      assert(collectionId);
      const heartbeat = coordinatorMessage(collectionId, "leader", {
        type: "leader:heartbeat",
        term: 1,
        leaderId: "leader",
        latestSeq: 1,
        latestRowVersion: 1,
      });
      const heartbeatInterval = setInterval(
        () => coordinators.publish(collectionId, heartbeat),
        10,
      );
      try {
        coordinators.publish(collectionId, heartbeat);
        await followerPreload;
      } finally {
        clearInterval(heartbeatInterval);
      }

      return {
        collectionId,
        coordinators,
        followerDb,
        leaderDb,
        async cleanup() {
          await Promise.all([leaderDb.close(), followerDb.close()]);
          clientPersistence.close();
          await server.test.cleanup();
        },
      };
    };

    it("promotes a follower to consumer when persisted-collection leadership changes", async () => {
      const server = await buildSQLiteStreamTestServer();
      const clientPersistence = createClientSQLitePersistence();
      const persistenceAdapter = clientPersistence.adapterFor();
      const coordinators = new TestCoordinatorGroup();
      let leaderRequests = 0;
      let followerRequests = 0;
      const createTab = (nodeId: string, leader: boolean, observeRequest: () => void) =>
        createFragnoStreamDB({
          state: appState,
          streamOptions: {
            url: server.url,
            fetch: async (input, init) => {
              observeRequest();
              return server.fetch(input, init);
            },
          },
          persistence: {
            provider: {
              adapter: persistenceAdapter,
              coordinator: coordinators.createCoordinator(nodeId, leader),
            },
            scope: "account-1",
            version: 1,
          },
        });
      const leaderDb = createTab("leader", true, () => {
        leaderRequests += 1;
      });
      const followerDb = createTab("follower", false, () => {
        followerRequests += 1;
      });
      const leaderSubscription = leaderDb.collections.users.subscribeChanges(() => {});
      const followerSubscription = followerDb.collections.users.subscribeChanges(() => {});

      try {
        await Promise.all([leaderDb.drain(), followerDb.drain()]);
        assert(leaderRequests > 0);
        assert(followerRequests === 0);

        coordinators.setLeader("leader", false);
        coordinators.setLeader("follower", true);
        await waitForCondition(
          () => followerRequests > 0,
          "Promoted follower did not open the Durable Streams consumer.",
        );
      } finally {
        leaderSubscription.unsubscribe();
        followerSubscription.unsubscribe();
        await Promise.all([leaderDb.close(), followerDb.close()]);
        clientPersistence.close();
        await server.test.cleanup();
      }
    });

    it("ignores a terminal error published by a stale leader", async () => {
      const pair = await createReadyCoordinatorPair();
      try {
        pair.coordinators.publish(
          pair.collectionId,
          coordinatorMessage(pair.collectionId, "stale-leader", {
            type: "fragno-stream:terminal-error",
            ownerId: "stale-leader",
            offset: pair.followerDb.status.offset,
            error: { name: "Error", message: "stale leader failed" },
          }),
        );
        await Promise.resolve();

        expect(pair.followerDb.status).toMatchObject({ status: "ready", error: null });
      } finally {
        await pair.cleanup();
      }
    });

    it("ignores a terminal error whose offset is behind the current checkpoint", async () => {
      const pair = await createReadyCoordinatorPair();
      try {
        assert(pair.followerDb.status.offset !== "-1");
        pair.coordinators.publish(
          pair.collectionId,
          coordinatorMessage(pair.collectionId, "leader", {
            type: "fragno-stream:terminal-error",
            ownerId: "leader",
            offset: "-1",
            error: { name: "Error", message: "old leader failure" },
          }),
        );
        await Promise.resolve();

        expect(pair.followerDb.status).toMatchObject({ status: "ready", error: null });
      } finally {
        await pair.cleanup();
      }
    });

    it("ignores a committed checkpoint whose owner does not match its sender", async () => {
      const pair = await createReadyCoordinatorPair();
      try {
        const currentOffset = pair.followerDb.status.offset;
        pair.coordinators.publish(
          pair.collectionId,
          coordinatorMessage(pair.collectionId, "leader", {
            type: "tx:committed",
            requiresFullReload: false,
            changedRows: [
              {
                value: {
                  id: "fragno:checkpoint",
                  tableKey: "fragno:<checkpoint>",
                  checkpoint: {
                    offset: currentOffset,
                    cacheVersion: 1,
                    ownerId: "different-owner",
                    generation: "different-owner:1",
                    upToDate: true,
                  },
                },
              },
            ],
          }),
        );
        await Promise.resolve();

        expect(pair.followerDb.status).toMatchObject({
          status: "ready",
          offset: currentOffset,
          error: null,
        });
      } finally {
        await pair.cleanup();
      }
    });

    it("recovers follower readiness from a leader heartbeat after missing the commit message", async () => {
      const pair = await createReadyCoordinatorPair();
      try {
        expect(pair.followerDb.status).toMatchObject({
          status: "ready",
          offset: pair.leaderDb.status.offset,
        });
      } finally {
        await pair.cleanup();
      }
    });

    it("safely ignores malformed and unrelated coordinator messages", async () => {
      const pair = await createReadyCoordinatorPair();
      try {
        const messages = [
          coordinatorMessage(pair.collectionId, "other", null),
          coordinatorMessage(pair.collectionId, "other", { type: "unrelated" }),
          coordinatorMessage(pair.collectionId, "other", {
            type: "fragno-stream:terminal-error",
            ownerId: 42,
            offset: null,
            error: "invalid",
          }),
          coordinatorMessage(pair.collectionId, "other", {
            type: "tx:committed",
            requiresFullReload: false,
            changedRows: [{ value: "invalid" }],
          }),
        ];
        for (const message of messages) {
          pair.coordinators.publish(pair.collectionId, message);
        }
        await Promise.resolve();

        expect(pair.followerDb.status).toMatchObject({ status: "ready", error: null });
      } finally {
        await pair.cleanup();
      }
    });
  });

  describe("materialization boundaries", () => {
    it("ignores updates and deletes for rows that have not been materialized", async () => {
      const server = await buildSQLiteStreamTestServer();
      await server.fragments.comments.fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(commentSchema).create("comment", {
              id: "template",
              content: "Template",
              postReference: "post-1",
            });
          })
          .execute();
      });
      const db = createFragnoStreamDB({
        state: commentState,
        streamOptions: {
          url: server.url,
          fetch: createStateEventTransformFetcher(server.fetch, (events) => {
            const template = events[0];
            assert(template);
            events.splice(
              0,
              events.length,
              updateEventFrom(template, "missing", { content: "Ignored" }),
              deleteEventFrom(template, "missing"),
            );
          }),
        },
        live: false,
      });

      try {
        await expect(db.syncOnce()).resolves.toMatchObject({ status: "ready" });
        expect(db.collections.comments.toArray).toEqual([]);
      } finally {
        await db.close();
        await server.test.cleanup();
      }
    });

    it("materializes a later create after ignored missing-row mutations", async () => {
      const server = await buildSQLiteStreamTestServer();
      await server.fragments.comments.fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(commentSchema).create("comment", {
              id: "template",
              content: "Created last",
              postReference: "post-1",
            });
          })
          .execute();
      });
      const db = createFragnoStreamDB({
        state: commentState,
        streamOptions: {
          url: server.url,
          fetch: createStateEventTransformFetcher(server.fetch, (events) => {
            const template = events[0];
            assert(template);
            const createdRow = decodeFragnoStateValue(template.value).value;
            events.splice(
              0,
              events.length,
              updateEventFrom(template, "comment-1", { content: "Ignored update" }),
              deleteEventFrom(template, "comment-1"),
              insertEventFrom(template, "comment-1", createdRow),
            );
          }),
        },
        live: false,
      });

      try {
        await db.syncOnce();
        expect(db.collections.comments.get("comment-1")).toMatchObject({
          content: "Created last",
          postReference: "post-1",
        });
      } finally {
        await db.close();
        await server.test.cleanup();
      }
    });
    it("rejects a non-string value materialized into a reference column", async () => {
      const server = await buildSQLiteStreamTestServer();
      await server.fragments.app.fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            const userId = forSchema(appSchema).create("user", {
              id: "user-1",
              name: "Invalid Reference Ada",
              createdAt: new Date("2026-07-17T10:00:00.000Z"),
            });
            forSchema(appSchema).create("post", {
              id: "post-1",
              authorId: userId,
              title: "Invalid reference",
              updatedAt: new Date("2026-07-17T10:00:00.000Z"),
            });
          })
          .execute();
      });
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: server.url,
          fetch: createStateEventTransformFetcher(server.fetch, (events) => {
            const postEvent = events.find((event) => event.type === appState.posts.type);
            assert(postEvent);
            replaceEventValue(postEvent, (value) => {
              value["authorId"] = 42;
            });
          }),
        },
        live: false,
      });

      try {
        await expect(db.syncOnce()).rejects.toThrow("Invalid streamed row for post");
      } finally {
        await db.close();
        await server.test.cleanup();
      }
    });

    it("rejects a materialized row that is missing a required column", async () => {
      const server = await buildSQLiteStreamTestServer();
      await server.fragments.app.fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).create("user", {
              id: "user-1",
              name: "Incomplete Ada",
              createdAt: new Date("2026-07-17T10:00:00.000Z"),
            });
          })
          .execute();
      });
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: server.url,
          fetch: createStateEventTransformFetcher(server.fetch, (events) => {
            const userEvent = events.find((event) => event.type === appState.users.type);
            assert(userEvent);
            replaceEventValue(userEvent, (value) => {
              delete value["name"];
            });
          }),
        },
        live: false,
      });

      try {
        await expect(db.syncOnce()).rejects.toThrow("Invalid streamed row for user");
      } finally {
        await db.close();
        await server.test.cleanup();
      }
    });

    it("rejects unknown materialized columns under strict row validation", async () => {
      const server = await buildSQLiteStreamTestServer();
      await server.fragments.app.fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).create("user", {
              id: "user-1",
              name: "Unknown Column Ada",
              createdAt: new Date("2026-07-17T10:00:00.000Z"),
            });
          })
          .execute();
      });
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: server.url,
          fetch: createStateEventTransformFetcher(server.fetch, (events) => {
            const userEvent = events.find((event) => event.type === appState.users.type);
            assert(userEvent);
            replaceEventValue(userEvent, (value) => {
              value["unexpected"] = "not in schema";
            });
          }),
        },
        live: false,
      });

      try {
        await expect(db.syncOnce()).rejects.toThrow("Invalid streamed row for user");
      } finally {
        await db.close();
        await server.test.cleanup();
      }
    });
    it("accepts null for a nullable reference column", async () => {
      const nullableReferenceSchema = schema("nullable_reference", (s) =>
        s
          .addTable("parent", (t) => t.addColumn("id", idColumn()))
          .addTable("child", (t) =>
            t
              .addColumn("id", idColumn())
              .addColumn("parentId", referenceColumn({ table: "parent" }).nullable()),
          ),
      );
      const nullableReferenceDefinition = defineFragment("tanstack-db-nullable-reference")
        .extend(withDatabase(nullableReferenceSchema))
        .build();
      const { fragments, test } = await buildDatabaseFragmentsTest()
        .withTestAdapter({ type: "kysely-sqlite" })
        .withFragment(
          "nullableReference",
          instantiate(nullableReferenceDefinition).withOptions(streamServerOptions),
        )
        .build();
      const fragment = fragments.nullableReference.fragment;

      await fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(nullableReferenceSchema).create("child", {
              id: "child-1",
              parentId: null,
            });
          })
          .execute();
      });
      const db = createFragnoStreamDB({
        state: createFragnoStateSchema({
          parents: { schema: nullableReferenceSchema, table: "parent" },
          children: { schema: nullableReferenceSchema, table: "child" },
        }),
        streamOptions: {
          url: "http://fragno.test/_internal/outbox/durable/state",
          fetch: createFragmentTestFetcher(fragment),
        },
        live: false,
      });

      try {
        await db.syncOnce();
        expect(db.collections.children.get("child-1")).toMatchObject({
          id: "child-1",
          parentId: null,
        });
      } finally {
        await db.close();
        await test.cleanup();
      }
    });

    it("applies delete-create, update-delete, and repeated-update sequences in batch order", async () => {
      const server = await buildSQLiteStreamTestServer();
      await server.fragments.comments.fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(commentSchema).create("comment", {
              id: "template",
              content: "Template",
              postReference: "post-1",
            });
          })
          .execute();
      });
      const db = createFragnoStreamDB({
        state: commentState,
        streamOptions: {
          url: server.url,
          fetch: createStateEventTransformFetcher(server.fetch, (events) => {
            const template = events[0];
            assert(template);
            const create = (key: string, content: string) =>
              insertEventFrom(template, key, { content, postReference: "post-1" });
            const update = (key: string, content: string) =>
              updateEventFrom(template, key, { content });
            const remove = (key: string) => deleteEventFrom(template, key);
            events.splice(
              0,
              events.length,
              remove("delete-create"),
              create("delete-create", "Created after delete"),
              create("update-delete", "Created before delete"),
              update("update-delete", "Updated before delete"),
              remove("update-delete"),
              create("repeated-update", "Initial"),
              update("repeated-update", "First update"),
              update("repeated-update", "Final update"),
            );
          }),
        },
        live: false,
      });

      try {
        await db.syncOnce();
        const comments = db.collections.comments;
        expect(comments.get("delete-create")).toMatchObject({ content: "Created after delete" });
        expect(comments.get("update-delete")).toBeUndefined();
        expect(comments.get("repeated-update")).toMatchObject({ content: "Final update" });
      } finally {
        await db.close();
        await server.test.cleanup();
      }
    });
  });

  describe("persistence boundaries", () => {
    it("isolates persisted rows and offsets between different persistence scopes", async () => {
      const server = await buildSQLiteStreamTestServer();
      await server.fragments.app.fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).create("user", {
              id: "user-1",
              name: "Scoped Ada",
              createdAt: new Date("2026-07-17T10:00:00.000Z"),
            });
          })
          .execute();
      });
      const clientPersistence = createClientSQLitePersistence();
      const firstDb = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: server.url,
          fetch: server.fetch,
        },
        live: false,
        persistence: { provider: clientPersistence.provider, scope: "account-1", version: 1 },
      });
      let secondDb: ReturnType<typeof createFragnoStreamDB> | undefined;

      try {
        await firstDb.syncOnce();
        assert(firstDb.status.offset !== "-1");
        await firstDb.close();

        const requests: URL[] = [];
        secondDb = createFragnoStreamDB({
          state: appState,
          streamOptions: {
            url: server.url,
            fetch: async (input, init) => {
              requests.push(new URL(input instanceof Request ? input.url : String(input)));
              return server.fetch(input, init);
            },
          },
          live: false,
          persistence: { provider: clientPersistence.provider, scope: "account-2", version: 1 },
        });
        await secondDb.syncOnce();

        assert(requests[0]?.searchParams.get("offset") === "-1");
      } finally {
        await firstDb.close();
        await secondDb?.close();
        clientPersistence.close();
        await server.test.cleanup();
      }
    });

    it("reuses client SQLite state when named collections are supplied in a different order", async () => {
      const server = await buildSQLiteStreamTestServer();
      await server.fragments.app.fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).create("user", {
              id: "user-1",
              name: "Ordered Ada",
              createdAt: new Date("2026-07-17T10:00:00.000Z"),
            });
          })
          .execute();
      });
      const clientPersistence = createClientSQLitePersistence();
      const persistence = {
        provider: clientPersistence.provider,
        scope: "account-1",
        version: 1,
      };
      const firstDb = createFragnoStreamDB({
        state: appCommentState,
        streamOptions: {
          url: server.url,
          fetch: server.fetch,
        },
        live: false,
        persistence,
      });
      let reorderedDb: ReturnType<typeof createFragnoStreamDB> | undefined;

      try {
        await firstDb.syncOnce();
        const persistedOffset = firstDb.status.offset;
        await firstDb.close();

        const requests: URL[] = [];
        reorderedDb = createFragnoStreamDB({
          state: commentAppState,
          streamOptions: {
            url: server.url,
            fetch: async (input, init) => {
              requests.push(new URL(input instanceof Request ? input.url : String(input)));
              return server.fetch(input, init);
            },
          },
          live: false,
          persistence,
        });
        await reorderedDb.syncOnce();

        assert(requests[0]?.searchParams.get("offset") === persistedOffset);
        expect(reorderedDb.collections["users"].get("user-1")).toMatchObject({
          name: "Ordered Ada",
        });
      } finally {
        await firstDb.close();
        await reorderedDb?.close();
        clientPersistence.close();
        await server.test.cleanup();
      }
    });

    it("propagates persisted hydration failures before source activation", async () => {
      const clientPersistence = createClientSQLitePersistence();
      const hydrationError = new Error("persisted hydration failed");
      const registry = createCollectionRegistry({
        url: "https://example.com/_internal/outbox/durable/state",
        tableGroups: [{ schema: appSchema }],
        persistence: {
          provider: {
            adapter: new RejectingLoadPersistenceAdapter(
              clientPersistence.adapterFor(),
              hydrationError,
            ),
          },
          scope: "account-1",
          version: 1,
        },
        sourceActivation: createSourceCollectionActivationBridge(),
      });

      try {
        await expect(
          restorePersistedMaterializedRows({ registry, parseOffset: parseStreamOffset }),
        ).rejects.toBe(hydrationError);
      } finally {
        await Promise.all(
          [...registry.tables.values()].map(({ collection }) => collection.cleanup()),
        );
        await registry.sourceCollection.cleanup();
        clientPersistence.close();
      }
    });

    it.each([
      [
        "invalid offset",
        {
          offset: "invalid",
          cacheVersion: 1,
          ownerId: "persisted-owner",
          generation: "persisted-generation",
          upToDate: true,
        },
      ],
      ["invalid shape", { cacheVersion: 1 }],
    ])(
      "discards a persisted checkpoint with an %s and replays from the beginning",
      async (_case, checkpoint) => {
        const server = await buildSQLiteStreamTestServer();
        const clientPersistence = createClientSQLitePersistence();
        const requests: URL[] = [];
        const db = createFragnoStreamDB({
          state: appState,
          streamOptions: {
            url: server.url,
            fetch: async (input, init) => {
              requests.push(new URL(input instanceof Request ? input.url : String(input)));
              return server.fetch(input, init);
            },
          },
          live: false,
          persistence: {
            provider: {
              adapter: new HydrationRowsPersistenceAdapter(clientPersistence.adapterFor(), [
                {
                  key: "fragno:checkpoint",
                  value: {
                    id: "fragno:checkpoint",
                    tableKey: "fragno:<checkpoint>",
                    externalId: "fragno:checkpoint",
                    row: {},
                    checkpoint,
                  },
                },
              ]),
            },
            scope: "account-1",
            version: 1,
          },
        });

        try {
          await db.syncOnce();
          assert(requests[0]?.searchParams.get("offset") === "-1");
        } finally {
          await db.close().catch(() => undefined);
          clientPersistence.close();
          await server.test.cleanup();
        }
      },
    );
  });

  describe("public API validation", () => {
    it.each([1.5, Number.NaN])("rejects persistence version %s", (version) => {
      const clientPersistence = createClientSQLitePersistence();
      try {
        expect(() =>
          createFragnoStreamDB({
            state: appState,
            streamOptions: {
              url: "https://example.com/_internal/outbox/durable/state",
            },
            live: false,
            persistence: {
              provider: clientPersistence.provider,
              scope: "account-1",
              version,
            },
          }),
        ).toThrow("persistence requires a non-negative integer version");
      } finally {
        clientPersistence.close();
      }
    });

    it("forwards configured headers and query parameters to Durable Streams requests", async () => {
      const server = await buildSQLiteStreamTestServer();
      let observedRequest: Request | undefined;
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: server.url,
          headers: { Authorization: "Bearer stream-token", "X-Stream-Tenant": "tenant-1" },
          params: { shard: "primary", session: async () => "session-1" },
          fetch: async (input, init) => {
            observedRequest = new Request(input, init);
            return server.fetch(input, init);
          },
        },
        live: false,
      });

      try {
        await db.syncOnce();
        assert(observedRequest);
        const requestUrl = new URL(observedRequest.url);
        assert(requestUrl.searchParams.get("shard") === "primary");
        assert(requestUrl.searchParams.get("session") === "session-1");
        assert(observedRequest.headers.get("Authorization") === "Bearer stream-token");
        assert(observedRequest.headers.get("X-Stream-Tenant") === "tenant-1");
      } finally {
        await db.close();
        await server.test.cleanup();
      }
    });
  });

  describe("stream protocol failures", () => {
    it.each([
      ["uppercase", "000000000000000000000000A"],
      ["incorrectly sized", "0"],
      ["out of range", "1000000000000000000000001"],
    ])("rejects a %s durable stream offset", async (_case, offset) => {
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: "https://example.com/_internal/outbox/durable/state",
          fetch: async () =>
            new Response("[]", {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Stream-Next-Offset": offset,
                "Stream-Up-To-Date": "true",
              },
            }),
        },
        live: false,
      });

      try {
        await expect(db.syncOnce()).rejects.toThrow(/Durable Streams batch offset/);
        assert(db.status.status === "error");
      } finally {
        await db.close();
      }
    });

    it("rejects finite synchronization when the response closes before becoming up to date", async () => {
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: "https://example.com/_internal/outbox/durable/state",
          fetch: async () =>
            new Response("[]", {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Stream-Next-Offset": offsetFor(0),
                "Stream-Closed": "true",
              },
            }),
        },
        live: false,
      });

      const synchronizationOutcome = await Promise.race([
        db.syncOnce().then(
          () => "resolved" as const,
          () => "rejected" as const,
        ),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
      ]);
      assert(
        synchronizationOutcome === "rejected",
        `Expected a closed finite response to reject, received ${synchronizationOutcome}.`,
      );
      void db.close();
    });

    it("marks source and downstream derived collections as failed when initial live synchronization fails", async () => {
      const db = createFragnoStreamDB({
        state: appState,
        streamOptions: {
          url: "https://example.com/_internal/outbox/durable/state",
          fetch: async () =>
            new Response(JSON.stringify({ error: "initial live failure" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }),
        },
      });
      const users = db.collections.users;
      const derivedUsers = createLiveQueryCollection({
        query: (query) =>
          query.from({ user: users }).select(({ user }) => ({ id: user.id, name: user.name })),
        getKey: (user) => user.id,
        startSync: false,
        gcTime: 0,
      });

      try {
        // TanStack's generic preload() promise only listens for first readiness; it does not expose
        // an error callback. The collection lifecycle still transitions immediately and Fragno's
        // own public collections compose preload() with the stream error promise.
        void derivedUsers.preload();
        await waitForCondition(
          () => users.status === "error" && derivedUsers.status === "error",
          "Expected source and downstream derived collections to enter error state.",
        );
        assert(users.status === "error");
        assert(derivedUsers.status === "error");
      } finally {
        await derivedUsers.cleanup();
        await db.close();
      }
    });
  });
});
