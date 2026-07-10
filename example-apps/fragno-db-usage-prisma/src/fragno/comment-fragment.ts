import { createCommentFragment } from "@fragno-dev/fragno-db-library";

import { adapter } from "./adapter";

/**
 * Creates an instantiated comment fragment with database
 */
export function createCommentFragmentServer(): ReturnType<typeof createCommentFragment> {
  return createCommentFragment({}, { databaseAdapter: adapter });
}
export const fragment: ReturnType<typeof createCommentFragmentServer> =
  createCommentFragmentServer();
