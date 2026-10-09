import type { OrganizationInvitationRecord } from "@fragno-dev/backoffice-api/v0/organization";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { backofficeInvitationPath } from "@/routes/backoffice/auth-navigation";

import type { OrganizationRuntime } from "./organization";

/** Binds organization commands to the execution's scoped organization and user principal. */
export function createOrganizationRuntime({
  objects,
  organizationId,
  userId,
  publicBaseUrl,
}: {
  objects: Pick<BackofficeObjectRegistry, "auth">;
  organizationId: string;
  userId: string;
  publicBaseUrl: string | null;
}): OrganizationRuntime {
  // Resolve Auth per command so building a tool context never instantiates the Auth object.
  const auth = () => objects.auth.singleton().commands;

  function withInvitationLink(invitation: OrganizationInvitationRecord) {
    if (!publicBaseUrl) {
      throw new Error(
        "Organization invitation links require DOCS_PUBLIC_BASE_URL to be configured.",
      );
    }
    return {
      ...invitation,
      url: new URL(backofficeInvitationPath(invitation.invitationId), publicBaseUrl).toString(),
    };
  }

  return {
    get: async () => {
      const membership = await auth().getOrganizationMembership({ organizationId, userId });
      if (!membership) {
        throw new Error(`User '${userId}' is not a member of organization '${organizationId}'.`);
      }
      return membership;
    },
    update: async ({ name }) => await auth().updateOrganization({ organizationId, name }),
    listMembers: async (page) => await auth().listOrganizationMembers({ organizationId, ...page }),
    listInvitations: async (page) => {
      const result = await auth().listOrganizationInvitations({ organizationId, ...page });
      return { ...result, invitations: result.invitations.map(withInvitationLink) };
    },
    createInvitation: async ({ email, roles }) =>
      withInvitationLink(
        await auth().createOrganizationInvitation({
          organizationId,
          inviterUserId: userId,
          email,
          roles,
        }),
      ),
  };
}
