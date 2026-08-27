import type { AuthObject } from "@/backoffice-runtime/object-registry";

import type { AdminRuntime } from "./admin";

/** Creates the system administration runtime backed by the singleton Auth object. */
export function createAdminRuntime(auth: AuthObject): AdminRuntime {
  return {
    createOrganization: async (input) => await auth.createAdminOrganization(input),
    addOrganizationMember: async (input) => await auth.addAdminOrganizationMember(input),
    removeOrganizationMember: async (input) => await auth.removeAdminOrganizationMember(input),
  };
}
