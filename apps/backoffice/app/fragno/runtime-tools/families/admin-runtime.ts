import type { AuthObject, OtpObject } from "@/backoffice-runtime/object-registry";
import type { BackofficeAppsCommands } from "@/fragno/apps/contracts";
import { BackofficeAppDomainError, type BackofficeAppOperationResult } from "@/fragno/apps/errors";

import type { AdminRuntime } from "./admin";

type AdminAuthCommands = Pick<
  AuthObject,
  | "hasOAuthClient"
  | "createAdminOAuthClient"
  | "listAdminOAuthClients"
  | "createAdminOrganization"
  | "getOrganizationBySlug"
  | "addAdminOrganizationMember"
  | "removeAdminOrganizationMember"
>;

type AdminOtpCommands = Pick<OtpObject, "issueSignUpInvitation">;

type AdminRuntimeDependencies = {
  auth: AdminAuthCommands;
  apps: BackofficeAppsCommands | null;
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

function requireAdminAppValue<T>(result: BackofficeAppOperationResult<T>): T {
  if (!result.ok) {
    throw new BackofficeAppDomainError(result.error.code, result.error.message);
  }
  return result.value;
}

/** Creates the system administration runtime backed by singleton Backoffice objects. */
export function createAdminRuntime({
  auth,
  apps,
  otp,
  publicBaseUrl,
}: AdminRuntimeDependencies): AdminRuntime {
  return {
    createOAuthClient: async (input, administratorUserId) =>
      await auth.createAdminOAuthClient({ ...input, administratorUserId }),
    listOAuthClients: async (input, administratorUserId) =>
      await auth.listAdminOAuthClients({ ...input, administratorUserId }),
    createApp: async (input) => {
      if (!apps) {
        throw new Error("Admin app creation requires the APPS binding.");
      }
      if (!(await auth.hasOAuthClient({ clientId: input.oauthClientId }))) {
        throw new Error(`Admin app creation could not find OAuth client '${input.oauthClientId}'.`);
      }
      return requireAdminAppValue(await apps.registerApp(input));
    },
    listApps: async (input) => {
      if (!apps) {
        throw new Error("Admin app listing requires the APPS binding.");
      }
      return requireAdminAppValue(await apps.listApps(input));
    },
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
