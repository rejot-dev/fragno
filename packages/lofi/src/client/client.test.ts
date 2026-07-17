import { describe, expect, it, vi, assert } from "vitest";

import { FragnoId } from "@fragno-dev/db/schema";
import superjson from "superjson";

import type { OutboxEntry, OutboxPayload } from "@fragno-dev/db";

import { LofiClient } from "../mod";

const baseOutboxUrl = "https://example.com/outbox?foo=bar";

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

const makePayload = (externalId: string): OutboxPayload => ({
  version: 1,
  mutations: [
    {
      op: "create",
      schema: "app",
      table: "users",
      externalId,
      versionstamp: `mutation-${externalId}`,
      values: { name: externalId },
    },
  ],
});

const makeEntryFromPayload = (
  versionstamp: string,
  externalId: string,
  payload: OutboxPayload,
): OutboxEntry => ({
  id: FragnoId.fromExternal(`outbox-${externalId}`, 0),
  versionstamp,
  uowId: `uow-${versionstamp}`,
  payload: superjson.serialize(payload),
  createdAt: new Date(),
});

const makeEntry = (versionstamp: string, externalId: string): OutboxEntry =>
  makeEntryFromPayload(versionstamp, externalId, makePayload(externalId));

const makeEphemeralStreamEntry = (
  versionstamp: string,
  streamId: string,
  boundary: "start" | "item" | "end",
): OutboxEntry =>
  makeEntryFromPayload(versionstamp, `${streamId}-${boundary}`, {
    version: 1,
    mutations: [
      {
        op: "create",
        schema: "app",
        table: "events",
        externalId: `${streamId}-${versionstamp}`,
        versionstamp: `mutation-${versionstamp}`,
        values: { streamId, boundary },
      },
    ],
  });

const ephemeralStreamTable = {
  schema: "app",
  table: "events",
  stream: {
    key: (values: Record<string, unknown>) => String(values["streamId"]),
    boundary: (values: Record<string, unknown>) => values["boundary"] as "start" | "item" | "end",
  },
} as const;

describe("LofiClient", () => {
  it("delivers ephemeral table mutations without storing them", async () => {
    const entry = makeEntryFromPayload("vs-1", "mixed", {
      version: 1,
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "mutation-user-1",
          values: { name: "Alice" },
        },
        {
          op: "create",
          schema: "app",
          table: "events",
          externalId: "event-1",
          versionstamp: "mutation-event-1",
          values: { type: "typing" },
        },
      ],
    });
    const appliedMutations: unknown[] = [];
    const ephemeralMutations: unknown[] = [];
    const meta = new Map<string, string>();
    const client = new LofiClient({
      outboxUrl: baseOutboxUrl,
      endpointName: "app-outbox",
      adapter: {
        applyOutboxEntry: async ({ mutations }) => {
          appliedMutations.push(...mutations);
          return { applied: true };
        },
        getMeta: async (key) => meta.get(key),
        setMeta: async (key, value) => {
          meta.set(key, value);
        },
      },
      ephemeralTables: [{ schema: "app", table: "events" }],
      fetch: (async () => new Response(JSON.stringify([entry]))) as typeof fetch,
    });
    client.subscribeEphemeral(({ mutations }) => {
      ephemeralMutations.push(...mutations);
    });

    const result = await client.syncOnce();

    expect(appliedMutations).toEqual([
      expect.objectContaining({ schema: "app", table: "users", externalId: "user-1" }),
    ]);
    expect(ephemeralMutations).toEqual([
      expect.objectContaining({ schema: "app", table: "events", externalId: "event-1" }),
    ]);
    expect(result).toEqual({
      appliedEntries: 1,
      appliedDurableMutations: 1,
      lastVersionstamp: "vs-1",
    });
  });

  it("replays an active ephemeral stream to a late subscriber", async () => {
    const responses = [
      [
        makeEphemeralStreamEntry("vs-1", "operation-a", "start"),
        makeEphemeralStreamEntry("vs-2", "operation-a", "item"),
      ],
      [makeEphemeralStreamEntry("vs-3", "operation-a", "end")],
    ];
    const meta = new Map<string, string>();
    const client = new LofiClient({
      outboxUrl: baseOutboxUrl,
      endpointName: "app-outbox",
      adapter: {
        applyOutboxEntry: async () => ({ applied: true }),
        getMeta: async (key) => meta.get(key),
        setMeta: async (key, value) => {
          meta.set(key, value);
        },
      },
      ephemeralTables: [ephemeralStreamTable],
      fetch: (async () => new Response(JSON.stringify(responses.shift() ?? []))) as typeof fetch,
    });

    await client.syncOnce();

    const replayedBoundaries: unknown[] = [];
    client.replayEphemeral(({ mutations }) => {
      replayedBoundaries.push(
        ...mutations.map((mutation) => mutation.op === "create" && mutation.values["boundary"]),
      );
    });

    expect(replayedBoundaries).toEqual(["start", "item"]);
    expect(meta.get("app-outbox::outbox")).toBeUndefined();

    await client.syncOnce();

    const replayedAfterCommit: unknown[] = [];
    client.replayEphemeral(({ mutations }) => replayedAfterCommit.push(...mutations));
    expect(replayedAfterCommit).toEqual([]);
    assert(meta.get("app-outbox::outbox") === "vs-3");
  });

  it("suppresses historical stream delivery while rebuilding active replay buffers", async () => {
    const entries = [
      makeEphemeralStreamEntry("vs-1", "operation-a", "start"),
      makeEphemeralStreamEntry("vs-2", "operation-a", "item"),
      makeEphemeralStreamEntry("vs-3", "operation-a", "end"),
      makeEphemeralStreamEntry("vs-4", "operation-b", "start"),
      makeEphemeralStreamEntry("vs-5", "operation-b", "item"),
    ];
    const delivered: unknown[] = [];
    const client = new LofiClient({
      outboxUrl: baseOutboxUrl,
      endpointName: "app-outbox",
      adapter: {
        applyOutboxEntry: async () => ({ applied: true }),
        getMeta: async () => undefined,
        setMeta: async () => undefined,
      },
      ephemeralTables: [ephemeralStreamTable],
      fetch: (async () => new Response(JSON.stringify(entries))) as typeof fetch,
    });
    client.subscribeEphemeral(({ mutations }) => delivered.push(...mutations));

    await client.syncOnce({ deliverEphemeral: false });

    expect(delivered).toEqual([]);
    const replayed: string[] = [];
    client.replayEphemeral(({ mutations }) => {
      for (const mutation of mutations) {
        if (mutation.op === "create") {
          replayed.push(
            `${String(mutation.values["streamId"])}:${String(mutation.values["boundary"])}`,
          );
        }
      }
    });
    expect(replayed).toEqual(["operation-b:start", "operation-b:item"]);
  });

  it("moves the replay checkpoint between concurrent ephemeral streams", async () => {
    const responses = [
      [
        makeEphemeralStreamEntry("vs-100", "operation-a", "start"),
        makeEphemeralStreamEntry("vs-120", "operation-b", "start"),
      ],
      [makeEphemeralStreamEntry("vs-200", "operation-a", "end")],
      [makeEphemeralStreamEntry("vs-300", "operation-b", "end")],
    ];
    const meta = new Map<string, string>([["app-outbox::outbox", "vs-090"]]);
    const client = new LofiClient({
      outboxUrl: baseOutboxUrl,
      endpointName: "app-outbox",
      adapter: {
        applyOutboxEntry: async () => ({ applied: true }),
        getMeta: async (key) => meta.get(key),
        setMeta: async (key, value) => {
          meta.set(key, value);
        },
      },
      ephemeralTables: [ephemeralStreamTable],
      fetch: (async () => new Response(JSON.stringify(responses.shift() ?? []))) as typeof fetch,
    });

    await client.syncOnce();
    assert(meta.get("app-outbox::outbox") === "vs-090");

    await client.syncOnce();
    assert(meta.get("app-outbox::outbox") === "vs-100");

    await client.syncOnce();
    assert(meta.get("app-outbox::outbox") === "vs-300");
  });

  it("delivers replayed ephemeral mutations when durable mutations were already applied", async () => {
    const entry = makeEntryFromPayload("vs-2", "mixed-replay", {
      version: 1,
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "mutation-user-1",
          values: { name: "Alice" },
        },
        {
          op: "create",
          schema: "app",
          table: "events",
          externalId: "event-1",
          versionstamp: "mutation-event-1",
          values: { streamId: "operation-a", boundary: "item" },
        },
      ],
    });
    const ephemeralMutations: unknown[] = [];
    const client = new LofiClient({
      outboxUrl: baseOutboxUrl,
      endpointName: "app-outbox",
      adapter: {
        applyOutboxEntry: async () => ({ applied: false }),
        getMeta: async () => "vs-1",
        setMeta: async () => undefined,
      },
      ephemeralTables: [ephemeralStreamTable],
      fetch: (async () => new Response(JSON.stringify([entry]))) as typeof fetch,
    });
    client.subscribeEphemeral(({ mutations }) => ephemeralMutations.push(...mutations));

    const result = await client.syncOnce();

    expect(ephemeralMutations).toEqual([
      expect.objectContaining({ schema: "app", table: "events", externalId: "event-1" }),
    ]);
    expect(result).toEqual({
      appliedEntries: 1,
      appliedDurableMutations: 0,
      lastVersionstamp: "vs-2",
    });
  });

  it("retries ephemeral delivery without checkpointing or reapplying durable mutations", async () => {
    const entry = makeEntryFromPayload("vs-1", "mixed-retry", {
      version: 1,
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "mutation-user-1",
          values: { name: "Alice" },
        },
        {
          op: "create",
          schema: "app",
          table: "events",
          externalId: "event-1",
          versionstamp: "mutation-event-1",
          values: { type: "typing" },
        },
      ],
    });
    const meta = new Map<string, string>();
    let durableApplyAttempts = 0;
    let durableWrites = 0;
    let deliveryAttempts = 0;
    let shouldThrow = true;
    const client = new LofiClient({
      outboxUrl: baseOutboxUrl,
      endpointName: "app-outbox",
      adapter: {
        applyOutboxEntry: async () => {
          durableApplyAttempts += 1;
          if (durableApplyAttempts === 1) {
            durableWrites += 1;
            return { applied: true };
          }
          return { applied: false };
        },
        getMeta: async (key) => meta.get(key),
        setMeta: async (key, value) => {
          meta.set(key, value);
        },
      },
      ephemeralTables: [{ schema: "app", table: "events" }],
      fetch: (async () => new Response(JSON.stringify([entry]))) as typeof fetch,
    });
    client.subscribeEphemeral(() => {
      deliveryAttempts += 1;
      if (shouldThrow) {
        throw new Error("projection failed");
      }
    });

    await expect(client.syncOnce()).rejects.toThrow("projection failed");
    expect(meta.get("app-outbox::outbox")).toBeUndefined();
    expect(durableWrites).toBe(1);

    shouldThrow = false;
    await client.syncOnce();

    expect(deliveryAttempts).toBe(2);
    expect(durableApplyAttempts).toBe(2);
    expect(durableWrites).toBe(1);
    assert(meta.get("app-outbox::outbox") === "vs-1");
  });

  // A mixed entry can commit durable rows before an ephemeral listener throws. The retry is
  // inbox-deduplicated, but must still report the earlier durable write so reactive stores refresh.
  it("reports durable mutations after an ephemeral delivery retry", async () => {
    const entry = makeEntryFromPayload("vs-1", "mixed-retry-refresh", {
      version: 1,
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "mutation-user-1",
          values: { name: "Alice" },
        },
        {
          op: "create",
          schema: "app",
          table: "events",
          externalId: "event-1",
          versionstamp: "mutation-event-1",
          values: { type: "typing" },
        },
      ],
    });
    let applyAttempt = 0;
    let shouldThrow = true;
    const completedDurableMutationCounts: Array<number | undefined> = [];
    const client = new LofiClient({
      outboxUrl: baseOutboxUrl,
      endpointName: "app-outbox",
      adapter: {
        applyOutboxEntry: async () => ({ applied: applyAttempt++ === 0 }),
        getMeta: async () => undefined,
        setMeta: async () => undefined,
      },
      ephemeralTables: [{ schema: "app", table: "events" }],
      fetch: (async () => new Response(JSON.stringify([entry]))) as typeof fetch,
      onSyncComplete: (result) => {
        completedDurableMutationCounts.push(result.appliedDurableMutations);
      },
    });
    client.subscribeEphemeral(() => {
      if (shouldThrow) {
        throw new Error("projection failed");
      }
    });

    await expect(client.syncOnce()).rejects.toThrow("projection failed");
    shouldThrow = false;
    await client.syncOnce();

    expect(completedDurableMutationCounts).toEqual([1]);
  });

  it("does not duplicate active stream buffers after a failed delivery retry", async () => {
    const entries = {
      start: makeEphemeralStreamEntry("vs-1", "operation-a", "start"),
      item: makeEphemeralStreamEntry("vs-2", "operation-a", "item"),
    };
    let shouldThrow = true;
    const meta = new Map<string, string>();
    const client = new LofiClient({
      outboxUrl: baseOutboxUrl,
      endpointName: "app-outbox",
      adapter: {
        applyOutboxEntry: async () => ({ applied: true }),
        getMeta: async (key) => meta.get(key),
        setMeta: async (key, value) => {
          meta.set(key, value);
        },
      },
      ephemeralTables: [ephemeralStreamTable],
      fetch: (async (input) => {
        const url = new URL(typeof input === "string" ? input : input.toString());
        return new Response(
          JSON.stringify(
            url.searchParams.get("afterVersionstamp") === "vs-1" ? [entries.item] : [entries.start],
          ),
        );
      }) as typeof fetch,
    });
    client.subscribeEphemeral(({ mutations }) => {
      const boundary = mutations[0]?.op === "create" && mutations[0].values["boundary"];
      if (boundary === "item" && shouldThrow) {
        throw new Error("projection failed");
      }
    });

    await client.syncOnce();
    await expect(client.syncOnce()).rejects.toThrow("projection failed");
    shouldThrow = false;
    await client.syncOnce();

    const replayed: string[] = [];
    client.replayEphemeral(({ mutations }) => {
      for (const mutation of mutations) {
        if (mutation.op === "create") {
          replayed.push(String(mutation.values["boundary"]));
        }
      }
    });
    expect(replayed).toEqual(["start", "item"]);
  });

  // Stream bookkeeping currently happens before the replay checkpoint is persisted. If that I/O
  // fails, retrying the same entry must not append the buffered mutation a second time.
  it("does not duplicate active stream buffers after checkpoint persistence fails", async () => {
    const start = makeEphemeralStreamEntry("vs-1", "operation-a", "start");
    const item = makeEphemeralStreamEntry("vs-2", "operation-a", "item");
    let checkpointAttempts = 0;
    let failItemCheckpoint = true;
    const client = new LofiClient({
      outboxUrl: baseOutboxUrl,
      endpointName: "app-outbox",
      adapter: {
        applyOutboxEntry: async () => ({ applied: true }),
        getMeta: async () => "vs-0",
        setMeta: async () => {
          checkpointAttempts += 1;
          if (checkpointAttempts > 1 && failItemCheckpoint) {
            failItemCheckpoint = false;
            throw new Error("checkpoint failed");
          }
        },
      },
      ephemeralTables: [ephemeralStreamTable],
      fetch: (async (input) => {
        const url = new URL(typeof input === "string" ? input : input.toString());
        return new Response(
          JSON.stringify(url.searchParams.get("afterVersionstamp") === "vs-0" ? [start] : [item]),
        );
      }) as typeof fetch,
    });

    await client.syncOnce();
    await expect(client.syncOnce()).rejects.toThrow("checkpoint failed");
    await client.syncOnce();

    const replayed: string[] = [];
    client.replayEphemeral(({ mutations }) => {
      for (const mutation of mutations) {
        if (mutation.op === "create") {
          replayed.push(String(mutation.values["boundary"]));
        }
      }
    });
    expect(replayed).toEqual(["start", "item"]);
  });

  it("rejects outbox mutations containing unresolved DbNow values", async () => {
    const entry = makeEntryFromPayload("vs-1", "event-1", {
      version: 1,
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "events",
          externalId: "event-1",
          versionstamp: "mutation-event-1",
          values: { createdAt: { tag: "db-now" } },
        },
      ],
    });
    const applyOutboxEntry = vi.fn(async () => ({ applied: true }));
    const setMeta = vi.fn(async () => undefined);
    const client = new LofiClient({
      outboxUrl: baseOutboxUrl,
      endpointName: "app-outbox",
      adapter: {
        applyOutboxEntry,
        getMeta: async () => undefined,
        setMeta,
      },
      ephemeralTables: [{ schema: "app", table: "events" }],
      fetch: (async () => new Response(JSON.stringify([entry]))) as typeof fetch,
    });

    await expect(client.syncOnce()).rejects.toThrow(
      "Outbox mutation app.events.createdAt contains unresolved DbNow.",
    );
    expect(applyOutboxEntry).not.toHaveBeenCalled();
    expect(setMeta).not.toHaveBeenCalled();
  });

  it("does not open an adapter mutation transaction for ephemeral-only entries", async () => {
    const entry = makeEntryFromPayload("vs-1", "event-1", {
      version: 1,
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "events",
          externalId: "event-1",
          versionstamp: "mutation-event-1",
          values: { type: "typing" },
        },
      ],
    });
    const applyOutboxEntry = vi.fn(async () => ({ applied: true }));
    const client = new LofiClient({
      outboxUrl: baseOutboxUrl,
      endpointName: "app-outbox",
      adapter: {
        applyOutboxEntry,
        getMeta: async () => undefined,
        setMeta: async () => undefined,
      },
      ephemeralTables: [{ schema: "app", table: "events" }],
      fetch: (async () => new Response(JSON.stringify([entry]))) as typeof fetch,
    });

    await client.syncOnce();

    expect(applyOutboxEntry).not.toHaveBeenCalled();
  });

  it("drains pages and advances the cursor", async () => {
    const entries = [
      makeEntry("vs-1", "user-1"),
      makeEntry("vs-2", "user-2"),
      makeEntry("vs-3", "user-3"),
    ];

    const requests: Array<{ after: string | null; limit: string | null; foo: string | null }> = [];

    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      requests.push({
        after: url.searchParams.get("afterVersionstamp"),
        limit: url.searchParams.get("limit"),
        foo: url.searchParams.get("foo"),
      });

      const after = url.searchParams.get("afterVersionstamp");
      if (!after) {
        return new Response(JSON.stringify(entries.slice(0, 2)), { status: 200 });
      }
      if (after === "vs-2") {
        return new Response(JSON.stringify(entries.slice(2)), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const meta = new Map<string, string>();
    const applied: Array<{ sourceKey: string; versionstamp: string; uowId: string }> = [];

    const client = new LofiClient({
      outboxUrl: baseOutboxUrl,
      endpointName: "app-outbox",
      adapter: {
        applyOutboxEntry: async ({ sourceKey, versionstamp, uowId }) => {
          applied.push({ sourceKey, versionstamp, uowId });
          return { applied: true };
        },
        getMeta: async (key) => meta.get(key),
        setMeta: async (key, value) => {
          meta.set(key, value);
        },
      },
      fetch: fetcher as unknown as typeof fetch,
      limit: 2,
    });

    const result = await client.syncOnce();

    expect(result).toEqual({ appliedEntries: 3, lastVersionstamp: "vs-3" });
    assert(meta.get("app-outbox::outbox") === "vs-3");
    expect(applied).toEqual([
      { sourceKey: "app-outbox::outbox", versionstamp: "vs-1", uowId: "uow-vs-1" },
      { sourceKey: "app-outbox::outbox", versionstamp: "vs-2", uowId: "uow-vs-2" },
      { sourceKey: "app-outbox::outbox", versionstamp: "vs-3", uowId: "uow-vs-3" },
    ]);
    expect(requests).toEqual([
      { after: null, limit: "2", foo: "bar" },
      { after: "vs-2", limit: "2", foo: "bar" },
    ]);
  });

  it("streams entries from the outbox stream route", async () => {
    const entries = [makeEntry("vs-1", "user-1"), makeEntry("vs-2", "user-2")];
    const encoder = new TextEncoder();
    const requests: Array<{ pathname: string; after: string | null; limit: string | null }> = [];
    const applied: Array<{ sourceKey: string; versionstamp: string; uowId: string }> = [];
    const completed: Array<{ appliedEntries: number; lastVersionstamp?: string }> = [];
    const meta = new Map<string, string>();

    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      requests.push({
        pathname: url.pathname,
        after: url.searchParams.get("afterVersionstamp"),
        limit: url.searchParams.get("limit"),
      });

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const entry of entries) {
              controller.enqueue(encoder.encode(`${JSON.stringify(entry)}\n`));
            }
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "application/x-ndjson" } },
      );
    });

    const client = new LofiClient({
      outboxUrl: "https://example.com/_internal/outbox?foo=bar",
      endpointName: "app-outbox",
      outboxTransport: "stream",
      adapter: {
        applyOutboxEntry: async ({ sourceKey, versionstamp, uowId }) => {
          applied.push({ sourceKey, versionstamp, uowId });
          return { applied: true };
        },
        getMeta: async (key) => meta.get(key) ?? "vs-0",
        setMeta: async (key, value) => {
          meta.set(key, value);
        },
      },
      fetch: fetcher as unknown as typeof fetch,
      limit: 10,
      onSyncComplete: (result) => {
        completed.push(result);
      },
    });

    client.start();
    await waitFor(() => applied.length === 2);
    client.stop();

    expect(requests).toEqual([
      { pathname: "/_internal/outbox/stream", after: "vs-0", limit: "10" },
    ]);
    assert(meta.get("app-outbox::outbox") === "vs-2");
    expect(applied).toEqual([
      { sourceKey: "app-outbox::outbox", versionstamp: "vs-1", uowId: "uow-vs-1" },
      { sourceKey: "app-outbox::outbox", versionstamp: "vs-2", uowId: "uow-vs-2" },
    ]);
    expect(completed).toEqual([
      { appliedEntries: 1, lastVersionstamp: "vs-1" },
      { appliedEntries: 1, lastVersionstamp: "vs-2" },
    ]);
  });

  it("reconnects after a stream read failure", async () => {
    const entry = makeEntry("vs-1", "user-1");
    const encoder = new TextEncoder();
    const meta = new Map<string, string>();
    const applied: string[] = [];
    const errors: unknown[] = [];
    let requestCount = 0;

    const fetcher = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new TypeError("network dropped"));
            },
          }),
          { status: 200 },
        );
      }

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`${JSON.stringify(entry)}\n`));
            controller.close();
          },
        }),
        { status: 200 },
      );
    });

    const client = new LofiClient({
      outboxUrl: "https://example.com/_internal/outbox",
      endpointName: "app-outbox",
      outboxTransport: "stream",
      streamReconnectIntervalMs: 1,
      adapter: {
        applyOutboxEntry: async ({ versionstamp }) => {
          applied.push(versionstamp);
          return { applied: true };
        },
        getMeta: async (key) => meta.get(key) ?? "vs-0",
        setMeta: async (key, value) => {
          meta.set(key, value);
        },
      },
      fetch: fetcher as unknown as typeof fetch,
      onError: (error) => {
        errors.push(error);
      },
    });

    client.start();
    await waitFor(() => applied.length === 1);
    client.stop();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    expect(applied).toEqual(["vs-1"]);
  });

  it("can restart a stream immediately after stopping", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener(
              "abort",
              () => {
                controller.close();
              },
              { once: true },
            );
          },
        }),
        { status: 200 },
      );
    });

    const client = new LofiClient({
      outboxUrl: "https://example.com/_internal/outbox",
      endpointName: "app-outbox",
      outboxTransport: "stream",
      adapter: {
        applyOutboxEntry: async () => ({ applied: true }),
        getMeta: async () => "vs-0",
        setMeta: async () => undefined,
      },
      fetch: fetcher as unknown as typeof fetch,
    });

    client.start();
    await waitFor(() => fetcher.mock.calls.length === 1);
    client.stop();
    client.start();
    await waitFor(() => fetcher.mock.calls.length === 2);
    client.stop();

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("accepts relative outbox URLs", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      assert(url.pathname === "/api/outbox");
      assert(url.searchParams.get("limit") === "500");
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const client = new LofiClient({
      outboxUrl: "/api/outbox",
      endpointName: "app-outbox",
      adapter: {
        applyOutboxEntry: async () => ({ applied: true }),
        getMeta: async () => undefined,
        setMeta: async () => undefined,
      },
      fetch: fetcher as unknown as typeof fetch,
    });

    await expect(client.syncOnce()).resolves.toEqual({ appliedEntries: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns without error when aborted before fetch", async () => {
    const controller = new AbortController();
    controller.abort();

    const fetcher = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));

    const client = new LofiClient({
      outboxUrl: baseOutboxUrl,
      endpointName: "app-outbox",
      adapter: {
        applyOutboxEntry: async () => ({ applied: true }),
        getMeta: async () => undefined,
        setMeta: async () => undefined,
      },
      fetch: fetcher as unknown as typeof fetch,
    });

    await expect(client.syncOnce({ signal: controller.signal })).resolves.toEqual({
      appliedEntries: 0,
      aborted: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns without error when aborted during fetch", async () => {
    const controller = new AbortController();

    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal?.aborted) {
            const error = new Error("Aborted");
            (error as Error & { name: string }).name = "AbortError";
            reject(error);
            return;
          }

          signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("Aborted");
              (error as Error & { name: string }).name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    );

    const client = new LofiClient({
      outboxUrl: baseOutboxUrl,
      endpointName: "app-outbox",
      adapter: {
        applyOutboxEntry: async () => ({ applied: true }),
        getMeta: async () => undefined,
        setMeta: async () => undefined,
      },
      fetch: fetcher as unknown as typeof fetch,
    });

    const promise = client.syncOnce({ signal: controller.signal });
    controller.abort();

    await expect(promise).resolves.toEqual({ appliedEntries: 0, aborted: true });
  });
});
