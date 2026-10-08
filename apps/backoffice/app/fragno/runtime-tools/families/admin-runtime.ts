import type { AuthObject, OtpObject } from "@/backoffice-runtime/object-registry";
import type { BackofficeAppsCommands } from "@/fragno/apps/contracts";
import { requireBackofficeAppOperationValue } from "@/fragno/apps/errors";

import type { AdminRuntime } from "./admin";

type AdminAuthCommands = Pick<
  AuthObject,
  | "getOAuthClientFacts"
  | "createAdminOAuthClient"
  | "listAdminOAuthClients"
  | "updateAdminOAuthClient"
  | "rotateAdminOAuthClientSecret"
  | "createAdminOrganization"
  | "getOrganizationBySlug"
  | "getOrganization"
  | "listOrganizations"
  | "listOrganizationMembers"
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
      `Admin organization command could not find organization slug '${organizationSlug}'.`,
    );
  }
  return organization.id;
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
    updateOAuthClient: async (input, administratorUserId) =>
      await auth.updateAdminOAuthClient({ ...input, administratorUserId }),
    rotateOAuthClientSecret: async (input, administratorUserId) =>
      await auth.rotateAdminOAuthClientSecret({ ...input, administratorUserId }),
    createApp: async (input) => {
      if (!apps) {
        throw new Error("Admin app creation requires the APPS binding.");
      }
      const client = await auth.getOAuthClientFacts({ clientId: input.oauthClientId });
      if (!client) {
        throw new Error(
          `OAuth client '${input.oauthClientId}' was not found. List clients with admin.oauth-clients.list.`,
        );
      }
      // The Codemode client always receives first-party authority, so an app registration for it
      // could be installed but never used.
      if (client.managedByBackoffice) {
        throw new Error(
          `OAuth client '${input.oauthClientId}' is the deployment's Codemode client and cannot be registered as an app. Create a dedicated client with admin.oauth-clients.create.`,
        );
      }
      // Without this scope the app could be installed but never exchange for execution access.
      if (!client.scopes.includes("backoffice")) {
        throw new Error(
          `OAuth client '${input.oauthClientId}' must allow the backoffice scope before it can be registered as an app. Update it with admin.oauth-clients.update.`,
        );
      }
      return requireBackofficeAppOperationValue(await apps.registerApp(input));
    },
    listApps: async (input) => {
      if (!apps) {
        throw new Error("Admin app listing requires the APPS binding.");
      }
      return requireBackofficeAppOperationValue(await apps.listApps(input));
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
    listOrganizations: async (input) => await auth.listOrganizations(input),
    getOrganization: async ({ organizationSlug }) => {
      const organization = await auth.getOrganization({
        organizationId: await requireAdminOrganizationId(auth, organizationSlug),
      });
      if (!organization) {
        throw new Error(`Admin organization command could not find slug '${organizationSlug}'.`);
      }
      return organization;
    },
    listOrganizationMembers: async ({ organizationSlug, ...page }) =>
      await auth.listOrganizationMembers({
        ...page,
        organizationId: await requireAdminOrganizationId(auth, organizationSlug),
      }),
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
