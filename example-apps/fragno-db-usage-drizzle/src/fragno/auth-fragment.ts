import { createAuthFragment, type AuthFragmentInstance } from "@fragno-dev/auth";
import type { DatabaseAdapter } from "@fragno-dev/db";

import { adapter } from "../fragno-adapter";

// oxlint-disable-next-line no-explicit-any
export function createAuthFragmentServer(a: DatabaseAdapter<any>): AuthFragmentInstance {
  return createAuthFragment({}, { databaseAdapter: a, databaseNamespace: "auth" });
}

export const authFragment: AuthFragmentInstance = createAuthFragmentServer(adapter);
