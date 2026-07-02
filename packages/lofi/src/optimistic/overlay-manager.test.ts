import { beforeEach, describe, expect, it, assert, vi } from "vitest";

import { column, idColumn, schema, FragnoId } from "@fragno-dev/db/schema";
import {
  IDBCursor,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
} from "fake-indexeddb";

import { dbNow } from "@fragno-dev/db";

import { IndexedDbAdapter } from "../indexeddb/adapter";
import { defineLocalProjection } from "../local/projection";
import { defaultQueueKey, storeSubmitQueue } from "../submit/queue";
import type { LofiSubmitCommandDefinition } from "../types";
import { LofiOverlayManager } from "./overlay-manager";

const appSchema = schema("app", (s) =>
  s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);

const createDbName = () => `lofi-overlay-${Math.random().toString(16).slice(2)}`;

describe("optimistic overlay manager", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBCursor = IDBCursor;
    globalThis.IDBDatabase = IDBDatabase;
    globalThis.IDBIndex = IDBIndex;
    globalThis.IDBKeyRange = IDBKeyRange;
    globalThis.IDBObjectStore = IDBObjectStore;
    globalThis.IDBOpenDBRequest = IDBOpenDBRequest;
    globalThis.IDBRequest = IDBRequest;
    globalThis.IDBTransaction = IDBTransaction;
  });

  it("rebuilds overlay from queued commands", async () => {
    const adapter = new IndexedDbAdapter({
      dbName: createDbName(),
      endpointName: "app",
      schemas: [{ schema: appSchema }],
    });

    const command: LofiSubmitCommandDefinition<{ id: string; name: string }, {}> = {
      name: "createUser",
      target: { fragment: "app", schema: "app" },
      handler: async ({ input, tx }) => {
        await tx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).create("users", input);
          })
          .execute();
      },
    };

    const queueKey = defaultQueueKey("app");
    await storeSubmitQueue(adapter, queueKey, [
      {
        id: "cmd-1",
        name: "createUser",
        target: { fragment: "app", schema: "app" },
        input: { id: "user-1", name: "Ada Lovelace" },
      },
    ]);

    const manager = new LofiOverlayManager({
      endpointName: "app",
      adapter,
      schemas: [appSchema],
      commands: [command as LofiSubmitCommandDefinition<unknown, {}>],
    });

    await manager.rebuild();

    const query = manager.createQueryEngine(appSchema);
    const users = await query.find("users", (b) => b.whereIndex("primary"));
    expect(users).toHaveLength(1);
    assert(users[0].name === "Ada Lovelace");
    const userId = users[0].id as FragnoId;
    assert(userId.version === 1);
  });

  it("passes optimistic update mutations to local projections as updates", async () => {
    const localSchema = schema("local_user_update_counts", (s) =>
      s.addTable("user_update_counts", (t) =>
        t.addColumn("id", idColumn()).addColumn("count", column("integer")),
      ),
    );
    const projection = defineLocalProjection({
      mutate: ({ match, tx }) => {
        const counts = tx.forSchema(localSchema);
        for (const mutation of match.all(appSchema, "users", "update")) {
          counts.create("user_update_counts", { id: mutation.externalId, count: 1 });
        }
      },
    });
    const adapter = new IndexedDbAdapter({
      dbName: createDbName(),
      endpointName: "app",
      schemas: [{ schema: appSchema }],
    });
    await adapter.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-vs1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada" },
        },
      ],
    });

    const command: LofiSubmitCommandDefinition<{ id: string; name: string }, {}> = {
      name: "renameUser",
      target: { fragment: "app", schema: "app" },
      handler: async ({ input, tx }) => {
        await tx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).update("users", input.id, (b) => b.set({ name: input.name }));
          })
          .execute();
      },
    };
    const manager = new LofiOverlayManager({
      endpointName: "app",
      adapter,
      schemas: [appSchema],
      localSchemas: [localSchema],
      projections: [projection],
      commands: [command as LofiSubmitCommandDefinition<unknown, {}>],
    });

    await manager.applyCommand({
      id: "cmd-1",
      name: "renameUser",
      target: { fragment: "app", schema: "app" },
      input: { id: "user-1", name: "Grace" },
    });

    const users = await manager.stackedAdapter
      .createQueryEngine(appSchema)
      .find("users", (b) => b.whereIndex("primary"));
    expect(users).toMatchObject([{ name: "Grace" }]);
    const counts = await manager
      .createQueryEngine(localSchema)
      .find("user_update_counts", (b) => b.whereIndex("primary"));
    expect(counts).toMatchObject([{ count: 1 }]);
  });

  it("passes materialized local command dbNow values to local projections", async () => {
    const eventSchema = schema("events", (s) =>
      s.addTable("events", (t) =>
        t.addColumn("id", idColumn()).addColumn("createdAt", column("date")),
      ),
    );
    const localSchema = schema("local_event_view", (s) =>
      s.addTable("event_cards", (t) =>
        t.addColumn("id", idColumn()).addColumn("seenAt", column("date")),
      ),
    );
    let valueSeenByProjection: unknown;
    const projection = defineLocalProjection({
      mutate: ({ match, tx }) => {
        const eventCards = tx.forSchema(localSchema);
        for (const mutation of match.all(eventSchema, "events", "create")) {
          valueSeenByProjection = mutation.values.createdAt;
          eventCards.create("event_cards", {
            id: mutation.externalId,
            seenAt: mutation.values.createdAt,
          });
        }
      },
    });
    const command: LofiSubmitCommandDefinition<{ id: string }, {}> = {
      name: "createEvent",
      target: { fragment: "app", schema: "events" },
      handler: async ({ input, tx }) => {
        await tx()
          .mutate((ctx) => {
            ctx.forSchema(eventSchema).create("events", {
              id: input.id,
              createdAt: dbNow(),
            });
          })
          .execute();
      },
    };
    const adapter = new IndexedDbAdapter({
      dbName: createDbName(),
      endpointName: "app",
      schemas: [{ schema: eventSchema }],
    });
    const manager = new LofiOverlayManager({
      endpointName: "app",
      adapter,
      schemas: [eventSchema],
      localSchemas: [localSchema],
      projections: [projection],
      commands: [command as LofiSubmitCommandDefinition<unknown, {}>],
    });

    vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      await manager.applyCommand({
        id: "cmd-1",
        name: "createEvent",
        target: { fragment: "app", schema: "events" },
        input: { id: "event-1" },
      });
    } finally {
      vi.restoreAllMocks();
    }

    expect(valueSeenByProjection).toBeInstanceOf(Date);
    const events = await manager.stackedAdapter
      .createQueryEngine(eventSchema)
      .find("events", (b) => b.whereIndex("primary"));
    const cards = await manager
      .createQueryEngine(localSchema)
      .find("event_cards", (b) => b.whereIndex("primary"));
    expect(cards[0]?.seenAt).toEqual(events[0]?.createdAt);
  });
});
