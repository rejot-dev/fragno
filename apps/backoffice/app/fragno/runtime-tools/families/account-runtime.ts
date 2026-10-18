import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";

import type { AccountRuntime } from "./account";

/** Binds account commands to the execution's user principal. */
export function createAccountRuntime({
  objects,
  userId,
}: {
  objects: Pick<BackofficeObjectRegistry, "auth">;
  userId: string;
}): AccountRuntime {
  // Resolve Auth per command so building a tool context never instantiates the Auth object.
  const auth = () => objects.auth.singleton().commands;
  return {
    getProfile: async () => await auth().getAccountProfile({ userId }),
    updateProfile: async ({ name }) => await auth().updateAccountProfile({ userId, name }),
    listOrganizations: async () => await auth().listAccountOrganizations({ userId }),
    listInvitations: async () => {
      const listing = await auth().listAccountInvitations({ userId });
      if (listing.status === "email-unverified") {
        throw new BackofficeOperationError(
          "forbidden",
          "Verify your email address to see invitations sent to it.",
        );
      }
      return listing.invitations;
    },
    acceptInvitation: async ({ invitationId }) =>
      await auth().acceptAccountInvitation({ userId, invitationId }),
    listApplications: async (page) => await auth().listAccountOAuthConsents({ userId, ...page }),
  };
}
