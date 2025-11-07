import { createCommentFragment } from "@fragno-dev/fragno-db-library";
import { adapter } from "./db-adapter.server";

/**
 * Creates an instantiated comment fragment with database
 */
export function createCommentFragmentServer() {
  return createCommentFragment({}, { databaseAdapter: adapter });
}

export const fragment = createCommentFragmentServer();
