import { describe, expect, it, vi } from "vitest";
import superjson from "superjson";
import type { OutboxEntry, OutboxPayload } from "@fragno-dev/db";
import { FragnoId } from "@fragno-dev/db/schema";
import { LofiClient } from "../mod";

const baseOutboxUrl = "https://example.com/outbox?foo=bar";

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
    expect(meta.get("app-outbox::outbox")).toBe("vs-3");
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
