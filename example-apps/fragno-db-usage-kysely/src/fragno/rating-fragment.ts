import { createRatingFragment } from "@fragno-dev/fragno-db-library/upvote";

import { adapter } from "./adapter";

/**
 * Creates an instantiated rating fragment with database
 */
export function createRatingFragmentServer(): ReturnType<typeof createRatingFragment> {
  return createRatingFragment({}, { databaseAdapter: adapter });
}
export const fragment: ReturnType<typeof createRatingFragment> = createRatingFragmentServer();
