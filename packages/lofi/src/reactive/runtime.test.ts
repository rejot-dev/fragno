import { describe, expect, expectTypeOf, it, vi, assert } from "vitest";

import { column, idColumn, schema } from "@fragno-dev/db/schema";

import { InMemoryLofiAdapter } from "../adapters/in-memory/adapter";
import { isLofiRuntimeBootstrapped, createLofiRuntime } from "./runtime";
import { createOutboxEntry, createUserMutation, reactiveTestSchema, waitFor } from "./test-utils";

const createJsonFetcher = (entriesByUrl: Record<string, unknown[]>): typeof fetch =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    return new Response(JSON.stringify(entriesByUrl[url.origin + url.pathname] ?? []), {
      status: 200,
    });
  }) as unknown as typeof fetch;

describe("createLofiRuntime", () => {
  it("delivers ephemeral mutations without storing rows or refreshing queries", async () => {
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [reactiveTestSchema],
    });
    const runtime = createLofiRuntime({
      endpointName: "app",
      adapter,
      sources: [{ id: "org-a", outboxUrl: "https://example.com/org-a/outbox" }],
      ephemeralTables: [{ schema: reactiveTestSchema.name, table: "users" }],
      fetch: createJsonFetcher({
        "https://example.com/org-a/outbox": [
          createOutboxEntry({
            versionstamp: "001",
            mutations: [createUserMutation("user-a", "Alice", "001")],
          }),
        ],
      }),
    });
    const mutations: unknown[] = [];
    const unsubscribe = runtime.subscribeEphemeral(reactiveTestSchema, "users", (mutation) => {
      mutations.push(mutation);
    });

    const result = await runtime.syncOnce("org-a");

    expect(mutations).toEqual([
      expect.objectContaining({ schema: reactiveTestSchema.name, table: "users" }),
    ]);
    assert(result.appliedEntries === 1);
    assert(runtime.$revision.get() === 0);
    expect(
      await adapter
        .createQueryEngine(reactiveTestSchema)
        .find("users", (builder) => builder.whereIndex("primary")),
    ).toEqual([]);
    unsubscribe();
  });

  it("replays active ephemeral streams when a listener subscribes late", async () => {
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [reactiveTestSchema],
    });
    const responses = [
      [
        createOutboxEntry({
          versionstamp: "001",
          mutations: [createUserMutation("start", "start", "001")],
        }),
        createOutboxEntry({
          versionstamp: "002",
          mutations: [createUserMutation("item", "item", "002")],
        }),
      ],
    ];
    const runtime = createLofiRuntime({
      endpointName: "app",
      adapter,
      sources: [{ id: "org-a", outboxUrl: "https://example.com/org-a/outbox" }],
      ephemeralTables: [
        {
          schema: reactiveTestSchema.name,
          table: "users",
          stream: {
            key: () => "operation-a",
            boundary: (values) =>
              values["name"] === "start" ? "start" : values["name"] === "end" ? "end" : "item",
          },
        },
      ],
      fetch: (async () => new Response(JSON.stringify(responses.shift() ?? []))) as typeof fetch,
    });

    await runtime.syncOnce("org-a");

    const names: string[] = [];
    const unsubscribe = runtime.subscribeEphemeral(reactiveTestSchema, "users", (mutation) => {
      if (mutation.op === "create") {
        names.push(mutation.values.name);
      }
    });

    expect(names).toEqual(["start", "item"]);
    unsubscribe();
  });

  it("delivers only active recoverable streams after bootstrap catch-up", async () => {
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [reactiveTestSchema],
    });
    const responses = [
      [
        createOutboxEntry({
          versionstamp: "001",
          mutations: [createUserMutation("old-start", "start", "001")],
        }),
        createOutboxEntry({
          versionstamp: "002",
          mutations: [createUserMutation("old-item", "historical", "002")],
        }),
        createOutboxEntry({
          versionstamp: "003",
          mutations: [createUserMutation("old-end", "end", "003")],
        }),
        createOutboxEntry({
          versionstamp: "004",
          mutations: [createUserMutation("active-start", "start", "004")],
        }),
        createOutboxEntry({
          versionstamp: "005",
          mutations: [createUserMutation("active-item", "delta", "005")],
        }),
      ],
    ];
    const runtime = createLofiRuntime({
      endpointName: "app",
      adapter,
      sources: [{ id: "org-a", outboxUrl: "https://example.com/org-a/outbox" }],
      ephemeralTables: [
        {
          schema: reactiveTestSchema.name,
          table: "users",
          stream: {
            key: () => "operation",
            boundary: (values) =>
              values["name"] === "start" ? "start" : values["name"] === "end" ? "end" : "item",
          },
        },
      ],
      fetch: (async () => new Response(JSON.stringify(responses.shift() ?? []))) as typeof fetch,
    });
    const names: string[] = [];
    const unsubscribe = runtime.subscribeEphemeral(reactiveTestSchema, "users", (mutation) => {
      if (mutation.op === "create") {
        names.push(mutation.values.name);
      }
    });

    await runtime.whenBootstrapped();

    expect(names).toEqual(["start", "delta"]);
    unsubscribe();
  });

  it("syncs a source and increments the revision when entries are applied", async () => {
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [reactiveTestSchema],
    });
    const fetcher = createJsonFetcher({
      "https://example.com/org-a/outbox": [
        createOutboxEntry({
          versionstamp: "001",
          mutations: [createUserMutation("user-a", "Alice", "001")],
        }),
      ],
    });
    const runtime = createLofiRuntime({
      endpointName: "app",
      adapter,
      sources: [{ id: "org-a", outboxUrl: "https://example.com/org-a/outbox" }],
      fetch: fetcher,
    });

    const revisions: number[] = [];
    const unlisten = runtime.$revision.subscribe((revision) => revisions.push(revision));

    const result = await runtime.syncOnce("org-a");

    assert(result.appliedEntries === 1);
    assert(runtime.$revision.get() === 1);
    expect(revisions).toEqual([0, 1]);
    assert(runtime.$status.get().sources["org-a"]?.lastVersionstamp === "001");

    const query = adapter.createQueryEngine(reactiveTestSchema);
    const users = await query.find("users", (b) => b.whereIndex("primary"));
    expect(users).toEqual([expect.objectContaining({ name: "Alice" })]);

    unlisten();
  });

  it("runs typed local tx retrieves across schemas", async () => {
    const projectSchema = schema("projects", (s) =>
      s.addTable("projects", (t) =>
        t.addColumn("id", idColumn()).addColumn("title", column("string")),
      ),
    );
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [reactiveTestSchema, projectSchema],
    });
    await adapter.applyMutations([
      createUserMutation("user-a", "Alice"),
      {
        op: "create",
        schema: projectSchema.name,
        table: "projects",
        externalId: "project-a",
        values: { title: "Launch" },
        versionstamp: "v-project-a",
      },
    ]);
    const runtime = createLofiRuntime({
      endpointName: "app",
      adapter,
      outboxUrl: "https://example.com/outbox",
      fetch: (async () => new Response(JSON.stringify([]))) as typeof fetch,
    });

    const result = await runtime
      .tx()
      .retrieve(({ forSchema }) => ({
        users: forSchema(reactiveTestSchema).find("users", (b) => b.whereIndex("primary")),
        project: forSchema(projectSchema).findFirst("projects", (b) => b.whereIndex("primary")),
      }))
      .execute();

    expectTypeOf(result.users[0]!.name).toEqualTypeOf<string>();
    expectTypeOf(result.project?.title).toEqualTypeOf<string | undefined>();
    expect(result.users.map((user) => user.name)).toEqual(["Alice"]);
    assert(result.project?.title === "Launch");

    const $summary = runtime
      .store()
      .retrieve(({ forSchema }) => ({
        users: forSchema(reactiveTestSchema).find("users", (b) => b.whereIndex("primary")),
        project: forSchema(projectSchema).findFirst("projects", (b) => b.whereIndex("primary")),
      }))
      .transformRetrieve(({ users, project }) => ({
        names: users.map((user) => user.name),
        projectTitle: project?.title ?? null,
      }))
      .withInitialData({ names: [] as string[], projectTitle: null as string | null });
    expectTypeOf($summary.get().data).toEqualTypeOf<{
      names: string[];
      projectTitle: string | null;
    }>();
    const unlisten = $summary.subscribe(() => undefined);
    await waitFor(() => $summary.get().synced);
    expect($summary.get().data).toEqual({ names: ["Alice"], projectTitle: "Launch" });
    unlisten();
  });

  it("overlays ephemeral creates onto a runtime store without refreshing its retrieval", async () => {
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [reactiveTestSchema],
    });
    let nextEntries: unknown[] = [];
    const runtime = createLofiRuntime({
      endpointName: "app",
      adapter,
      outboxUrl: "https://example.com/outbox",
      ephemeralTables: [{ schema: reactiveTestSchema.name, table: "users" }],
      fetch: (async () => {
        const entries = nextEntries;
        nextEntries = [];
        return new Response(JSON.stringify(entries));
      }) as typeof fetch,
    });
    let retrieveCount = 0;
    let reconcileCount = 0;
    const store = runtime
      .store()
      .retrieve(({ forSchema }) => ({
        users: forSchema(reactiveTestSchema).find("users", (builder) =>
          builder.whereIndex("primary"),
        ),
      }))
      .transformRetrieve(({ users }) => {
        retrieveCount += 1;
        return { names: users.map((user) => user.name) };
      })
      .withEphemeral(reactiveTestSchema, "users", {
        initialState: () => [] as string[],
        reduce: (names, item, { retrieved, durableData }) => {
          expectTypeOf(item.name).toEqualTypeOf<string>();
          const retrievedName: string | undefined = retrieved.users[0]?.name;
          expect(retrievedName).toBeUndefined();
          expectTypeOf(durableData.names).toEqualTypeOf<string[]>();
          return [...names, item.name];
        },
        reconcile: (names) => {
          reconcileCount += 1;
          return names;
        },
        overlay: (durableData, names) => ({
          names: [...durableData.names, ...names],
        }),
      })
      .withInitialData({ names: [] as string[] });
    const unsubscribe = store.subscribe(() => undefined);
    await waitFor(() => store.get().synced);
    runtime.stop();

    const ephemeralUpdate = new Promise<void>((resolve) => {
      const unlisten = store.listen((state) => {
        if (state.data.names.includes("Alice")) {
          unlisten();
          resolve();
        }
      });
    });
    nextEntries = [
      createOutboxEntry({
        versionstamp: "001",
        mutations: [createUserMutation("user-a", "Alice", "001")],
      }),
    ];
    await runtime.syncOnce();
    await ephemeralUpdate;

    expect(store.get().data).toEqual({ names: ["Alice"] });
    assert(retrieveCount === 1);
    assert(reconcileCount === 1);
    assert(runtime.$revision.get() === 0);
    unsubscribe();
  });

  it("clears source errors after an empty successful background sync", async () => {
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [reactiveTestSchema],
    });
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("temporary outbox failure");
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const runtime = createLofiRuntime({
      endpointName: "app",
      adapter,
      sources: [{ id: "org-a", outboxUrl: "https://example.com/org-a/outbox" }],
      fetch: fetcher as unknown as typeof fetch,
      pollIntervalMs: 5,
      bootstrap: false,
    });

    runtime.start();
    await waitFor(() => Boolean(runtime.$status.get().sources["org-a"]?.lastError));

    runtime.stop();
    runtime.start();
    await waitFor(() => runtime.$status.get().sources["org-a"]?.lastError === undefined);

    assert(runtime.$status.get().lastError === undefined);
    assert(runtime.$status.get().sources["org-a"]?.lastSyncAt !== undefined);
    runtime.stop();
  });

  it("keeps bootstrap status while the initial sync is in flight", async () => {
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [reactiveTestSchema],
    });
    let resolveBootstrap: (response: Response) => void = () => undefined;
    const bootstrapResponse = new Promise<Response>((resolve) => {
      resolveBootstrap = resolve;
    });
    const runtime = createLofiRuntime({
      endpointName: "app",
      adapter,
      sources: [{ id: "org-a", outboxUrl: "https://example.com/org-a/outbox" }],
      fetch: (async () => bootstrapResponse) as typeof fetch,
    });

    const bootstrapPromise = runtime.bootstrap();
    await waitFor(() => runtime.$status.get().status === "bootstrapping");
    assert(runtime.$status.get().sources["org-a"]?.status === "bootstrapping");

    resolveBootstrap(new Response(JSON.stringify([]), { status: 200 }));
    await bootstrapPromise;
    assert(runtime.$status.get().sources["org-a"]?.status === "bootstrapped");
  });

  it("skips bootstrap fetch when the persisted bootstrap marker is complete", async () => {
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [reactiveTestSchema],
    });
    await adapter.setMeta("app:org-a:outbox", "001");
    await adapter.setMeta("app:org-a:outbox::bootstrap", "complete");
    const fetcher = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const runtime = createLofiRuntime({
      endpointName: "app",
      adapter,
      sources: [{ id: "org-a", outboxUrl: "https://example.com/org-a/outbox" }],
      fetch: fetcher as unknown as typeof fetch,
    });

    const result = await runtime.bootstrap();

    assert(result.sources["org-a"]?.lastVersionstamp === "001");
    assert(isLofiRuntimeBootstrapped(runtime.$status.get()));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rebuilds recoverable streams even when the persisted bootstrap marker is complete", async () => {
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [reactiveTestSchema],
    });
    await adapter.setMeta("app:org-a:outbox", "000");
    await adapter.setMeta("app:org-a:outbox::bootstrap", "complete");
    const responses = [
      [
        createOutboxEntry({
          versionstamp: "001",
          mutations: [createUserMutation("old-start", "start", "001")],
        }),
        createOutboxEntry({
          versionstamp: "002",
          mutations: [createUserMutation("old-end", "end", "002")],
        }),
        createOutboxEntry({
          versionstamp: "003",
          mutations: [createUserMutation("active-start", "start", "003")],
        }),
        createOutboxEntry({
          versionstamp: "004",
          mutations: [createUserMutation("active-item", "delta", "004")],
        }),
      ],
    ];
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(responses.shift() ?? []), { status: 200 }),
    );
    const runtime = createLofiRuntime({
      endpointName: "app",
      adapter,
      sources: [{ id: "org-a", outboxUrl: "https://example.com/org-a/outbox" }],
      ephemeralTables: [
        {
          schema: reactiveTestSchema.name,
          table: "users",
          stream: {
            key: () => "operation",
            boundary: (values) =>
              values["name"] === "start" ? "start" : values["name"] === "end" ? "end" : "item",
          },
        },
      ],
      fetch: fetcher as unknown as typeof fetch,
    });

    await runtime.bootstrap();

    const names: string[] = [];
    const unsubscribe = runtime.subscribeEphemeral(reactiveTestSchema, "users", (mutation) => {
      if (mutation.op === "create") {
        names.push(mutation.values.name);
      }
    });
    expect(names).toEqual(["start", "delta"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  // Adding a source bootstraps all source IDs. Recoverable streams bypass the completed-marker
  // shortcut, so an existing live stream must not be finite-synced concurrently a second time.
  it("does not bootstrap an already-live stream source when adding another source", async () => {
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [reactiveTestSchema],
    });
    let orgAFiniteRequests = 0;
    let orgAStreamRequests = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/org-a/outbox/stream") {
        orgAStreamRequests += 1;
        return new Response(
          new ReadableStream({
            start(controller) {
              const signal = init?.signal;
              if (signal?.aborted) {
                controller.close();
                return;
              }
              signal?.addEventListener("abort", () => controller.close(), { once: true });
            },
          }),
        );
      }
      if (url.pathname === "/org-a/outbox") {
        orgAFiniteRequests += 1;
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;
    const runtime = createLofiRuntime({
      endpointName: "app",
      adapter,
      sources: [
        {
          id: "org-a",
          outboxUrl: "https://example.com/org-a/outbox",
          outboxTransport: "stream",
        },
      ],
      ephemeralTables: [
        {
          schema: reactiveTestSchema.name,
          table: "users",
          stream: {
            key: () => "operation",
            boundary: () => "item",
          },
        },
      ],
      fetch: fetcher,
      streamReconnectIntervalMs: 10_000,
    });

    runtime.start();
    try {
      await runtime.whenBootstrapped();
      await waitFor(() => orgAStreamRequests === 1);
      expect(orgAFiniteRequests).toBe(1);

      runtime.addSource({
        id: "org-b",
        outboxUrl: "https://example.com/org-b/outbox",
        outboxTransport: "poll",
        pollIntervalMs: 10_000,
      });
      await waitFor(() => runtime.$status.get().sources["org-b"]?.status === "bootstrapped");

      expect(orgAFiniteRequests).toBe(1);
    } finally {
      runtime.stop();
    }
  });

  it("uses independent cursor keys for multiple sources", async () => {
    const adapter = new InMemoryLofiAdapter({
      endpointName: "app",
      schemas: [reactiveTestSchema],
    });
    const fetcher = createJsonFetcher({
      "https://example.com/org-a/outbox": [
        createOutboxEntry({
          versionstamp: "001-a",
          mutations: [createUserMutation("user-a", "Alice", "001-a")],
        }),
      ],
      "https://example.com/org-b/outbox": [
        createOutboxEntry({
          versionstamp: "001-b",
          mutations: [createUserMutation("user-b", "Bob", "001-b")],
        }),
      ],
    });
    const runtime = createLofiRuntime({
      endpointName: "app",
      adapter,
      sources: [
        { id: "org-a", outboxUrl: "https://example.com/org-a/outbox" },
        { id: "org-b", outboxUrl: "https://example.com/org-b/outbox" },
      ],
      fetch: fetcher,
    });

    const result = await runtime.syncOnce();

    assert(result.appliedEntries === 2);
    assert((await adapter.getMeta("app:org-a:outbox")) === "001-a");
    assert((await adapter.getMeta("app:org-b:outbox")) === "001-b");
    assert(runtime.$revision.get() === 2);
  });
});
