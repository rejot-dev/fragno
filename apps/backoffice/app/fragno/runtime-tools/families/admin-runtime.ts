import type { AuthObject, OtpObject } from "@/backoffice-runtime/object-registry";

import type { AdminRuntime } from "./admin";

type AdminAuthCommands = Pick<
  AuthObject,
  | "createAdminOrganization"
  | "getOrganizationBySlug"
  | "addAdminOrganizationMember"
  | "removeAdminOrganizationMember"
>;

type AdminOtpCommands = Pick<OtpObject, "issueSignUpInvitation">;

type AdminRuntimeDependencies = {
  auth: AdminAuthCommands;
  otp: AdminOtpCommands | null;
  publicBaseUrl: string | null;
};

async function requireAdminOrganizationId(auth: AdminAuthCommands, organizationSlug: string) {
  const organization = await auth.getOrganizationBySlug(organizationSlug);
  if (!organization) {
    throw new Error(
      `Admin organization member command could not find organization slug '${organizationSlug}'.`,
    );
  }
  return organization.id;
}

/** Creates the system administration runtime backed by singleton Backoffice objects. */
export function createAdminRuntime({
  auth,
  otp,
  publicBaseUrl,
}: AdminRuntimeDependencies): AdminRuntime {
  return {
    createSignUpInvitation: async (input) => {
      if (!otp) {
        throw new Error("Admin sign-up invitation creation requires the OTP binding.");
      }
      if (!publicBaseUrl) {
        throw new Error(
          "Admin sign-up invitation creation requires DOCS_PUBLIC_BASE_URL to be configured.",
        );
      }

      const invitation = await otp.issueSignUpInvitation({
        ...input,
        publicBaseUrl,
      });
      return {
        invitationId: invitation.invitationId,
        email: invitation.email,
        url: invitation.url,
        ttlDays: invitation.ttlDays,
      };
    },
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
