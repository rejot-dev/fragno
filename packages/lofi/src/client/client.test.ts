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

const makeEntry = (versionstamp: string, externalId: string): OutboxEntry => ({
  id: FragnoId.fromExternal(`outbox-${externalId}`, 0),
  versionstamp,
  uowId: `uow-${versionstamp}`,
  payload: superjson.serialize(makePayload(externalId)),
  createdAt: new Date(),
});

describe("LofiClient", () => {
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

    await expect(promise).resolves.toEqual({ appliedEntries: 0 });
  });
});
