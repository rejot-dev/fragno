import { createRatingFragment } from "@fragno-dev/fragno-db-library/upvote";

import type { DatabaseAdapter } from "@fragno-dev/db";

import { adapter } from "../fragno-adapter";

export function createRatingFragmentServer(
  // oxlint-disable-next-line no-explicit-any
  a: DatabaseAdapter<any>,
): ReturnType<typeof createRatingFragment> {
  return createRatingFragment({}, { databaseAdapter: a, outbox: { enabled: true } });
}

export const ratingFragment: ReturnType<typeof createRatingFragment> =
  createRatingFragmentServer(adapter);
