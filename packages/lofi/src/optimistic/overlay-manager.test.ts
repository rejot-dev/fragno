import { beforeEach, describe, expect, it } from "vitest";
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
import { column, idColumn, schema, FragnoId } from "@fragno-dev/db/schema";
import { IndexedDbAdapter } from "../indexeddb/adapter";
import type { LofiSubmitCommandDefinition } from "../types";
import { defaultQueueKey, storeSubmitQueue } from "../submit/queue";
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
    const users = await query.find("users");
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe("Ada Lovelace");
    const userId = users[0].id as FragnoId;
    expect(userId.version).toBe(1);
  });
});
