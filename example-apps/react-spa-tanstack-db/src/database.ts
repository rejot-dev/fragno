import { commentSchema, upvoteSchema } from "@fragno-dev/fragno-db-library/schema";
import { createFragnoOutboxCoordinator } from "@fragno-dev/tanstack-db-adapter/coordinator";
import { createPersistedFragnoCollectionFactory } from "@fragno-dev/tanstack-db-adapter/persistence";

import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
} from "@tanstack/browser-db-sqlite-persistence";

const DATABASE_NAME = "fragno-tanstack-db.sqlite";
const PERSISTENCE_COORDINATOR_NAME = "fragno-tanstack-db";
const COLLECTION_SCHEMA_VERSION = 1;

function normalizeServerOrigin(origin: string): string {
  return origin.replace(/\/$/, "");
}

const configuredServerOrigin = import.meta.env["VITE_FRAGNO_SERVER_ORIGIN"] as string | undefined;
const serverOrigin = normalizeServerOrigin(configuredServerOrigin ?? "http://localhost:3000");

export const fragmentEndpoints = {
  comments: `${serverOrigin}/api/fragno-db-comment/comments`,
  commentInternal: `${serverOrigin}/api/fragno-db-comment/_internal`,
  ratings: `${serverOrigin}/api/fragno-db-rating/upvotes`,
  ratingInternal: `${serverOrigin}/api/fragno-db-rating/_internal`,
  serverOrigin,
} as const;

export async function createLocalDatabase() {
  const database = await openBrowserWASQLiteOPFSDatabase({ databaseName: DATABASE_NAME });
  const persistenceCoordinator = new BrowserCollectionCoordinator({
    dbName: PERSISTENCE_COORDINATOR_NAME,
  });
  const persistence = createBrowserWASQLitePersistence({
    database,
    coordinator: persistenceCoordinator,
  });
  const createPersistedCollection = createPersistedFragnoCollectionFactory({
    persistence,
    schemaVersion: COLLECTION_SCHEMA_VERSION,
  });

  const commentOutboxCoordinator = createFragnoOutboxCoordinator({
    internalUrl: fragmentEndpoints.commentInternal,
    onError: reportBackgroundSyncError,
  });
  const ratingOutboxCoordinator = createFragnoOutboxCoordinator({
    internalUrl: fragmentEndpoints.ratingInternal,
    onError: reportBackgroundSyncError,
  });

  const comments = createPersistedCollection({
    id: "comment.comment",
    coordinator: commentOutboxCoordinator,
    target: { schema: commentSchema, table: "comment" },
  });

  const upvotes = createPersistedCollection({
    id: "upvote.upvote",
    coordinator: ratingOutboxCoordinator,
    target: { schema: upvoteSchema, table: "upvote" },
  });

  const ratingTotals = createPersistedCollection({
    id: "upvote.upvote_total",
    coordinator: ratingOutboxCoordinator,
    target: { schema: upvoteSchema, table: "upvote_total" },
  });

  return {
    collections: { comments, upvotes, ratingTotals },
    endpoints: fragmentEndpoints,
    getCheckpoints() {
      return {
        comments: comments.utils.getCheckpoint(),
        ratings: upvotes.utils.getCheckpoint(),
      };
    },
    async dispose() {
      await Promise.all([comments.cleanup(), upvotes.cleanup(), ratingTotals.cleanup()]);
      commentOutboxCoordinator.dispose();
      ratingOutboxCoordinator.dispose();
      persistenceCoordinator.dispose();
      await database.close?.();
    },
  };
}

export type LocalDatabase = Awaited<ReturnType<typeof createLocalDatabase>>;

function reportBackgroundSyncError(error: unknown): void {
  console.error("Fragno outbox synchronization failed", error);
}
