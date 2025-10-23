import { adapter } from "./adapter";
import type { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import { createRatingFragment } from "@fragno-dev/fragno-db-library/upvote";

export function createRatingFragmentServer(a: DrizzleAdapter) {
  return createRatingFragment({}, { databaseAdapter: a });
}

export const fragment = createRatingFragmentServer(adapter);
