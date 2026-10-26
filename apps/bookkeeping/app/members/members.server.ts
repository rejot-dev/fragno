import {
  organizationRoleSchema,
  type OrganizationRole,
} from "@fragno-dev/backoffice-api/v0/organization";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { assertSameOrigin } from "../auth/session.server";
import { invitationLink, invite } from "../invitations/invite.server";
import {
  callBackoffice,
  connectAsUser,
  organizationNotFound,
  parseRoles,
  type OrganizationContext,
} from "../organizations/access.server";
import { highestRole } from "../organizations/roles";

/** Backoffice's largest page; an organization in Bookkeeping rarely fills one. */
const PAGE_SIZE = 100;

const ROLE_ORDER: OrganizationRole[] = ["owner", "admin", "member"];

export type Member = {
  userId: string;
  /** The name they gave Bookkeeping, else the one Backoffice has, else their email. */
  name: string;
  email: string;
  role: OrganizationRole;
  /** The signed-in person. */
  you: boolean;
};

export type PendingInvitation = {
  id: string;
  email: string;
  role: OrganizationRole;
  /** Null for invitations made in Backoffice itself. */
  invitedBy: string | null;
  /**
   * Bookkeeping's page for accepting it, shown to those who invite; null for invitations made in
   * Backoffice itself, which Bookkeeping cannot open.
   */
  link: string | null;
};

export type Team = {
  members: Member[];
  invitations: PendingInvitation[];
  /** The roles the signed-in person may invite with; empty when they may not invite. */
  inviteRoles: OrganizationRole[];
};

/**
 * The roles someone may invite with, as Backoffice decides: owners invite anyone, admins invite
 * admins and members, and members invite no one.
 */
function inviteRolesFor(roles: OrganizationRole[]): OrganizationRole[] {
  if (roles.includes("owner")) {
    return ["member", "admin", "owner"];
  }
  return roles.includes("admin") ? ["member", "admin"] : [];
}

/** Every page of a Backoffice list, following its cursor. */
async function allPages<T>(
  page: (cursor: string | null) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const next = await page(cursor);
    items.push(...next.items);
    cursor = next.nextCursor;
  } while (cursor !== null);
  return items;
}

/**
 * The organization's members and pending invitations, as Backoffice lists them to the signed-in
 * person. Names come from Bookkeeping where people gave one, since Backoffice's sign-up asks only
 * for an email; who invited someone, and the link, from the invitations Bookkeeping created.
 */
export async function loadTeam(request: Request, context: OrganizationContext): Promise<Team> {
  const { organization, user, roles } = context;
  const backoffice = await connectAsUser(request, {
    kind: "org",
    orgId: organization.id,
    jurisdiction: null,
  });
  if (!backoffice) {
    throw organizationNotFound();
  }
  const scope = { kind: "org", orgId: organization.id, jurisdiction: null } as const;
  const [listed, pending] = await callBackoffice(() =>
    Promise.all([
      allPages(async (cursor) => {
        const page = await backoffice.call(scope, "org.members.list", {
          pageSize: PAGE_SIZE,
          cursor,
        });
        return { items: page.members, nextCursor: page.nextCursor };
      }),
      allPages(async (cursor) => {
        const page = await backoffice.call(scope, "org.invitations.list", {
          pageSize: PAGE_SIZE,
          cursor,
        });
        return { items: page.invitations, nextCursor: page.nextCursor };
      }),
    ]),
  );
  const members = listed.map((member) => ({ ...member, roles: parseRoles(member.roles) }));
  const directory = env.DIRECTORY.getByName("directory");
  const [names, created] = await Promise.all([
    env.AUTH.getByName("auth").findNames(members.map(({ userId }) => userId)),
    directory.listInvitations(organization.id),
    // Backoffice just listed everyone, so the copy follows: members added in Backoffice reach
    // their places, and removed ones lose access now rather than within a minute.
    directory.confirmMembers({ organizationId: organization.id, members, confirmedAt: Date.now() }),
  ]);
  const createdById = new Map(created.map((invitation) => [invitation.id, invitation]));
  const inviteRoles = inviteRolesFor(roles);
  return {
    members: members
      .map(
        (member): Member => ({
          userId: member.userId,
          name: names[member.userId] ?? (member.name.trim() || member.email),
          email: member.email,
          role: highestRole(member.roles),
          you: member.userId === user.backofficeUserId,
        }),
      )
      .sort(
        (a, b) =>
          ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name),
      ),
    invitations: pending
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((invitation) => {
        const mine = createdById.get(invitation.invitationId);
        return {
          id: invitation.invitationId,
          email: invitation.email,
          role: highestRole(parseRoles(invitation.roles)),
          invitedBy: mine?.invitedBy ?? null,
          link: mine && inviteRoles.length > 0 ? invitationLink(mine.id) : null,
        };
      }),
    inviteRoles,
  };
}

const invitationSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter an email address.")),
  role: organizationRoleSchema,
});

export type InviteResult =
  | { status: "invited"; email: string; link: string; emailed: boolean }
  | { status: "failed"; error: string };

/**
 * Invites someone from the team page, as the signed-in person. Backoffice applies their current
 * role, so the page's choice of roles is a convenience, not the check. Inviting again after a
 * failure returns the same invitation.
 */
export async function inviteToTeam(
  request: Request,
  { organization, user }: OrganizationContext,
): Promise<InviteResult> {
  assertSameOrigin(request);
  const parsed = invitationSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) {
    return { status: "failed", error: parsed.error.issues[0]?.message ?? "Check the form." };
  }
  const { email, role } = parsed.data;
  const result = await invite({ organization, inviter: user, email, roles: [role] });
  if (result.status === "unavailable") {
    return { status: "failed", error: "Inviting didn't work. Try again shortly." };
  }
  if (result.status === "refused") {
    return { status: "failed", error: result.message };
  }
  return result;
}
