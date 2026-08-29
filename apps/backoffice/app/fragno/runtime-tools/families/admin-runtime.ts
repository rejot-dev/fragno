import type { AuthObject } from "@/backoffice-runtime/object-registry";

import type { AdminRuntime } from "./admin";

type AdminAuthCommands = Pick<
  AuthObject,
  | "createAdminOrganization"
  | "getOrganizationBySlug"
  | "addAdminOrganizationMember"
  | "removeAdminOrganizationMember"
>;

async function requireAdminOrganizationId(auth: AdminAuthCommands, organizationSlug: string) {
  const organization = await auth.getOrganizationBySlug(organizationSlug);
  if (!organization) {
    throw new Error(
      `Admin organization member command could not find organization slug '${organizationSlug}'.`,
    );
  }
  return organization.id;
}

/** Creates the system administration runtime backed by the singleton Auth object. */
export function createAdminRuntime(auth: AdminAuthCommands): AdminRuntime {
  return {
    createOrganization: async (input) => await auth.createAdminOrganization(input),
    addOrganizationMember: async ({ organizationSlug, ...input }) =>
      await auth.addAdminOrganizationMember({
        ...input,
        organizationId: await requireAdminOrganizationId(auth, organizationSlug),
      }),
    removeOrganizationMember: async ({ organizationSlug, ...input }) =>
      await auth.removeAdminOrganizationMember({
        ...input,
        organizationId: await requireAdminOrganizationId(auth, organizationSlug),
      }),
  };
}
