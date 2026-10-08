import type { AuthContext } from "better-auth";

import { Cursor, decodeCursor } from "@fragno-dev/db";

import { splitOrganizationRoles } from "@/fragno/auth/contracts";
import type {
  AccountInvitationRecord,
  AccountProfile,
  DirectoryPageInput,
  OrganizationInvitationPage,
  OrganizationMemberPage,
  OrganizationMembershipRecord,
  OrganizationPage,
  OrganizationRecord,
} from "@/fragno/auth/directory-records";

type AuthAdapter = AuthContext["adapter"];
type AuthWhere = NonNullable<Parameters<AuthAdapter["findMany"]>[0]["where"]>;

// Better Auth's adapter output converts stored dates and booleans to their model types.
type UserRow = { id: string; name: string; email: string; emailVerified: boolean; role: string };
type OrganizationRow = { id: string; name: string; slug: string; createdAt: Date };
type MemberRow = {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt: Date;
};
type InvitationRow = {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  expiresAt: Date;
  createdAt: Date;
};

type PagedRows = { organization: OrganizationRow; member: MemberRow; invitation: InvitationRow };

/** A cursor listing is one index plus the filter values every page of it must share. */
type IdCursorListing = { indexName: string; partition: Readonly<Record<string, string>> };

function decodeIdCursor(listing: IdCursorListing, page: DirectoryPageInput): string | null {
  if (page.cursor === null) {
    return null;
  }
  try {
    const cursor = decodeCursor(page.cursor);
    const afterId = cursor.indexValues.id;
    if (
      cursor.indexName !== listing.indexName ||
      cursor.orderDirection !== "asc" ||
      cursor.pageSize !== page.pageSize ||
      Object.entries(listing.partition).some(([key, value]) => cursor.indexValues[key] !== value) ||
      typeof afterId !== "string" ||
      afterId.length === 0
    ) {
      throw new Error("Cursor does not match this listing.");
    }
    return afterId;
  } catch {
    throw new Error(`The ${listing.indexName} listing cursor is invalid.`);
  }
}

async function readIdCursorPage<TModel extends keyof PagedRows>(
  adapter: AuthAdapter,
  input: { model: TModel; where: AuthWhere; listing: IdCursorListing; page: DirectoryPageInput },
): Promise<{ rows: PagedRows[TModel][]; nextCursor: string | null }> {
  const afterId = decodeIdCursor(input.listing, input.page);
  const rows = await adapter.findMany<PagedRows[TModel]>({
    model: input.model,
    where: [
      ...input.where,
      ...(afterId === null ? [] : [{ field: "id", operator: "gt" as const, value: afterId }]),
    ],
    sortBy: { field: "id", direction: "asc" },
    limit: input.page.pageSize + 1,
  });
  const pageRows = rows.slice(0, input.page.pageSize);
  const lastRow = pageRows.at(-1);
  return {
    rows: pageRows,
    nextCursor:
      rows.length > input.page.pageSize && lastRow
        ? new Cursor({
            indexName: input.listing.indexName,
            orderDirection: "asc",
            pageSize: input.page.pageSize,
            indexValues: { ...input.listing.partition, id: lastRow.id },
          }).encode()
        : null,
  };
}

function toOrganizationRecord(organization: OrganizationRow): OrganizationRecord {
  return {
    organizationId: organization.id,
    name: organization.name,
    slug: organization.slug,
    createdAt: organization.createdAt.toISOString(),
  };
}

async function readOrganizationsById(
  adapter: AuthAdapter,
  organizationIds: readonly string[],
): Promise<Map<string, OrganizationRow>> {
  if (organizationIds.length === 0) {
    return new Map();
  }
  const organizations = await adapter.findMany<OrganizationRow>({
    model: "organization",
    where: [{ field: "id", operator: "in", value: [...new Set(organizationIds)] }],
  });
  return new Map(organizations.map((organization) => [organization.id, organization]));
}

export async function readAccountProfile(
  adapter: AuthAdapter,
  userId: string,
): Promise<AccountProfile | null> {
  const user = await adapter.findOne<UserRow>({
    model: "user",
    where: [{ field: "id", value: userId }],
  });
  return user
    ? {
        userId: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        systemRole: user.role === "admin" ? "admin" : "user",
      }
    : null;
}

export async function readAccountOrganizations(
  adapter: AuthAdapter,
  userId: string,
): Promise<OrganizationMembershipRecord[]> {
  const memberships = await adapter.findMany<MemberRow>({
    model: "member",
    where: [{ field: "userId", value: userId }],
    sortBy: { field: "createdAt", direction: "asc" },
  });
  const organizations = await readOrganizationsById(
    adapter,
    memberships.map((membership) => membership.organizationId),
  );
  return memberships.flatMap((membership) => {
    const organization = organizations.get(membership.organizationId);
    return organization
      ? [
          {
            organization: toOrganizationRecord(organization),
            roles: splitOrganizationRoles(membership.role),
          },
        ]
      : [];
  });
}

export async function readOrganizationMembership(
  adapter: AuthAdapter,
  input: { organizationId: string; userId: string },
): Promise<OrganizationMembershipRecord | null> {
  const [organization, membership] = await Promise.all([
    adapter.findOne<OrganizationRow>({
      model: "organization",
      where: [{ field: "id", value: input.organizationId }],
    }),
    adapter.findOne<MemberRow>({
      model: "member",
      where: [
        { field: "organizationId", value: input.organizationId },
        { field: "userId", value: input.userId },
      ],
    }),
  ]);
  return organization && membership
    ? {
        organization: toOrganizationRecord(organization),
        roles: splitOrganizationRoles(membership.role),
      }
    : null;
}

export async function readAccountInvitations(
  adapter: AuthAdapter,
  input: { email: string; now: Date },
): Promise<AccountInvitationRecord[]> {
  const invitations = await adapter.findMany<InvitationRow>({
    model: "invitation",
    where: [
      { field: "email", value: input.email.toLowerCase() },
      { field: "status", value: "pending" },
      { field: "expiresAt", operator: "gt", value: input.now },
    ],
    sortBy: { field: "createdAt", direction: "asc" },
  });
  const organizations = await readOrganizationsById(
    adapter,
    invitations.map((invitation) => invitation.organizationId),
  );
  return invitations.flatMap((invitation) => {
    const organization = organizations.get(invitation.organizationId);
    return organization
      ? [
          {
            invitationId: invitation.id,
            organization: toOrganizationRecord(organization),
            roles: splitOrganizationRoles(invitation.role),
            expiresAt: invitation.expiresAt.toISOString(),
          },
        ]
      : [];
  });
}

export async function readOrganization(
  adapter: AuthAdapter,
  organizationId: string,
): Promise<OrganizationRecord | null> {
  const organization = await adapter.findOne<OrganizationRow>({
    model: "organization",
    where: [{ field: "id", value: organizationId }],
  });
  return organization ? toOrganizationRecord(organization) : null;
}

export async function readOrganizationPage(
  adapter: AuthAdapter,
  page: DirectoryPageInput,
): Promise<OrganizationPage> {
  const { rows, nextCursor } = await readIdCursorPage(adapter, {
    model: "organization",
    where: [],
    listing: { indexName: "organization.id", partition: {} },
    page,
  });
  return {
    organizations: rows.map(toOrganizationRecord),
    nextCursor,
    hasNextPage: nextCursor !== null,
  };
}

export async function readOrganizationMemberPage(
  adapter: AuthAdapter,
  input: { organizationId: string; page: DirectoryPageInput },
): Promise<OrganizationMemberPage> {
  const { rows, nextCursor } = await readIdCursorPage(adapter, {
    model: "member",
    where: [{ field: "organizationId", value: input.organizationId }],
    listing: { indexName: "member.id", partition: { organizationId: input.organizationId } },
    page: input.page,
  });
  const users =
    rows.length === 0
      ? []
      : await adapter.findMany<Pick<UserRow, "id" | "name" | "email">>({
          model: "user",
          select: ["id", "name", "email"],
          where: [{ field: "id", operator: "in", value: rows.map((member) => member.userId) }],
        });
  const usersById = new Map(users.map((user) => [user.id, user]));
  return {
    members: rows.flatMap((member) => {
      const user = usersById.get(member.userId);
      return user
        ? [
            {
              userId: user.id,
              name: user.name,
              email: user.email,
              roles: splitOrganizationRoles(member.role),
              joinedAt: member.createdAt.toISOString(),
            },
          ]
        : [];
    }),
    nextCursor,
    hasNextPage: nextCursor !== null,
  };
}

export async function readOrganizationInvitationPage(
  adapter: AuthAdapter,
  input: { organizationId: string; now: Date; page: DirectoryPageInput },
): Promise<OrganizationInvitationPage> {
  const { rows, nextCursor } = await readIdCursorPage(adapter, {
    model: "invitation",
    where: [
      { field: "organizationId", value: input.organizationId },
      { field: "status", value: "pending" },
      { field: "expiresAt", operator: "gt", value: input.now },
    ],
    listing: { indexName: "invitation.id", partition: { organizationId: input.organizationId } },
    page: input.page,
  });
  return {
    invitations: rows.map((invitation) => ({
      invitationId: invitation.id,
      organizationId: invitation.organizationId,
      email: invitation.email,
      roles: splitOrganizationRoles(invitation.role),
      expiresAt: invitation.expiresAt.toISOString(),
      createdAt: invitation.createdAt.toISOString(),
    })),
    nextCursor,
    hasNextPage: nextCursor !== null,
  };
}
