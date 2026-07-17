import { describe, expect, expectTypeOf, it, assert } from "vitest";

import { column, idColumn, schema } from "@fragno-dev/db/schema";
import { cleanStores } from "nanostores";

import { InMemoryLofiAdapter } from "../adapters/in-memory/adapter";
import type { LofiMutation } from "../types";
import { createLofiQueryStore, type LofiQueryStore } from "./query-store";
import { createLofiRuntime, type LofiRuntime } from "./runtime";
import { createOutboxEntry, createUserMutation, reactiveTestSchema, waitFor } from "./test-utils";
import type { LofiRuntimeTxRetrieveContext } from "./tx";

const ephemeralStoreSchema = schema("ephemeral_store_test", (s) =>
  s
    .addTable("snapshots", (t) =>
      t.addColumn("id", idColumn()).addColumn("committedCount", column("integer")),
    )
    .addTable("events", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("value", column("string"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((builder) => builder.now()),
        ),
    )
    .addTable("alerts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("value", column("string"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((builder) => builder.now()),
        ),
    ),
);

const snapshotCreate = (committedCount = 0, versionstamp = "snapshot-create") =>
  ({
    op: "create",
    schema: ephemeralStoreSchema.name,
    table: "snapshots",
    externalId: "snapshot",
    values: { committedCount },
    versionstamp,
  }) satisfies LofiMutation;

const snapshotUpdate = (committedCount: number, versionstamp: string) =>
  ({
    op: "update",
    schema: ephemeralStoreSchema.name,
    table: "snapshots",
    externalId: "snapshot",
    set: { committedCount },
    versionstamp,
  }) satisfies LofiMutation;

const ephemeralCreate = (
  table: "events" | "alerts",
  externalId: string,
  value: string,
  versionstamp: string,
) =>
  ({
    op: "create",
    schema: ephemeralStoreSchema.name,
    table,
    externalId,
    values: { value, createdAt: new Date(1) },
    versionstamp,
  }) satisfies LofiMutation;

const storeStateMatching = <TData>(
  store: LofiQueryStore<TData>,
  predicate: (state: ReturnType<LofiQueryStore<TData>["get"]>) => boolean,
): Promise<ReturnType<LofiQueryStore<TData>["get"]>> => {
  if (predicate(store.get())) {
    return Promise.resolve(store.get());
  }

  return new Promise((resolve) => {
    let unlisten: () => void = () => undefined;
    unlisten = store.listen((state) => {
      if (predicate(state)) {
        unlisten();
        resolve(state);
      }
    });
  });
};

const createEphemeralStoreRuntime = async (options?: {
  durableMutations?: LofiMutation[];
  initialEntries?: unknown[];
}) => {
  const adapter = new InMemoryLofiAdapter({
    endpointName: "ephemeral-store-test",
    schemas: [ephemeralStoreSchema],
  });
  await adapter.applyMutations(options?.durableMutations ?? []);
  const responses: unknown[][] = options?.initialEntries ? [options.initialEntries] : [];
  const runtime = createLofiRuntime({
    endpointName: "ephemeral-store-test",
    adapter,
    outboxUrl: "https://example.com/outbox",
    ephemeralTables: [
      {
        schema: ephemeralStoreSchema.name,
        table: "events",
        stream: {
          key: () => "events",
          boundary: (values) =>
            values["value"] === "start" ? "start" : values["value"] === "end" ? "end" : "item",
        },
      },
      { schema: ephemeralStoreSchema.name, table: "alerts" },
    ],
    fetch: (async () => new Response(JSON.stringify(responses.shift() ?? []))) as typeof fetch,
  });

  return {
    adapter,
    runtime,
    enqueue(entries: unknown[]) {
      responses.push(entries);
    },
  };
};

const retrieveSnapshot = ({ forSchema }: LofiRuntimeTxRetrieveContext) => ({
  snapshot: forSchema(ephemeralStoreSchema).findFirst("snapshots", (builder) =>
    builder.whereIndex("primary"),
  ),
});

describe("createLofiQueryStore", () => {
  it("loads rows on mount and exposes query state", async () => {
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [reactiveTestSchema],
    });
    await adapter.applyMutations([createUserMutation("user-a", "Alice")]);
    const runtime = createLofiRuntime({
      endpointName: "app",
      adapter,
      outboxUrl: "https://example.com/outbox",
      fetch: (async () => new Response(JSON.stringify([]))) as typeof fetch,
    });
    const $users = createLofiQueryStore(
      runtime,
      reactiveTestSchema,
      "users",
      (b) => b.whereIndex("primary"),
      { initialData: [] },
    );

    const values: Array<typeof $users extends { get: () => infer T } ? T : never> = [];
    const unlisten = $users.subscribe((value) => values.push(value));

    await waitFor(() => $users.get().synced);

    const firstUserName: string | undefined = $users.get().data[0]?.name;
    expect(firstUserName).toBe("Alice");
    expect($users.get().data).toEqual([expect.objectContaining({ name: "Alice" })]);
    assert(!$users.get().loading);
    expect($users.get().error).toBeNull();
    assert(values.some((value) => value.loading));

    unlisten();
  });

  it("keeps initial data visible until runtime bootstrap completes", async () => {
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [reactiveTestSchema],
    });
    await adapter.applyMutations([createUserMutation("cached-user", "Cached")]);

    let resolveBootstrap: (response: Response) => void = () => undefined;
    const bootstrapResponse = new Promise<Response>((resolve) => {
      resolveBootstrap = resolve;
    });
    let fetchCount = 0;
    const runtime = createLofiRuntime({
      endpointName: "app",
      adapter,
      outboxUrl: "https://example.com/outbox",
      fetch: (async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return bootstrapResponse;
        }
        return new Response(JSON.stringify([]));
      }) as typeof fetch,
    });
    const $users = createLofiQueryStore(
      runtime,
      reactiveTestSchema,
      "users",
      (b) => b.whereIndex("primary"),
      {
        initialData: ["SSR Alice"],
        map: (rows) => rows.map((row) => row.name),
      },
    );

    const unlisten = $users.subscribe(() => undefined);

    await waitFor(() => $users.get().loading);
    runtime.refresh();
    expect($users.get()).toMatchObject({
      data: ["SSR Alice"],
      loading: true,
      synced: false,
      error: null,
    });

    resolveBootstrap(
      new Response(
        JSON.stringify([
          createOutboxEntry({
            versionstamp: "001",
            mutations: [createUserMutation("synced-user", "Synced", "001")],
          }),
        ]),
      ),
    );

    await waitFor(() => $users.get().synced);
    expect($users.get().data).toEqual(["Cached", "Synced"]);
    assert((await adapter.getMeta("app:default:outbox::bootstrap")) === "complete");

    unlisten();
  });

  it("runs multiple local queries from a retrieve-style callback", async () => {
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [reactiveTestSchema],
    });
    await adapter.applyMutations([
      createUserMutation("user-a", "Alice"),
      createUserMutation("user-b", "Bob"),
    ]);
    const runtime = createLofiRuntime({
      endpointName: "app",
      adapter,
      outboxUrl: "https://example.com/outbox",
      fetch: (async () => new Response(JSON.stringify([]))) as typeof fetch,
    });

    let findReturnedData = false;
    const $summary = createLofiQueryStore(
      runtime,
      ({ forSchema }) => {
        const usersQuery = forSchema(reactiveTestSchema).find("users", (b) =>
          b.whereIndex("primary"),
        );
        findReturnedData = Array.isArray(usersQuery);
        return usersQuery
          .findFirst("users", (b) => b.whereIndex("primary"))
          .find("users", (b) => b.whereIndex("primary").selectCount());
      },
      {
        initialData: { names: [] as string[], firstName: null as string | null, total: 0 },
        map: ([users, firstUser, total]) => ({
          names: users.map((user) => user.name),
          firstName: firstUser?.name ?? null,
          total,
        }),
      },
    );

    expectTypeOf($summary.get().data).toEqualTypeOf<{
      names: string[];
      firstName: string | null;
      total: number;
    }>();

    const unlisten = $summary.subscribe(() => undefined);

    await waitFor(() => $summary.get().synced);
    assert(!findReturnedData);
    expect($summary.get().data).toEqual({
      names: ["Alice", "Bob"],
      firstName: "Alice",
      total: 2,
    });

    unlisten();
  });

  it("re-runs when the runtime revision changes", async () => {
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [reactiveTestSchema],
    });
    const runtime = createLofiRuntime({
      endpointName: "app",
      adapter,
      outboxUrl: "https://example.com/outbox",
      fetch: (async () => new Response(JSON.stringify([]))) as typeof fetch,
    });
    const $users = createLofiQueryStore(
      runtime,
      reactiveTestSchema,
      "users",
      (b) => b.whereIndex("primary"),
      {
        initialData: [],
        map: (rows) => rows.map((row) => row.name),
      },
    );

    const unlisten = $users.subscribe(() => undefined);
    await waitFor(() => $users.get().synced);
    expect($users.get().data).toEqual([]);

    await adapter.applyMutations([createUserMutation("user-b", "Bob")]);
    runtime.refresh();

    await waitFor(() => $users.get().data.includes("Bob"));
    const names: string[] = $users.get().data;
    expect(names).toEqual(["Bob"]);

    unlisten();
  });
});

describe("runtime.store().withEphemeral", () => {
  it("queues creates received before the first durable retrieval", async () => {
    const { runtime } = await createEphemeralStoreRuntime({
      initialEntries: [
        createOutboxEntry({
          versionstamp: "001",
          mutations: [
            snapshotCreate(0, "001"),
            ephemeralCreate("events", "event-start", "start", "001-start"),
            ephemeralCreate("events", "event-a", "queued", "001"),
          ],
        }),
      ],
    });
    const store = runtime
      .store()
      .retrieve(retrieveSnapshot)
      .transformRetrieve(({ snapshot }) => ({
        committedCount: snapshot?.committedCount ?? 0,
        values: [] as string[],
      }))
      .withEphemeral(ephemeralStoreSchema, "events", {
        initialState: () => [] as string[],
        reduce: (values, item) => [...values, item.value],
        overlay: (data, values) => ({ ...data, values }),
      })
      .withInitialData({ committedCount: 0, values: [] as string[] });
    const unsubscribe = store.subscribe(() => undefined);

    const state = await storeStateMatching(
      store,
      ({ data, synced }) => synced && data.values.includes("queued"),
    );

    expect(state.data).toEqual({ committedCount: 0, values: ["start", "queued"] });
    unsubscribe();
    cleanStores(store);
  });

  it("does not queue closed historical streams while bootstrap is running", async () => {
    const { runtime } = await createEphemeralStoreRuntime({
      initialEntries: [
        createOutboxEntry({
          versionstamp: "001",
          mutations: [
            snapshotCreate(0, "001-snapshot"),
            ephemeralCreate("events", "old-start", "start", "001-start"),
          ],
        }),
        createOutboxEntry({
          versionstamp: "002",
          mutations: [ephemeralCreate("events", "old-item", "historical", "002")],
        }),
        createOutboxEntry({
          versionstamp: "003",
          mutations: [ephemeralCreate("events", "old-end", "end", "003")],
        }),
        createOutboxEntry({
          versionstamp: "004",
          mutations: [ephemeralCreate("events", "active-start", "start", "004")],
        }),
        createOutboxEntry({
          versionstamp: "005",
          mutations: [ephemeralCreate("events", "active-item", "delta", "005")],
        }),
      ],
    });
    const reducedValues: string[] = [];
    const store = runtime
      .store()
      .retrieve(retrieveSnapshot)
      .transformRetrieve(({ snapshot }) => ({
        committedCount: snapshot?.committedCount ?? 0,
        values: [] as string[],
      }))
      .withEphemeral(ephemeralStoreSchema, "events", {
        initialState: () => [] as string[],
        reduce: (values, item) => {
          reducedValues.push(item.value);
          return [...values, item.value];
        },
        overlay: (data, values) => ({ ...data, values }),
      })
      .withInitialData({ committedCount: 0, values: [] as string[] });
    const statePromise = storeStateMatching(
      store,
      ({ data, synced }) => synced && data.values.includes("delta"),
    );
    const unsubscribe = store.subscribe(() => undefined);

    const state = await statePromise;

    expect(reducedValues).toEqual(["start", "delta"]);
    expect(state.data.values).toEqual(["start", "delta"]);
    unsubscribe();
    cleanStores(store);
  });

  it("replays an active stream when the store mounts after its emissions", async () => {
    const { runtime } = await createEphemeralStoreRuntime({
      durableMutations: [snapshotCreate()],
      initialEntries: [
        createOutboxEntry({
          versionstamp: "001",
          mutations: [ephemeralCreate("events", "event-start", "start", "001")],
        }),
        createOutboxEntry({
          versionstamp: "002",
          mutations: [ephemeralCreate("events", "event-item", "delta", "002")],
        }),
      ],
    });

    await runtime.syncOnce();

    const store = runtime
      .store()
      .retrieve(retrieveSnapshot)
      .transformRetrieve(({ snapshot }) => ({
        committedCount: snapshot?.committedCount ?? 0,
        values: [] as string[],
      }))
      .withEphemeral(ephemeralStoreSchema, "events", {
        initialState: () => [] as string[],
        reduce: (values, item) => [...values, item.value],
        overlay: (data, values) => ({ ...data, values }),
      })
      .withInitialData({ committedCount: 0, values: [] as string[] });
    const statePromise = storeStateMatching(
      store,
      ({ data, synced }) => synced && data.values.includes("delta"),
    );
    const unsubscribe = store.subscribe(() => undefined);

    const state = await statePromise;

    expect(state.data.values).toEqual(["start", "delta"]);
    unsubscribe();
    cleanStores(store);
  });

  it("provides deserialized Date values to ephemeral reducers", async () => {
    const { runtime, enqueue } = await createEphemeralStoreRuntime({
      durableMutations: [snapshotCreate()],
    });
    let reducedCreatedAt: Date | undefined;
    const store = runtime
      .store()
      .retrieve(retrieveSnapshot)
      .withEphemeral(ephemeralStoreSchema, "events", {
        initialState: () => 0,
        reduce: (count, item) => {
          expectTypeOf(item.createdAt).toEqualTypeOf<Date>();
          reducedCreatedAt = item.createdAt;
          return count + 1;
        },
        overlay: (data) => data,
      })
      .withInitialData({ snapshot: null });
    const unsubscribe = store.subscribe(() => undefined);
    await storeStateMatching(store, ({ synced }) => synced);
    runtime.stop();

    enqueue([
      createOutboxEntry({
        versionstamp: "001",
        mutations: [ephemeralCreate("events", "event-a", "dated", "001")],
      }),
    ]);
    await runtime.syncOnce();

    expect(reducedCreatedAt).toBeInstanceOf(Date);
    unsubscribe();
    cleanStores(store);
  });

  it("isolates reducer failures so other stores still receive the mutation", async () => {
    const { runtime, enqueue } = await createEphemeralStoreRuntime({
      durableMutations: [snapshotCreate()],
    });
    const failingStore = runtime
      .store()
      .retrieve(retrieveSnapshot)
      .withEphemeral(ephemeralStoreSchema, "events", {
        initialState: () => 0,
        reduce: () => {
          throw "broken reducer";
        },
        overlay: (data) => data,
      })
      .withInitialData({ snapshot: null });
    const receivingStore = runtime
      .store()
      .retrieve(retrieveSnapshot)
      .transformRetrieve(() => [] as string[])
      .withEphemeral(ephemeralStoreSchema, "events", {
        initialState: () => [] as string[],
        reduce: (values, item) => [...values, item.value],
        overlay: (_data, values) => values,
      })
      .withInitialData([] as string[]);
    const unsubscribeFailing = failingStore.subscribe(() => undefined);
    const unsubscribeReceiving = receivingStore.subscribe(() => undefined);
    await Promise.all([
      storeStateMatching(failingStore, ({ synced }) => synced),
      storeStateMatching(receivingStore, ({ synced }) => synced),
    ]);
    runtime.stop();

    enqueue([
      createOutboxEntry({
        versionstamp: "001",
        mutations: [ephemeralCreate("events", "event-a", "delivered", "001")],
      }),
    ]);
    await runtime.syncOnce();

    expect(failingStore.get().error).toEqual(
      new Error("Lofi query failed", { cause: "broken reducer" }),
    );
    expect(receivingStore.get().data).toEqual(["delivered"]);
    unsubscribeFailing();
    unsubscribeReceiving();
    cleanStores(failingStore, receivingStore);
  });

  it("reconciles ephemeral state after a later durable refresh", async () => {
    const { runtime, enqueue } = await createEphemeralStoreRuntime({
      durableMutations: [snapshotCreate()],
    });
    const store = runtime
      .store()
      .retrieve(retrieveSnapshot)
      .transformRetrieve(({ snapshot }) => ({
        committedCount: snapshot?.committedCount ?? 0,
        values: [] as string[],
      }))
      .withEphemeral(ephemeralStoreSchema, "events", {
        initialState: () => ({ reconciledCount: 0, values: [] as string[] }),
        reduce: (state, item) => ({ ...state, values: [...state.values, item.value] }),
        reconcile: (state, { retrieved }) => {
          const committedCount = retrieved.snapshot?.committedCount ?? 0;
          const newlyCommittedCount = Math.max(0, committedCount - state.reconciledCount);
          return {
            reconciledCount: committedCount,
            values: state.values.slice(newlyCommittedCount),
          };
        },
        overlay: (data, state) => ({ ...data, values: state.values }),
      })
      .withInitialData({ committedCount: 0, values: [] as string[] });
    const unsubscribe = store.subscribe(() => undefined);
    await storeStateMatching(store, ({ synced }) => synced);
    runtime.stop();

    enqueue([
      createOutboxEntry({
        versionstamp: "001",
        mutations: [ephemeralCreate("events", "event-a", "live", "001")],
      }),
    ]);
    const liveState = storeStateMatching(store, ({ data }) => data.values.includes("live"));
    await runtime.syncOnce();
    await liveState;

    enqueue([
      createOutboxEntry({
        versionstamp: "002",
        mutations: [snapshotUpdate(1, "002")],
      }),
    ]);
    const reconciledState = storeStateMatching(
      store,
      ({ data }) => data.committedCount === 1 && data.values.length === 0,
    );
    await runtime.syncOnce();
    await reconciledState;

    expect(store.get().data).toEqual({ committedCount: 1, values: [] });
    unsubscribe();
    cleanStores(store);
  });

  it("does not notify subscribers when reduce ignores an item", async () => {
    const { runtime, enqueue } = await createEphemeralStoreRuntime({
      durableMutations: [snapshotCreate()],
    });
    let reduceCount = 0;
    const store = runtime
      .store()
      .retrieve(retrieveSnapshot)
      .transformRetrieve(({ snapshot }) => ({
        committedCount: snapshot?.committedCount ?? 0,
        values: [] as string[],
      }))
      .withEphemeral(ephemeralStoreSchema, "events", {
        initialState: () => [] as string[],
        reduce: () => {
          reduceCount += 1;
          return undefined;
        },
        overlay: (data, values) => ({ ...data, values }),
      })
      .withInitialData({ committedCount: 0, values: [] as string[] });
    const unsubscribe = store.subscribe(() => undefined);
    await storeStateMatching(store, ({ synced }) => synced);
    runtime.stop();

    let notificationCount = 0;
    const unlisten = store.listen(() => {
      notificationCount += 1;
    });
    enqueue([
      createOutboxEntry({
        versionstamp: "001",
        mutations: [ephemeralCreate("events", "ignored", "ignored", "001")],
      }),
    ]);
    await runtime.syncOnce();

    assert(reduceCount === 1);
    assert(notificationCount === 0);
    unlisten();
    unsubscribe();
    cleanStores(store);
  });

  it("ignores ephemeral update and delete mutations", async () => {
    const { runtime, enqueue } = await createEphemeralStoreRuntime({
      durableMutations: [snapshotCreate()],
    });
    let reduceCount = 0;
    const store = runtime
      .store()
      .retrieve(retrieveSnapshot)
      .transformRetrieve(({ snapshot }) => ({
        committedCount: snapshot?.committedCount ?? 0,
        values: [] as string[],
      }))
      .withEphemeral(ephemeralStoreSchema, "events", {
        initialState: () => [] as string[],
        reduce: (values, item) => {
          reduceCount += 1;
          return [...values, item.value];
        },
        overlay: (data, values) => ({ ...data, values }),
      })
      .withInitialData({ committedCount: 0, values: [] as string[] });
    const unsubscribe = store.subscribe(() => undefined);
    await storeStateMatching(store, ({ synced }) => synced);
    runtime.stop();

    let notificationCount = 0;
    const unlisten = store.listen(() => {
      notificationCount += 1;
    });
    enqueue([
      createOutboxEntry({
        versionstamp: "001",
        mutations: [
          {
            op: "update",
            schema: ephemeralStoreSchema.name,
            table: "events",
            externalId: "event-a",
            set: { value: "updated" },
            versionstamp: "001",
          },
          {
            op: "delete",
            schema: ephemeralStoreSchema.name,
            table: "events",
            externalId: "event-a",
            versionstamp: "001",
          },
        ],
      }),
    ]);
    await runtime.syncOnce();

    assert(reduceCount === 0);
    assert(notificationCount === 0);
    unlisten();
    unsubscribe();
    cleanStores(store);
  });

  it("applies multiple ephemeral overlays in declaration order", async () => {
    const { runtime, enqueue } = await createEphemeralStoreRuntime({
      durableMutations: [snapshotCreate()],
    });
    const store = runtime
      .store()
      .retrieve(retrieveSnapshot)
      .transformRetrieve(() => ({ values: ["durable"] as string[] }))
      .withEphemeral(ephemeralStoreSchema, "events", {
        initialState: () => [] as string[],
        reduce: (values, item) => [...values, `event:${item.value}`],
        overlay: (data, values) => ({ values: [...data.values, ...values] }),
      })
      .withEphemeral(ephemeralStoreSchema, "alerts", {
        initialState: () => [] as string[],
        reduce: (values, item) => [...values, `alert:${item.value}`],
        overlay: (data, values) => ({ values: [...data.values, ...values] }),
      })
      .withInitialData({ values: [] as string[] });
    const unsubscribe = store.subscribe(() => undefined);
    await storeStateMatching(store, ({ synced }) => synced);
    runtime.stop();

    enqueue([
      createOutboxEntry({
        versionstamp: "001",
        mutations: [
          ephemeralCreate("alerts", "alert-a", "A", "001"),
          ephemeralCreate("events", "event-a", "E", "001"),
        ],
      }),
    ]);
    const overlaidState = storeStateMatching(store, ({ data }) => data.values.length === 3);
    await runtime.syncOnce();
    await overlaidState;

    expect(store.get().data.values).toEqual(["durable", "event:E", "alert:A"]);
    unsubscribe();
    cleanStores(store);
  });

  it("subscribes and unsubscribes ephemeral streams with the store lifecycle", async () => {
    const { runtime } = await createEphemeralStoreRuntime({
      durableMutations: [snapshotCreate()],
    });
    const subscribeEphemeral = runtime.subscribeEphemeral.bind(runtime);
    let subscriptionCount = 0;
    let unsubscriptionCount = 0;
    const trackedSubscribeEphemeral: LofiRuntime["subscribeEphemeral"] = (
      schema,
      table,
      listener,
    ) => {
      subscriptionCount += 1;
      const unsubscribe = subscribeEphemeral(schema, table, listener);
      return () => {
        unsubscriptionCount += 1;
        unsubscribe();
      };
    };
    runtime.subscribeEphemeral = trackedSubscribeEphemeral;
    const store = runtime
      .store()
      .retrieve(retrieveSnapshot)
      .transformRetrieve(({ snapshot }) => ({ snapshot, values: [] as string[] }))
      .withEphemeral(ephemeralStoreSchema, "events", {
        initialState: () => [] as string[],
        reduce: (values, item) => [...values, item.value],
        overlay: (data, values) => ({ ...data, values }),
      })
      .withInitialData({ snapshot: null, values: [] as string[] });

    const unsubscribeFirstMount = store.subscribe(() => undefined);
    await storeStateMatching(store, ({ synced }) => synced);
    expect(subscriptionCount).toBe(1);
    unsubscribeFirstMount();
    cleanStores(store);
    expect(unsubscriptionCount).toBe(1);

    const unsubscribeSecondMount = store.subscribe(() => undefined);
    expect(subscriptionCount).toBe(2);
    unsubscribeSecondMount();
    cleanStores(store);
    expect(unsubscriptionCount).toBe(2);
  });

  // Ephemeral accumulator state survives an unmount, while subscribing again replays every active
  // mutation. Remounting the same store must not fold those replayed mutations into state twice.
  it("does not reduce an active stream twice when the same store remounts", async () => {
    const { runtime } = await createEphemeralStoreRuntime({
      durableMutations: [snapshotCreate()],
      initialEntries: [
        createOutboxEntry({
          versionstamp: "001",
          mutations: [ephemeralCreate("events", "event-start", "start", "001")],
        }),
        createOutboxEntry({
          versionstamp: "002",
          mutations: [ephemeralCreate("events", "event-item", "item", "002")],
        }),
      ],
    });
    const store = runtime
      .store()
      .retrieve(retrieveSnapshot)
      .transformRetrieve(({ snapshot }) => ({ snapshot, values: [] as string[] }))
      .withEphemeral(ephemeralStoreSchema, "events", {
        initialState: () => [] as string[],
        reduce: (values, item) => [...values, item.value],
        overlay: (data, values) => ({ ...data, values }),
      })
      .withInitialData({ snapshot: null, values: [] as string[] });

    const unsubscribeFirstMount = store.subscribe(() => undefined);
    await storeStateMatching(store, ({ loading, synced }) => !loading && synced);
    expect(store.get().data.values).toEqual(["start", "item"]);
    unsubscribeFirstMount();
    cleanStores(store);

    const unsubscribeSecondMount = store.subscribe(() => undefined);
    await storeStateMatching(store, ({ loading, synced }) => !loading && synced);

    expect(store.get().data.values).toEqual(["start", "item"]);
    unsubscribeSecondMount();
    cleanStores(store);
  });

  it("preserves ephemeral items received during a durable refresh", async () => {
    const { adapter, runtime, enqueue } = await createEphemeralStoreRuntime({
      durableMutations: [snapshotCreate()],
    });
    let transformCount = 0;
    let startSecondTransform: () => void = () => undefined;
    const secondTransformStarted = new Promise<void>((resolve) => {
      startSecondTransform = resolve;
    });
    let finishSecondTransform: () => void = () => undefined;
    const secondTransformCanFinish = new Promise<void>((resolve) => {
      finishSecondTransform = resolve;
    });
    const store = runtime
      .store()
      .retrieve(retrieveSnapshot)
      .transformRetrieve(async ({ snapshot }) => {
        transformCount += 1;
        if (transformCount === 2) {
          startSecondTransform();
          await secondTransformCanFinish;
        }
        return {
          committedCount: snapshot?.committedCount ?? 0,
          values: [] as string[],
        };
      })
      .withEphemeral(ephemeralStoreSchema, "events", {
        initialState: () => [] as string[],
        reduce: (values, item) => [...values, item.value],
        overlay: (data, values) => ({ ...data, values }),
      })
      .withInitialData({ committedCount: 0, values: [] as string[] });
    const unsubscribe = store.subscribe(() => undefined);
    await storeStateMatching(store, ({ synced }) => synced);
    runtime.stop();

    await adapter.applyMutations([snapshotUpdate(1, "direct-update")]);
    runtime.refresh();
    await secondTransformStarted;

    enqueue([
      createOutboxEntry({
        versionstamp: "001",
        mutations: [ephemeralCreate("events", "event-a", "during-refresh", "001")],
      }),
    ]);
    const liveState = storeStateMatching(
      store,
      ({ data, loading }) => loading && data.values.includes("during-refresh"),
    );
    await runtime.syncOnce();
    await liveState;

    finishSecondTransform();
    const settledState = await storeStateMatching(
      store,
      ({ data, loading }) =>
        !loading && data.committedCount === 1 && data.values.includes("during-refresh"),
    );

    expect(settledState.data).toEqual({ committedCount: 1, values: ["during-refresh"] });
    unsubscribe();
    cleanStores(store);
  });
});
