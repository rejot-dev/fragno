import { useCallback, useState } from "react";

import { betterAuthClient } from "./better-auth.client";
import { recordIssuedBackofficeToken } from "./browser-auth.client";
import {
  backofficeSignOutResultSchema,
  issueBackofficeTokenResultSchema,
  type Role,
} from "./contracts";
import { writePreferredOrganization } from "./preferred-organization.client";

async function unwrap<T>(
  request: Promise<{ data: T; error: { message?: string; code?: string; status?: number } | null }>,
): Promise<NonNullable<T>> {
  const result = await request;
  if (result.error) {
    throw Object.assign(
      new Error(result.error.message || "The authentication request failed."),
      result.error,
    );
  }
  return result.data as NonNullable<T>;
}

function useAsyncMutation<TInput, TResult>(mutate: (input: TInput) => Promise<TResult>) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const execute = useCallback(
    async (input: TInput) => {
      setLoading(true);
      setError(null);
      try {
        return await mutate(input);
      } catch (cause) {
        setError(cause);
        throw cause;
      } finally {
        setLoading(false);
      }
    },
    [mutate],
  );
  return { mutate: execute, loading, error };
}

// Route loaders own reads and revalidation. These commands do not cache identity or grants.
export const authClient = {
  useSignOut() {
    return useAsyncMutation(async () => {
      const response = await fetch("/api/auth/backoffice-sign-out", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        throw new Error((await response.text()) || "Unable to sign out.");
      }
      return backofficeSignOutResultSchema.parse(await response.json());
    });
  },
  useSwitchOrganization() {
    return useAsyncMutation(async (input: { body: { organizationId: string } }) => {
      const response = await fetch("/api/auth/backoffice-token", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selection: "required", organizationId: input.body.organizationId }),
      });
      if (!response.ok) {
        throw new Error((await response.text()) || "Unable to switch organization.");
      }
      const result = issueBackofficeTokenResultSchema.parse(await response.json());
      writePreferredOrganization(result.organization?.id ?? null);
      recordIssuedBackofficeToken(result);
      return result;
    });
  },
  useUpdateOrganization() {
    return useAsyncMutation(
      async (input: { path: { organizationId: string }; body: { name: string } }) =>
        await unwrap(
          betterAuthClient.organization.update({
            organizationId: input.path.organizationId,
            data: input.body,
          }),
        ),
    );
  },
  useUpdateOrganizationMemberRoles() {
    return useAsyncMutation(
      async (input: {
        path: { organizationId: string; memberId: string };
        body: { roles: string[] };
      }) =>
        await unwrap(
          betterAuthClient.organization.updateMemberRole({
            organizationId: input.path.organizationId,
            memberId: input.path.memberId,
            role: input.body.roles.join(","),
          }),
        ),
    );
  },
  useRemoveOrganizationMember() {
    return useAsyncMutation(
      async (input: { path: { organizationId: string; memberId: string } }) =>
        await unwrap(
          betterAuthClient.organization.removeMember({
            organizationId: input.path.organizationId,
            memberIdOrEmail: input.path.memberId,
          }),
        ),
    );
  },
  useInviteOrganizationMember() {
    return useAsyncMutation(
      async (input: {
        path: { organizationId: string };
        body: { email: string; roles?: Array<"member" | "admin" | "owner"> };
      }) => ({
        invitation: await unwrap(
          betterAuthClient.organization.inviteMember({
            organizationId: input.path.organizationId,
            email: input.body.email,
            role: input.body.roles ?? ["member"],
          }),
        ),
      }),
    );
  },
  useRespondOrganizationInvitation() {
    return useAsyncMutation(
      async (input: { path: { invitationId: string }; body: { action: "accept" | "reject" } }) => {
        return input.body.action === "accept"
          ? await unwrap(
              betterAuthClient.organization.acceptInvitation({
                invitationId: input.path.invitationId,
              }),
            )
          : await unwrap(
              betterAuthClient.organization.rejectInvitation({
                invitationId: input.path.invitationId,
              }),
            );
      },
    );
  },
  useUpdateUserRole() {
    return useAsyncMutation(
      async (input: { path: { userId: string }; body: { role: Role } }) =>
        await unwrap(
          betterAuthClient.admin.setRole({ userId: input.path.userId, role: input.body.role }),
        ),
    );
  },
};
