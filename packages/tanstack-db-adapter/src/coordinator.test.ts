import { assert, describe, expect, it, vi } from "vitest";

import {
  checkpointForEntry,
  shouldApplyOutboxEntry,
  type FragnoOutboxCheckpoint,
} from "./checkpoint";
import { createFragnoOutboxCoordinator, type FragnoOutboxConsumer } from "./coordinator";
import type { FragnoOutboxEntry } from "./protocol";
import type { FragnoOutboxStreamingTransport } from "./streaming-transport";
import type { FragnoOutboxTransport } from "./transport";

function entry(index: number): FragnoOutboxEntry {
  return {
    versionstamp: String(index).padStart(24, "0"),
    uowId: `uow-${index}`,
    payload: { json: { version: 1, mutations: [] } },
  };
}

function createMemoryTransport(entries: FragnoOutboxEntry[]): FragnoOutboxTransport {
  return {
    async getAdapterIdentity() {
      return "adapter-1";
    },
    async list({ afterVersionstamp, limit }) {
      return entries
        .filter(({ versionstamp }) => !afterVersionstamp || versionstamp > afterVersionstamp)
        .slice(0, limit);
    },
  };
}

function createConsumer(options: {
  id: string;
  checkpoint?: FragnoOutboxCheckpoint;
  initialized?: boolean;
  beforeApply?: (entry: FragnoOutboxEntry) => void;
}) {
  let checkpoint = options.checkpoint;
  let initialized = options.initialized ?? false;
  let ready = false;
  const applied: string[] = [];

  const consumer: FragnoOutboxConsumer = {
    id: options.id,
    getCheckpoint: () => checkpoint,
    isInitialized: () => initialized,
    prepareSource() {},
    applyEntry(entry) {
      if (!shouldApplyOutboxEntry(checkpoint, entry)) {
        return;
      }

      options.beforeApply?.(entry);
      applied.push(entry.versionstamp);
      checkpoint = checkpointForEntry(entry);
    },
    markLoading() {},
    markReady() {
      initialized = true;
      ready = true;
    },
    markError() {},
  };

  return {
    consumer,
    applied,
    getCheckpoint: () => checkpoint,
    isReady: () => ready,
  };
}

async function waitForStreamStart(waiters: Array<() => void>, isStarted: () => boolean) {
  if (isStarted()) {
    return;
  }

  await new Promise<void>((resolve) => {
    waiters.push(resolve);
  });
}

describe("Fragno outbox coordinator", () => {
  it("applies every UOW to every collection before advancing to the next UOW", async () => {
    const entries = [entry(1), entry(2)];
    const events: string[] = [];
    const users = createConsumer({
      id: "users",
      beforeApply: (nextEntry) => events.push(`users:${nextEntry.uowId}`),
    });
    const posts = createConsumer({
      id: "posts",
      beforeApply: (nextEntry) => events.push(`posts:${nextEntry.uowId}`),
    });
    const coordinator = createFragnoOutboxCoordinator({
      internalUrl: "https://example.com/_internal",
      transport: createMemoryTransport(entries),
      pageSize: 1,
      pollIntervalMs: 60_000,
    });

    coordinator.register(users.consumer);
    coordinator.register(posts.consumer);
    await coordinator.syncOnce();

    expect(events).toEqual(["users:uow-1", "posts:uow-1", "users:uow-2", "posts:uow-2"]);
    assert(users.isReady());
    assert(posts.isReady());
    coordinator.dispose();
  });

  it("resumes only the lagging collection after a partial UOW application", async () => {
    const entries = [entry(1)];
    let postsCanCommit = false;
    const users = createConsumer({ id: "users" });
    const posts = createConsumer({
      id: "posts",
      beforeApply() {
        if (!postsCanCommit) {
          throw new Error("posts commit failed");
        }
      },
    });
    const coordinator = createFragnoOutboxCoordinator({
      internalUrl: "https://example.com/_internal",
      transport: createMemoryTransport(entries),
      pollIntervalMs: 60_000,
    });

    coordinator.register(users.consumer);
    coordinator.register(posts.consumer);
    await expect(coordinator.syncOnce()).rejects.toThrow("posts commit failed");

    expect(users.applied).toEqual([entry(1).versionstamp]);
    expect(posts.applied).toEqual([]);

    postsCanCommit = true;
    await coordinator.syncOnce();

    expect(users.applied).toEqual([entry(1).versionstamp]);
    expect(posts.applied).toEqual([entry(1).versionstamp]);
    coordinator.dispose();
  });

  it("replays history for a newly registered collection without reapplying existing collections", async () => {
    const entries = [entry(1), entry(2)];
    const users = createConsumer({ id: "users" });
    const posts = createConsumer({ id: "posts" });
    const coordinator = createFragnoOutboxCoordinator({
      internalUrl: "https://example.com/_internal",
      transport: createMemoryTransport(entries),
      pollIntervalMs: 60_000,
    });

    coordinator.register(users.consumer);
    await coordinator.syncOnce();
    coordinator.register(posts.consumer);
    await coordinator.syncOnce();

    expect(users.applied).toEqual(entries.map(({ versionstamp }) => versionstamp));
    expect(posts.applied).toEqual(entries.map(({ versionstamp }) => versionstamp));
    coordinator.dispose();
  });

  it("keeps the adapter identity stable for the coordinator lifetime", async () => {
    let adapterIdentity = "adapter-1";
    let sourceIdentity: string | undefined;
    let checkpoint: FragnoOutboxCheckpoint | undefined;
    const applied: string[] = [];
    const coordinator = createFragnoOutboxCoordinator({
      internalUrl: "https://example.com/_internal",
      pollIntervalMs: 60_000,
      transport: {
        async getAdapterIdentity() {
          return adapterIdentity;
        },
        async list({ afterVersionstamp }) {
          const nextEntry = adapterIdentity === "adapter-1" ? entry(9) : entry(1);
          return afterVersionstamp ? [] : [nextEntry];
        },
      },
    });
    const consumer: FragnoOutboxConsumer = {
      id: "users",
      getCheckpoint: () => checkpoint,
      isInitialized: () => false,
      prepareSource(nextAdapterIdentity) {
        if (sourceIdentity !== nextAdapterIdentity) {
          sourceIdentity = nextAdapterIdentity;
          checkpoint = undefined;
        }
      },
      applyEntry(nextEntry) {
        applied.push(nextEntry.versionstamp);
        checkpoint = checkpointForEntry(nextEntry);
      },
      markLoading() {},
      markReady() {},
      markError() {},
    };

    coordinator.register(consumer);
    await coordinator.syncOnce();
    expect(applied).toEqual([entry(9).versionstamp]);

    adapterIdentity = "adapter-2";
    await coordinator.syncOnce();

    expect(sourceIdentity).toBe("adapter-1");
    expect(applied).toEqual([entry(9).versionstamp]);
    coordinator.dispose();
  });

  it("makes an initialized polling consumer ready without listing outbox history", async () => {
    let listRequests = 0;
    const users = createConsumer({ id: "users", initialized: true });
    const coordinator = createFragnoOutboxCoordinator({
      internalUrl: "https://example.com/_internal",
      bootstrap: { adapterIdentity: "adapter-1" },
      pollIntervalMs: 60_000,
      transport: {
        async getAdapterIdentity() {
          throw new Error("The supplied adapter identity should be used.");
        },
        async list() {
          listRequests += 1;
          throw new Error("Initialized collection history should not be listed on registration.");
        },
      },
    });

    coordinator.register(users.consumer);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert(users.isReady());
    expect(listRequests).toBe(0);
    coordinator.dispose();
  });

  it("resolves the adapter identity once for the coordinator lifetime", async () => {
    let identityRequests = 0;
    const coordinator = createFragnoOutboxCoordinator({
      internalUrl: "https://example.com/_internal",
      pollIntervalMs: 60_000,
      transport: {
        async getAdapterIdentity() {
          identityRequests += 1;
          return "adapter-1";
        },
        async list() {
          return [];
        },
      },
    });

    coordinator.register(createConsumer({ id: "users" }).consumer);
    await Promise.all([coordinator.syncOnce(), coordinator.syncOnce()]);

    expect(identityRequests).toBe(1);
    coordinator.dispose();
  });

  it("uses statically supplied bootstrap data without requesting the internal route", async () => {
    let preparedIdentity: string | undefined;
    const users = createConsumer({ id: "users" });
    users.consumer.prepareSource = (adapterIdentity) => {
      preparedIdentity = adapterIdentity;
    };
    const coordinator = createFragnoOutboxCoordinator({
      internalUrl: "https://example.com/_internal",
      bootstrap: { adapterIdentity: "server-loaded-adapter" },
      pollIntervalMs: 60_000,
      transport: {
        async getAdapterIdentity() {
          throw new Error("The internal route should not be requested.");
        },
        async list() {
          return [];
        },
      },
    });

    coordinator.register(users.consumer);
    await coordinator.syncOnce();

    expect(preparedIdentity).toBe("server-loaded-adapter");
    coordinator.dispose();
  });

  it("catches up once and then applies entries from one shared stream", async () => {
    const availableEntries = [entry(1)];
    let identityRequests = 0;
    let streamRequests = 0;
    let activeStream:
      | {
          onEntry(entry: FragnoOutboxEntry): void | Promise<void>;
          close(): void;
        }
      | undefined;
    const streamStarted: Array<() => void> = [];
    const transport: FragnoOutboxTransport & {
      stream(options: {
        afterVersionstamp?: string;
        limit: number;
        signal: AbortSignal;
        onEntry(entry: FragnoOutboxEntry): void | Promise<void>;
      }): Promise<void>;
    } = {
      async getAdapterIdentity() {
        identityRequests += 1;
        return "adapter-1";
      },
      async list({ afterVersionstamp, limit }) {
        return availableEntries
          .filter(({ versionstamp }) => !afterVersionstamp || versionstamp > afterVersionstamp)
          .slice(0, limit);
      },
      stream(options) {
        streamRequests += 1;
        return new Promise<void>((resolve) => {
          const close = () => resolve();
          activeStream = { onEntry: options.onEntry, close };
          options.signal.addEventListener("abort", close, { once: true });
          for (const markStarted of streamStarted.splice(0)) {
            markStarted();
          }
        });
      },
    };
    const users = createConsumer({ id: "users" });
    const posts = createConsumer({ id: "posts" });
    const coordinator = createFragnoOutboxCoordinator({
      internalUrl: "https://example.com/_internal",
      transport,
      pageSize: 10,
      pollIntervalMs: 60_000,
    });

    coordinator.register(users.consumer);
    coordinator.register(posts.consumer);
    await coordinator.syncOnce();
    await waitForStreamStart(streamStarted, () => activeStream !== undefined);

    expect(users.applied).toEqual([entry(1).versionstamp]);
    expect(posts.applied).toEqual([entry(1).versionstamp]);
    assert(activeStream);
    await activeStream.onEntry(entry(2));

    expect(users.applied).toEqual([entry(1).versionstamp, entry(2).versionstamp]);
    expect(posts.applied).toEqual([entry(1).versionstamp, entry(2).versionstamp]);
    expect(identityRequests).toBe(1);
    expect(streamRequests).toBe(1);
    coordinator.dispose();
  });

  it("backs off repeated stream failures without repeating initialized catch-up", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const failure = new Error("stream unavailable");
    let listRequests = 0;
    let streamRequests = 0;
    const transport: FragnoOutboxStreamingTransport = {
      async getAdapterIdentity() {
        return "adapter-1";
      },
      async list() {
        listRequests += 1;
        return [];
      },
      async stream() {
        streamRequests += 1;
        throw failure;
      },
    };
    const coordinator = createFragnoOutboxCoordinator({
      internalUrl: "https://example.com/_internal",
      pollIntervalMs: 100,
      transport,
    });

    try {
      coordinator.register(createConsumer({ id: "users" }).consumer);
      await vi.advanceTimersByTimeAsync(0);
      expect({ listRequests, streamRequests }).toEqual({ listRequests: 1, streamRequests: 1 });

      await vi.advanceTimersByTimeAsync(100);
      expect({ listRequests, streamRequests }).toEqual({ listRequests: 1, streamRequests: 2 });

      await vi.advanceTimersByTimeAsync(199);
      expect({ listRequests, streamRequests }).toEqual({ listRequests: 1, streamRequests: 2 });
      await vi.advanceTimersByTimeAsync(1);
      expect({ listRequests, streamRequests }).toEqual({ listRequests: 1, streamRequests: 3 });
    } finally {
      coordinator.dispose();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("serializes concurrent synchronization requests", async () => {
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    let delayRequests = false;
    const transport: FragnoOutboxTransport = {
      async getAdapterIdentity() {
        return "adapter-1";
      },
      async list() {
        activeRequests += 1;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        if (delayRequests) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        activeRequests -= 1;
        return [];
      },
    };
    const coordinator = createFragnoOutboxCoordinator({
      internalUrl: "https://example.com/_internal",
      transport,
      pollIntervalMs: 60_000,
    });

    coordinator.register(createConsumer({ id: "users" }).consumer);
    await coordinator.syncOnce();
    maximumActiveRequests = 0;
    delayRequests = true;

    await Promise.all([coordinator.syncOnce(), coordinator.syncOnce(), coordinator.syncOnce()]);

    expect(maximumActiveRequests).toBe(1);
    coordinator.dispose();
  });

  it("backs off repeated polling failures and resets after recovery", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const failure = new Error("outbox unavailable");
    const observedErrors: unknown[] = [];
    let requestCount = 0;
    const coordinator = createFragnoOutboxCoordinator({
      internalUrl: "https://example.com/_internal",
      pollIntervalMs: 100,
      onError: (error) => observedErrors.push(error),
      transport: {
        async getAdapterIdentity() {
          return "adapter-1";
        },
        async list() {
          requestCount += 1;
          if (requestCount === 1 || requestCount === 2 || requestCount === 4) {
            throw failure;
          }
          return [];
        },
      },
    });

    try {
      coordinator.register(createConsumer({ id: "users" }).consumer);
      await vi.advanceTimersByTimeAsync(0);
      expect(requestCount).toBe(1);

      await vi.advanceTimersByTimeAsync(99);
      expect(requestCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(requestCount).toBe(2);

      await vi.advanceTimersByTimeAsync(199);
      expect(requestCount).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(requestCount).toBe(3);

      await vi.advanceTimersByTimeAsync(100);
      expect(requestCount).toBe(4);
      await vi.advanceTimersByTimeAsync(99);
      expect(requestCount).toBe(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(requestCount).toBe(5);
      expect(observedErrors).toEqual([failure, failure, failure]);
    } finally {
      coordinator.dispose();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("stops paging when every synchronized consumer unregisters during a request", async () => {
    let requestCount = 0;
    let markRequestStarted!: () => void;
    let releaseRequest!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const requestReleased = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const coordinator = createFragnoOutboxCoordinator({
      internalUrl: "https://example.com/_internal",
      pageSize: 1,
      pollIntervalMs: 60_000,
      transport: {
        async getAdapterIdentity() {
          return "adapter-1";
        },
        async list() {
          requestCount += 1;
          markRequestStarted();
          await requestReleased;
          return [entry(requestCount)];
        },
      },
    });

    const unregister = coordinator.register(createConsumer({ id: "users" }).consumer);
    await requestStarted;
    unregister();
    releaseRequest();
    await coordinator.syncOnce();

    expect(requestCount).toBe(1);
    coordinator.dispose();
  });

  it("stops dispatching to an unregistered collection without affecting the others", async () => {
    const entries = [entry(1)];
    const users = createConsumer({ id: "users" });
    const posts = createConsumer({ id: "posts" });
    const coordinator = createFragnoOutboxCoordinator({
      internalUrl: "https://example.com/_internal",
      transport: createMemoryTransport(entries),
      pollIntervalMs: 60_000,
    });

    const unregisterUsers = coordinator.register(users.consumer);
    coordinator.register(posts.consumer);
    await coordinator.syncOnce();

    unregisterUsers();
    entries.push(entry(2));
    await coordinator.syncOnce();

    expect(users.applied).toEqual([entry(1).versionstamp]);
    expect(posts.applied).toEqual([entry(1).versionstamp, entry(2).versionstamp]);
    coordinator.dispose();
  });
});
