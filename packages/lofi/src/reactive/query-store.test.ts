import { describe, expect, expectTypeOf, it, assert } from "vitest";

import { InMemoryLofiAdapter } from "../adapters/in-memory/adapter";
import { createLofiQueryStore } from "./query-store";
import { createLofiRuntime } from "./runtime";
import { createOutboxEntry, createUserMutation, reactiveTestSchema, waitFor } from "./test-utils";

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
