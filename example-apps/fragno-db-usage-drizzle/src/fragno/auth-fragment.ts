import { createAuthFragment } from "@fragno-dev/simple-auth-fragment";
import { adapter } from "../fragno-adapter";
import type { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";

export function createAuthFragmentServer(a: DrizzleAdapter) {
  return createAuthFragment({}, { databaseAdapter: a });
}

export const fragment = createAuthFragmentServer(adapter);
