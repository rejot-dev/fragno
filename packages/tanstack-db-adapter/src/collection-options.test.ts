import { assert, describe, expect, it } from "vitest";

import { column, idColumn, schema } from "@fragno-dev/db/schema";

import { createCollection, createLiveQueryCollection } from "@tanstack/db";

import { fragnoCollectionOptions } from "./collection-options";
import { createFragnoOutboxCoordinator } from "./coordinator";
import type { FragnoOutboxStreamingTransport } from "./streaming-transport";

const appSchema = schema("app", (s) =>
  s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);

describe("Fragno collection synchronization state", () => {
  it("resolves the initial sync and exposes the ready state", async () => {
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
      pollIntervalMs: 60_000,
      transport: {
        async getAdapterIdentity() {
          return "adapter-1";
        },
        async list() {
          markRequestStarted();
          await requestReleased;
          return [];
        },
      },
    });
    const collection = createCollection(
      fragnoCollectionOptions({
        id: "users",
        coordinator,
        target: { schema: appSchema, table: "users" },
      }),
    );

    assert(collection.utils.getSyncStatus() === "idle");
    const preload = collection.preload();
    await requestStarted;
    assert(collection.utils.getSyncStatus() === "loading");
    releaseRequest();
    await Promise.all([preload, collection.utils.initialSync()]);

    assert(collection.utils.getSyncStatus() === "ready");
    expect(collection.utils.getLastError()).toBeUndefined();
    await collection.cleanup();
    coordinator.dispose();
  });

  it("closes an active stream when the last live query releases the collection", async () => {
    let resolveStreamStarted!: () => void;
    let resolveStreamAborted!: () => void;
    const streamStarted = new Promise<void>((resolve) => {
      resolveStreamStarted = resolve;
    });
    const streamAborted = new Promise<void>((resolve) => {
      resolveStreamAborted = resolve;
    });
    const transport: FragnoOutboxStreamingTransport = {
      async getAdapterIdentity() {
        return "adapter-1";
      },
      async list() {
        return [];
      },
      stream({ signal }) {
        resolveStreamStarted();
        return new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolveStreamAborted();
              resolve();
            },
            { once: true },
          );
        });
      },
    };
    const coordinator = createFragnoOutboxCoordinator({
      internalUrl: "https://example.com/_internal",
      transport,
    });
    const collection = createCollection(
      fragnoCollectionOptions({
        id: "users",
        coordinator,
        target: { schema: appSchema, table: "users" },
      }),
    );
    const users = createLiveQueryCollection((query) => query.from({ user: collection }));

    await Promise.all([users.preload(), streamStarted]);
    await users.cleanup();
    await streamAborted;

    await collection.cleanup();
    coordinator.dispose();
  });

  it("rejects the initial sync and exposes recovery", async () => {
    const failure = new Error("outbox unavailable");
    let shouldFail = true;
    const coordinator = createFragnoOutboxCoordinator({
      internalUrl: "https://example.com/_internal",
      pollIntervalMs: 60_000,
      transport: {
        async getAdapterIdentity() {
          return "adapter-1";
        },
        async list() {
          if (shouldFail) {
            throw failure;
          }

          return [];
        },
      },
    });
    const collection = createCollection(
      fragnoCollectionOptions({
        id: "users",
        coordinator,
        target: { schema: appSchema, table: "users" },
      }),
    );

    const preload = collection.preload();
    await expect(collection.utils.initialSync()).rejects.toBe(failure);
    assert(collection.utils.getSyncStatus() === "error");
    expect(collection.utils.getLastError()).toBe(failure);

    shouldFail = false;
    await collection.utils.syncOnce();
    await preload;

    assert(collection.utils.getSyncStatus() === "ready");
    expect(collection.utils.getLastError()).toBeUndefined();
    await collection.cleanup();
    coordinator.dispose();
  });
});
