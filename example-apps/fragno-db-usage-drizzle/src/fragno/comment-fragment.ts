import { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import { db } from "../database";
import { createCommentFragment } from "@fragno-dev/fragno-db-library";

export function createAdapter() {
  return new DrizzleAdapter({
    db,
    provider: "postgresql",
  });
}

/**
 * Creates an instantiated comment fragment with database
 */
export function createCommentFragmentServer() {
  const adapter = createAdapter();
  return createCommentFragment({}, { databaseAdapter: adapter });
}

export const fragment = createCommentFragmentServer();
