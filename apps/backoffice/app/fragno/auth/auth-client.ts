import { adminClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { useCallback, useEffect, useState } from "react";

import { recordIssuedBackofficeToken } from "./browser-auth.client";
import {
  backofficeSignOutResultSchema,
  issueBackofficeTokenResultSchema,
  type BackofficeMeData,
  type OrganizationInvitation,
  type OrganizationMember,
  type Role,
} from "./contracts";
import {
  readPreferredOrganization,
  subscribeToPreferredOrganization,
  writePreferredOrganization,
} from "./preferred-organization.client";

const betterAuthClient = createAuthClient({
  plugins: [organizationClient(), adminClient()],
});

type BetterAuthClientError = {
  code?: string;
  status?: number;
  message?: string;
};

export class AuthClientError extends Error {
  readonly code: string | null;
  readonly status: number | null;

  constructor(error: BetterAuthClientError) {
    super(error.message || "The authentication request failed.");
    this.name = "AuthClientError";
    this.code = error.code ?? null;
    this.status = error.status ?? null;
  }
}

const unwrap = async <T>(
  request: Promise<{ data?: T | null; error?: BetterAuthClientError | null }>,
) => {
  const result = await request;
  if (result.error) {
    throw new AuthClientError(result.error);
  }
  return result.data as T;
};

type AuthQueryKey =
  | "user-invitations"
  | `organization-invitations:${string}`
  | `organization-members:${string}`;

const authQueryInvalidationListeners = new Map<AuthQueryKey, Set<() => void>>();

function invalidateAuthQueries(keys: readonly AuthQueryKey[]): void {
  for (const key of keys) {
    for (const listener of authQueryInvalidationListeners.get(key) ?? []) {
      listener();
    }
  }
}

type QueryState<T> = {
  data: T | undefined;
  loading: boolean;
  error: unknown;
  refetch: () => void;
};

const useAsyncQuery = <T>(
  load: () => Promise<T>,
  dependencies: readonly unknown[],
  invalidationKeys: readonly AuthQueryKey[] = [],
): QueryState<T> => {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<Omit<QueryState<T>, "refetch">>({
    data: undefined,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const refetch = () => {
      setRevision((value) => value + 1);
    };
    for (const key of invalidationKeys) {
      const listeners = authQueryInvalidationListeners.get(key) ?? new Set();
      listeners.add(refetch);
      authQueryInvalidationListeners.set(key, listeners);
    }
    return () => {
      for (const key of invalidationKeys) {
        const listeners = authQueryInvalidationListeners.get(key);
        listeners?.delete(refetch);
        if (listeners?.size === 0) {
          authQueryInvalidationListeners.delete(key);
        }
      }
    };
    // The caller supplies stable invalidation keys for its query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, invalidationKeys);

  useEffect(() => {
    let active = true;
    setState((current) => ({ ...current, loading: true, error: null }));
    void load().then(
      (data) => {
        if (active) {
          setState({ data, loading: false, error: null });
        }
      },
      (error: unknown) => {
        if (active) {
          setState((current) => ({ ...current, loading: false, error }));
        }
      },
    );
    return () => {
      active = false;
    };
    // The caller supplies the complete dependency list for its query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, revision]);

  return {
    ...state,
    refetch: () => {
      setRevision((value) => value + 1);
    },
  };
};

const useAsyncMutation = <TInput, TResult>(mutate: (input: TInput) => Promise<TResult>) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const execute = useCallback(
    async (input: TInput) => {
      setLoading(true);
      setError(null);
      try {
        return await mutate(input);
      } catch (nextError) {
        setError(nextError);
        throw nextError;
      } finally {
        setLoading(false);
      }
    },
    [mutate],
  );
  return { mutate: execute, loading, error };
};

const preferredOrganization = {
  read: readPreferredOrganization,
  resolve(me: BackofficeMeData, storedOrganizationId: string | null) {
    const resolvedOrganizationId = me.organizations.some(
      (entry) => entry.organization.id === storedOrganizationId,
    )
      ? storedOrganizationId
      : (me.activeOrganization?.organization.id ?? me.organizations[0]?.organization.id ?? null);
    return { storedOrganizationId, resolvedOrganizationId };
  },
  setForMe(me: BackofficeMeData, organizationId: string) {
    if (!me.organizations.some((entry) => entry.organization.id === organizationId)) {
      throw new Error("The selected organization is not available to this user.");
    }
    writePreferredOrganization(organizationId);
  },
};

type BetterAuthDate = Date | string | number;
type OrganizationRole = "member" | "admin" | "owner";
type BetterAuthMember = {
  id: string;
  organizationId: string;
  userId: string;
  role?: string;
  createdAt: BetterAuthDate;
  updatedAt?: BetterAuthDate;
  user: {
    id: string;
    name: string;
    email: string;
    image?: string;
  };
};

type OrganizationMemberListEntry = OrganizationMember & {
  user: {
    name: string;
    email: string;
    imageUrl: string | null;
  };
};
type BetterAuthInvitation = {
  id: string;
  organizationId: string;
  email: string;
  role?: string;
  status: OrganizationInvitation["status"];
  inviterId: string;
  expiresAt: BetterAuthDate;
  createdAt: BetterAuthDate;
  organizationName?: string;
  organizationSlug?: string;
};
type BetterAuthUser = {
  id: string;
  email: string;
  role?: string | null;
  createdAt: BetterAuthDate;
};

const normalizeMember = (member: BetterAuthMember): OrganizationMemberListEntry => ({
  id: member.id,
  organizationId: member.organizationId,
  userId: member.userId,
  roles: (member.role ?? "member")
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean),
  createdAt: new Date(member.createdAt),
  updatedAt: new Date(member.updatedAt ?? member.createdAt),
  user: {
    name: member.user.name,
    email: member.user.email,
    imageUrl: member.user.image ?? null,
  },
});

const normalizeInvitation = (invitation: BetterAuthInvitation): OrganizationInvitation => ({
  id: invitation.id,
  token: invitation.id,
  organizationId: invitation.organizationId,
  email: invitation.email,
  roles: (invitation.role ?? "member")
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean),
  status: invitation.status,
  inviterId: invitation.inviterId,
  expiresAt: new Date(invitation.expiresAt),
  createdAt: new Date(invitation.createdAt),
});

export const authClient = {
  signIn: {
    social: async (input: {
      provider: "github";
      callbackURL: string;
      disableRedirect?: boolean;
    }): Promise<{
      data: { url?: string; redirect?: boolean } | null;
      error: { message?: string } | null;
    }> => {
      const result = await betterAuthClient.signIn.social(input);
      return {
        data: result.data
          ? {
              url: result.data.url,
              redirect: result.data.redirect,
            }
          : null,
        error: result.error ? { message: result.error.message } : null,
      };
    },
  },
  preferredOrganization,
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
  usePreferredOrganizationPreference() {
    const [storedOrganizationId, setStoredOrganizationId] = useState(readPreferredOrganization);
    useEffect(
      () =>
        subscribeToPreferredOrganization(() => {
          setStoredOrganizationId(readPreferredOrganization());
        }),
      [],
    );
    return {
      storedOrganizationId,
      preferredOrganizationId: storedOrganizationId,
    };
  },
  useSwitchOrganization() {
    return useAsyncMutation(async (input: { body: { organizationId: string } }) => {
      const response = await fetch("/api/auth/backoffice-token", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          selection: "required",
          organizationId: input.body.organizationId,
        }),
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
  useOrganizationMembers(input: {
    path: { organizationId: string };
    query: { pageSize: string; page: string };
  }): QueryState<{
    members: OrganizationMemberListEntry[];
    page: number;
    total: number;
    totalPages: number;
  }> {
    return useAsyncQuery(
      async () => {
        const limit = Number(input.query.pageSize);
        const page = Math.max(1, Number(input.query.page));
        const offset = (page - 1) * limit;
        const result = await unwrap<{ members: BetterAuthMember[]; total: number }>(
          betterAuthClient.organization.listMembers({
            query: { organizationId: input.path.organizationId, limit, offset },
          }),
        );
        return {
          members: (result.members ?? []).map(normalizeMember),
          page,
          total: result.total,
          totalPages: Math.max(1, Math.ceil(result.total / limit)),
        };
      },
      [input.path.organizationId, input.query.pageSize, input.query.page],
      [`organization-members:${input.path.organizationId}`],
    );
  },
  useUpdateOrganizationMemberRoles() {
    return useAsyncMutation(
      async (input: {
        path: { organizationId: string; memberId: string };
        body: { roles: string[] };
      }) => {
        const result = await unwrap(
          betterAuthClient.organization.updateMemberRole({
            organizationId: input.path.organizationId,
            memberId: input.path.memberId,
            role: input.body.roles.join(","),
          }),
        );
        invalidateAuthQueries([`organization-members:${input.path.organizationId}`]);
        return result;
      },
    );
  },
  useRemoveOrganizationMember() {
    return useAsyncMutation(
      async (input: { path: { organizationId: string; memberId: string } }) => {
        const result = await unwrap(
          betterAuthClient.organization.removeMember({
            organizationId: input.path.organizationId,
            memberIdOrEmail: input.path.memberId,
          }),
        );
        invalidateAuthQueries([`organization-members:${input.path.organizationId}`]);
        return result;
      },
    );
  },
  useOrganizationInvitations(input: {
    path: { organizationId: string };
  }): QueryState<{ invitations: OrganizationInvitation[] }> {
    return useAsyncQuery(
      async () => {
        const result = await unwrap<BetterAuthInvitation[]>(
          betterAuthClient.organization.listInvitations({
            query: { organizationId: input.path.organizationId },
          }),
        );
        return { invitations: (result ?? []).map(normalizeInvitation) };
      },
      [input.path.organizationId],
      [`organization-invitations:${input.path.organizationId}`],
    );
  },
  useInviteOrganizationMember() {
    return useAsyncMutation(
      async (input: {
        path: { organizationId: string };
        body: { email: string; roles?: OrganizationRole[] };
      }) => {
        const invitation = await unwrap<BetterAuthInvitation>(
          betterAuthClient.organization.inviteMember({
            organizationId: input.path.organizationId,
            email: input.body.email,
            role: input.body.roles ?? ["member"],
          }),
        );
        invalidateAuthQueries([`organization-invitations:${input.path.organizationId}`]);
        return { invitation: invitation ? normalizeInvitation(invitation) : null };
      },
    );
  },
  useUserInvitations(): QueryState<{
    invitations: Array<{
      invitation: OrganizationInvitation;
      organization: BackofficeMeData["organizations"][number]["organization"];
    }>;
  }> {
    return useAsyncQuery(
      async () => {
        const result = await unwrap<BetterAuthInvitation[]>(
          betterAuthClient.organization.listUserInvitations(),
        );
        return {
          invitations: (result ?? []).map((invitation) => {
            if (!invitation.organizationSlug) {
              throw new Error(
                `Invitation '${invitation.id}' did not include an organization slug.`,
              );
            }
            return {
              invitation: normalizeInvitation(invitation),
              organization: {
                id: invitation.organizationId,
                name: invitation.organizationName ?? invitation.organizationId,
                slug: invitation.organizationSlug,
                logoUrl: null,
                metadata: null,
                createdBy: invitation.inviterId,
                createdAt: new Date(invitation.createdAt),
                updatedAt: new Date(invitation.createdAt),
                deletedAt: null,
              },
            };
          }),
        };
      },
      [],
      ["user-invitations"],
    );
  },
  useRespondOrganizationInvitation() {
    return useAsyncMutation(
      async (input: {
        path: { invitationId: string };
        body: { action: "accept" | "reject"; token?: string };
      }) => {
        const result =
          input.body.action === "accept"
            ? await unwrap<{ invitation: BetterAuthInvitation }>(
                betterAuthClient.organization.acceptInvitation({
                  invitationId: input.path.invitationId,
                }),
              )
            : await unwrap<{ invitation: BetterAuthInvitation | null }>(
                betterAuthClient.organization.rejectInvitation({
                  invitationId: input.path.invitationId,
                }),
              );
        const invitation = result.invitation ? normalizeInvitation(result.invitation) : null;
        const organizationId = invitation?.organizationId;
        invalidateAuthQueries([
          "user-invitations",
          ...(organizationId
            ? ([
                `organization-invitations:${organizationId}`,
                `organization-members:${organizationId}`,
              ] satisfies AuthQueryKey[])
            : []),
        ]);
        return { invitation };
      },
    );
  },
  useUsers(input: {
    query: {
      search?: string;
      sortBy?: string;
      sortOrder?: string;
      pageSize: string;
      page: string;
    };
  }): QueryState<{
    users: Array<{ id: string; email: string; role: Role; createdAt: string }>;
    page: number;
    total: number;
    totalPages: number;
  }> {
    return useAsyncQuery(async () => {
      const limit = Number(input.query.pageSize);
      const page = Math.max(1, Number(input.query.page));
      const offset = (page - 1) * limit;
      const result = await unwrap<{ users: BetterAuthUser[]; total: number }>(
        betterAuthClient.admin.listUsers({
          query: {
            searchValue: input.query.search,
            searchField: "email",
            searchOperator: "contains",
            sortBy: input.query.sortBy,
            sortDirection: input.query.sortOrder as "asc" | "desc" | undefined,
            limit,
            offset,
          },
        }),
      );
      const users = (result.users ?? []).map(
        (user): { id: string; email: string; role: Role; createdAt: string } => ({
          id: user.id,
          email: user.email,
          role: user.role === "admin" ? "admin" : "user",
          createdAt: new Date(user.createdAt).toISOString(),
        }),
      );
      return {
        users,
        page,
        total: result.total,
        totalPages: Math.max(1, Math.ceil(result.total / limit)),
      };
    }, [
      input.query.search,
      input.query.sortBy,
      input.query.sortOrder,
      input.query.pageSize,
      input.query.page,
    ]);
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

export type AuthClient = typeof authClient;
export type { BackofficeMeData } from "./contracts";
