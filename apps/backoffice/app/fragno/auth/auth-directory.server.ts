import type { UserWithRole } from "better-auth/plugins/admin";
import type { Invitation } from "better-auth/plugins/organization";
import type { RouterContextProvider } from "react-router";
import { z } from "zod";

import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { callBetterAuth, requireBackofficeMe } from "./auth-server";
import type { OrganizationMembership } from "./contracts";

// Cast the authoritative SDK endpoint responses at acquisition, not in UI consumers.
type Invitations = Invitation[];
type Users = { users: UserWithRole[]; total: number };

type DirectoryRequest = {
  request: Request;
  context: Readonly<RouterContextProvider>;
};

function directoryPage(request: Request): number {
  const parsed = z.coerce
    .number()
    .int()
    .positive()
    .safeParse(new URL(request.url).searchParams.get("page") ?? "1");
  if (!parsed.success) {
    throw new Response("Invalid directory page.", { status: 400 });
  }
  return parsed.data;
}

async function membershipForDirectory(
  { request, context }: DirectoryRequest,
  slug: string,
): Promise<OrganizationMembership> {
  const me = await requireBackofficeMe(request, context);
  const membership = me.organizations.find((entry) => entry.organization.slug === slug);
  if (!membership) {
    throw new Response("Organization not found.", { status: 404 });
  }
  return membership;
}

/**
 * The members page reads members from Auth rather than Better Auth, which lists them only to the
 * organization's own members and not to those acting through the organization that manages it.
 */
export async function loadOrganizationMembers(input: DirectoryRequest, slug: string) {
  const membership = await membershipForDirectory(input, slug);
  const page = directoryPage(input.request);
  const pageSize = 25;
  const result = await input.context
    .get(BackofficeWorkerContext)
    .runtime.objects.auth.singleton()
    .commands.listOrganizationMembersByPage({
      organizationId: membership.organization.id,
      page,
      pageSize,
    });
  return {
    members: result.members.map((member) => ({
      id: member.memberId,
      userId: member.userId,
      roles: member.roles,
      createdAt: member.joinedAt,
      user: { name: member.name, email: member.email },
    })),
    page,
    total: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
  };
}

export async function loadOrganizationInvitations(input: DirectoryRequest, slug: string) {
  const organizationId = (await membershipForDirectory(input, slug)).organization.id;
  const response = await callBetterAuth(
    input.request,
    input.context,
    `/organization/list-invitations?${new URLSearchParams({ organizationId })}`,
  );
  if (!response.ok) {
    throw response;
  }
  const invitations = (await response.json()) as Invitations;
  return {
    invitations: invitations.map((invitation) => ({
      ...invitation,
      roles: invitation.role?.split(",") ?? ["member"],
    })),
  };
}

const emailVerificationRequiredSchema = z.object({
  code: z.literal("EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION"),
});

/**
 * Lists invitations addressed to the session's email. Better Auth lists them only once the user has
 * verified that they own the address, so an unverified user gets a state instead of an error.
 */
export async function loadUserInvitations({ request, context }: DirectoryRequest) {
  const response = await callBetterAuth(request, context, "/organization/list-user-invitations");
  if (
    response.status === 403 &&
    emailVerificationRequiredSchema.safeParse(
      await response
        .clone()
        .json()
        .catch(() => null),
    ).success
  ) {
    return { status: "email-unverified" } as const;
  }
  if (!response.ok) {
    throw response;
  }
  const invitations = (await response.json()) as Array<Invitation & { organizationName: string }>;
  return {
    status: "listed",
    invitations: invitations.map((invitation) => ({
      invitation: { ...invitation, roles: invitation.role?.split(",") ?? ["member"] },
      organization: { id: invitation.organizationId, name: invitation.organizationName },
    })),
  } as const;
}

export async function loadSystemUsers({ request, context }: DirectoryRequest) {
  const page = directoryPage(request);
  const limit = 50;
  const search = new URL(request.url).searchParams.get("search") ?? "";
  const query = new URLSearchParams({
    searchValue: search,
    searchField: "email",
    searchOperator: "contains",
    sortBy: "createdAt",
    sortDirection: "desc",
    limit: String(limit),
    offset: String((page - 1) * limit),
  });
  const response = await callBetterAuth(request, context, `/admin/list-users?${query}`);
  if (!response.ok) {
    throw response;
  }
  const result = (await response.json()) as Users;
  return {
    users: result.users.map((user) => ({
      id: user.id,
      email: user.email,
      role: user.role === "admin" ? ("admin" as const) : ("user" as const),
      createdAt: new Date(user.createdAt).toISOString(),
    })),
    search,
    page,
    total: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / limit)),
  };
}
