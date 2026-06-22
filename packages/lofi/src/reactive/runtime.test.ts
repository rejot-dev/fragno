import { describe, expect, it, vi, assert } from "vitest";

import { InMemoryLofiAdapter } from "../adapters/in-memory/adapter";
import { createLofiRuntime } from "./runtime";
import { createOutboxEntry, createUserMutation, reactiveTestSchema, waitFor } from "./test-utils";

const createJsonFetcher = (entriesByUrl: Record<string, unknown[]>): typeof fetch =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    return new Response(JSON.stringify(entriesByUrl[url.origin + url.pathname] ?? []), {
      status: 200,
    });
  }) as unknown as typeof fetch;

describe("createLofiRuntime", () => {
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
