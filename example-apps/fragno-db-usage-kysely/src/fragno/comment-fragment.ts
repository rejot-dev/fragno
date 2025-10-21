import { KyselyAdapter } from "@fragno-dev/db/adapters/kysely";
import { db } from "../database";
import { createCommentFragment } from "@fragno-dev/fragno-db-library";

/**
 * Creates a Kysely adapter for the comment fragment
 */
export function createAdapter() {
  return new KyselyAdapter({
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
