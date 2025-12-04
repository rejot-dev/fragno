import type { DatabaseAdapter } from "@fragno-dev/db";
import { adapter } from "../fragno-adapter";
import { createRatingFragment } from "@fragno-dev/fragno-db-library/upvote";

// oxlint-disable-next-line no-explicit-any
export function createRatingFragmentServer(a: DatabaseAdapter<any>) {
  return createRatingFragment({}, { databaseAdapter: a });
}

export const fragment = createRatingFragmentServer(adapter);
