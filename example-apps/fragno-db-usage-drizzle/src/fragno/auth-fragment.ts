import { createAuthFragment } from "@fragno-dev/simple-auth-fragment";
import { adapter } from "../fragno-adapter";
import type { DatabaseAdapter } from "@fragno-dev/db";

// oxlint-disable-next-line no-explicit-any
export function createAuthFragmentServer(a: DatabaseAdapter<any>) {
  return createAuthFragment({}, { databaseAdapter: a });
}

export const fragment = createAuthFragmentServer(adapter);
