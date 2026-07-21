import { commentSchema, upvoteSchema } from "@fragno-dev/fragno-db-library/schema";

import { createFragnoStateSchema, createFragnoStreamDB } from "@fragno-dev/tanstack-db";

import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
} from "@tanstack/browser-db-sqlite-persistence";

export const DEMO_REFERENCE = "fragno-tanstack-persistence-poc";
export const SERVER_ORIGIN =
  import.meta.env["VITE_FRAGNO_SERVER_ORIGIN"] ?? "http://localhost:3000";

const DATABASE_NAME = "fragno-tanstack-persistence-poc.sqlite";
const PERSISTENCE_SCOPE = "public-demo:v1";

const state = createFragnoStateSchema({
  comments: { schema: commentSchema, table: "comment" },
  upvoteTotals: { schema: upvoteSchema, table: "upvote_total" },
});

export async function createDemoRuntime() {
  const database = await openBrowserWASQLiteOPFSDatabase({
    databaseName: DATABASE_NAME,
  });
  const coordinator = new BrowserCollectionCoordinator({
    dbName: "fragno-tanstack-persistence-poc",
  });
  const persistence = createBrowserWASQLitePersistence({
    database,
    coordinator,
  });
  const streamDb = createFragnoStreamDB({
    state,
    streamOptions: {
      url: `${SERVER_ORIGIN}/api/fragno-db-comment/_internal/outbox/durable/state`,
    },
    persistence: {
      provider: persistence,
      scope: PERSISTENCE_SCOPE,
      version: 1,
    },
  });
  let closed = false;

  return {
    streamDb,
    comments: streamDb.collections.comments,
    upvoteTotals: streamDb.collections.upvoteTotals,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await streamDb.close();
      } finally {
        coordinator.dispose();
        await database.close?.();
      }
    },
  };
}

export type DemoRuntime = Awaited<ReturnType<typeof createDemoRuntime>>;
