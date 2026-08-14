import { commentSchema, upvoteSchema } from "@fragno-dev/fragno-db-library/schema";

import { createFragnoOutboxCoordinator } from "@fragno-dev/tanstack-db-adapter";

function normalizeServerOrigin(origin: string): string {
  return origin.replace(/\/$/, "");
}

const configuredServerOrigin = import.meta.env["VITE_FRAGNO_SERVER_ORIGIN"] as string | undefined;
const serverOrigin = normalizeServerOrigin(configuredServerOrigin ?? "http://localhost:3000");

export const fragmentEndpoints = {
  comments: `${serverOrigin}/api/fragno-db-comment/comments`,
  commentBase: `${serverOrigin}/api/fragno-db-comment`,
  ratings: `${serverOrigin}/api/fragno-db-rating/upvotes`,
  ratingBase: `${serverOrigin}/api/fragno-db-rating`,
  serverOrigin,
} as const;

export async function createLocalDatabase() {
  const [commentCoordinator, ratingCoordinator] = await Promise.all([
    createFragnoOutboxCoordinator({
      baseUrl: fragmentEndpoints.commentBase,
      fetch: globalThis.fetch,
      schemas: [commentSchema] as const,
    }),
    createFragnoOutboxCoordinator({
      baseUrl: fragmentEndpoints.ratingBase,
      fetch: globalThis.fetch,
      schemas: [upvoteSchema] as const,
    }),
  ]);

  const comments = commentCoordinator.collection(commentSchema, "comment");
  const upvotes = ratingCoordinator.collection(upvoteSchema, "upvote");
  const ratingTotals = ratingCoordinator.collection(upvoteSchema, "upvote_total");

  try {
    await Promise.all([commentCoordinator.preload(), ratingCoordinator.preload()]);
  } catch (error) {
    await Promise.allSettled([commentCoordinator.cleanup(), ratingCoordinator.cleanup()]);
    throw error;
  }

  return {
    collections: { comments, upvotes, ratingTotals },
    endpoints: fragmentEndpoints,
    getCheckpoints() {
      return {
        comments: commentCoordinator.internal.getCheckpoint(),
        ratings: ratingCoordinator.internal.getCheckpoint(),
      };
    },
    async dispose() {
      await Promise.all([commentCoordinator.cleanup(), ratingCoordinator.cleanup()]);
    },
  };
}

export type LocalDatabase = Awaited<ReturnType<typeof createLocalDatabase>>;
