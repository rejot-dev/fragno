import type { User } from "better-auth";
import type { UserWithRole } from "better-auth/plugins/admin";
import type { Invitation, Member } from "better-auth/plugins/organization";
import type { RouterContextProvider } from "react-router";
import { z } from "zod";

import { callBetterAuth, requireBackofficeMe } from "./auth-server";

// Cast the authoritative SDK endpoint responses at acquisition, not in UI consumers.
type Members = {
  members: Array<Member & { user: Pick<User, "id" | "name" | "email" | "image"> }>;
  total: number;
};
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

async function organizationIdForDirectory(
  { request, context }: DirectoryRequest,
  slug: string,
): Promise<string> {
  const me = await requireBackofficeMe(request, context);
  const organization = me.organizations.find(
    (entry) => entry.organization.slug === slug,
  )?.organization;
  if (!organization) {
    throw new Response("Organization not found.", { status: 404 });
  }
  return organization.id;
}

export async function loadOrganizationMembers(input: DirectoryRequest, slug: string) {
  const organizationId = await organizationIdForDirectory(input, slug);
  const page = directoryPage(input.request);
  const limit = 25;
  const query = new URLSearchParams({
    organizationId,
    limit: String(limit),
    offset: String((page - 1) * limit),
  });
  const response = await callBetterAuth(
    input.request,
    input.context,
    `/organization/list-members?${query}`,
  );
  if (!response.ok) {
    throw response;
  }
  const result = (await response.json()) as Members;
  return {
    members: result.members.map((member) => ({ ...member, roles: member.role.split(",") })),
    page,
    total: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / limit)),
  };
}

export async function loadOrganizationInvitations(input: DirectoryRequest, slug: string) {
  const organizationId = await organizationIdForDirectory(input, slug);
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

export async function loadUserInvitations({ request, context }: DirectoryRequest) {
  const response = await callBetterAuth(request, context, "/organization/list-user-invitations");
  if (!response.ok) {
    throw response;
  }
  const invitations = (await response.json()) as Array<Invitation & { organizationName: string }>;
  return {
    invitations: invitations.map((invitation) => ({
      invitation: { ...invitation, roles: invitation.role?.split(",") ?? ["member"] },
      organization: { id: invitation.organizationId, name: invitation.organizationName },
    })),
  };
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
