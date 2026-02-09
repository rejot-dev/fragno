import { createCommentFragment } from "@fragno-dev/fragno-db-library";
import { adapter } from "../fragno-adapter";
import type { DatabaseAdapter } from "@fragno-dev/db";

// oxlint-disable-next-line no-explicit-any
export function createCommentFragmentServer(a: DatabaseAdapter<any>) {
  return createCommentFragment({}, { databaseAdapter: a, outbox: { enabled: true } });
}

export const fragment = createCommentFragmentServer(adapter);
