import { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import { db } from "../database";
import { commentFragment } from "@fragno-dev/fragno-db-library";

/**
 * Creates a Kysely adapter for the comment fragment
 */
export function createAdapter() {
  return new DrizzleAdapter({
    db,
    provider: "postgresql",
  });
}

/**
 * Creates a bound FragnoDatabase instance for the comment fragment
 */
export function createCommentFragment() {
  const adapter = createAdapter();
  return commentFragment.create(adapter);
}

export const fragment = createCommentFragment();
