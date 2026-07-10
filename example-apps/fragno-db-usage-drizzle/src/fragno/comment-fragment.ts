import type { DatabaseAdapter } from "@fragno-dev/db";
import { createCommentFragment } from "@fragno-dev/fragno-db-library";

import { adapter } from "../fragno-adapter";

export function createCommentFragmentServer(
  // oxlint-disable-next-line no-explicit-any
  a: DatabaseAdapter<any>,
): ReturnType<typeof createCommentFragment> {
  return createCommentFragment({}, { databaseAdapter: a, outbox: { enabled: true } });
}

export const commentFragment: ReturnType<typeof createCommentFragmentServer> =
  createCommentFragmentServer(adapter);
