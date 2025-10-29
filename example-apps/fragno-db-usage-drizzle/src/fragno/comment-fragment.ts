import { createCommentFragment } from "@fragno-dev/fragno-db-library";
import { adapter } from "../fragno-adapter";
import type { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";

export function createCommentFragmentServer(a: DrizzleAdapter) {
  return createCommentFragment({}, { databaseAdapter: a });
}

export const fragment = createCommentFragmentServer(adapter);
