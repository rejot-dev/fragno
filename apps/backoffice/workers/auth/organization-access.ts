import type { Kysely } from "kysely";

import type {
  ManagedOrganizationRecord,
  OrganizationRelations,
} from "@/backoffice-runtime/object-registry";
import {
  type AdministeredMember,
  administersMembers,
  type OrganizationAccess,
  splitOrganizationRoles,
} from "@/fragno/auth/contracts";

import type { AuthDatabase } from "../auth-object";
import { toDate } from "./stored-date";

/**
 * A role in the managing organization, as it applies in a managed one: owners act as admins, so
 * only an organization's own owners own it.
 */
function managedRoles(roles: readonly string[]): string[] {
  return [...new Set(roles.map((role) => (role === "owner" ? "admin" : role)))].sort();
}

type StoredOrganization = AuthDatabase["organization"];

/** An organization the user acts in, as its listing shows it, with how they act in it. */
export type AccessibleOrganization = {
  organization: StoredOrganization;
  roles: string[];
  through:
    | { kind: "membership" }
    | { kind: "managing-organization"; organization: StoredOrganization };
};

/**
 * Every organization the user acts in, oldest membership first and the organizations each manages
 * after them. One they belong to and one their organization manages is listed once, as a member.
 *
 * The organizations come from the same joins as the access, so the listing needs no lookup by ID,
 * which would bind one parameter per organization and grows with the clients an agency manages.
 */
export async function listAccessibleOrganizations(
  database: Kysely<AuthDatabase>,
  userId: string,
): Promise<AccessibleOrganization[]> {
  const [memberships, managedOrganizations] = await Promise.all([
    database
      .selectFrom("member")
      .innerJoin("organization", "organization.id", "member.organizationId")
      .selectAll("organization")
      .select("member.role as memberRole")
      .where("member.userId", "=", userId)
      .orderBy("member.createdAt")
      .orderBy("member.id")
      .execute(),
    // A managed organization's managingOrganizationId is the membership that reaches it.
    database
      .selectFrom("member")
      .innerJoin("organization", "organization.managingOrganizationId", "member.organizationId")
      .selectAll("organization")
      .select("member.role as memberRole")
      .where("member.userId", "=", userId)
      .orderBy("member.createdAt")
      .orderBy("member.id")
      .orderBy("organization.createdAt")
      .orderBy("organization.id")
      .execute(),
  ]);

  const accessById = new Map<string, AccessibleOrganization>();
  for (const { memberRole, ...organization } of memberships) {
    accessById.set(organization.id, {
      organization,
      roles: splitOrganizationRoles(memberRole),
      through: { kind: "membership" },
    });
  }
  for (const { memberRole, ...organization } of managedOrganizations) {
    if (accessById.has(organization.id)) {
      continue;
    }
    // The managing organization is one the user belongs to, so it was listed above.
    const managing = accessById.get(organization.managingOrganizationId!)!;
    accessById.set(organization.id, {
      organization,
      roles: managedRoles(splitOrganizationRoles(memberRole)),
      through: { kind: "managing-organization", organization: managing.organization },
    });
  }
  return [...accessById.values()];
}

/** How the user acts in one organization, or null when they do not. */
export async function findOrganizationAccess(
  database: Kysely<AuthDatabase>,
  input: { userId: string; organizationId: string },
): Promise<OrganizationAccess | null> {
  // The organization's own membership and its manager's, so a member of both acts as a member.
  const memberships = await database
    .selectFrom("organization")
    .innerJoin("member", (join) =>
      join.on((eb) =>
        eb.or([
          eb("member.organizationId", "=", eb.ref("organization.id")),
          eb("member.organizationId", "=", eb.ref("organization.managingOrganizationId")),
        ]),
      ),
    )
    .select(["member.organizationId", "member.role"])
    .where("organization.id", "=", input.organizationId)
    .where("member.userId", "=", input.userId)
    .execute();
  const membership = memberships.find(
    ({ organizationId }) => organizationId === input.organizationId,
  );
  if (membership) {
    return {
      organizationId: input.organizationId,
      roles: splitOrganizationRoles(membership.role),
      through: { kind: "membership" },
    };
  }
  const managing = memberships[0];
  return managing
    ? {
        organizationId: input.organizationId,
        roles: managedRoles(splitOrganizationRoles(managing.role)),
        through: { kind: "managing-organization", organizationId: managing.organizationId },
      }
    : null;
}

/**
 * The member, when the administrator owns or administers an organization the member belongs to,
 * or the organization that manages it.
 */
export async function findAdministeredMember(
  database: Kysely<AuthDatabase>,
  input: { administratorId: string; memberId: string },
): Promise<AdministeredMember | null> {
  // Joining reads only the organizations the member belongs to and the administrator's
  // memberships in them or their managers, however many each belongs to.
  const administrations = await database
    .selectFrom("member as administered")
    .innerJoin("organization", "organization.id", "administered.organizationId")
    .innerJoin("member as administrator", (join) =>
      join.on((eb) =>
        eb.or([
          eb("administrator.organizationId", "=", eb.ref("administered.organizationId")),
          eb("administrator.organizationId", "=", eb.ref("organization.managingOrganizationId")),
        ]),
      ),
    )
    .innerJoin("user", "user.id", "administered.userId")
    .select([
      "administrator.role",
      "administrator.organizationId as administratorOrganizationId",
      "organization.id as organizationId",
      "organization.name as organizationName",
      "organization.slug as organizationSlug",
      "user.id",
      "user.jurisdiction",
      "user.name",
      "user.email",
    ])
    .where("administrator.userId", "=", input.administratorId)
    .where("administered.userId", "=", input.memberId)
    // A personal workspace exists once its onboarding fixes where it is kept.
    .where("user.onboardedAt", "is not", null)
    .orderBy("organization.createdAt")
    .orderBy("organization.id")
    .execute();
  // Managing caps owners at admin, which still administers members.
  const administering = administrations.filter(({ role }) =>
    administersMembers(splitOrganizationRoles(role)),
  );
  // An organization both belong to names the relationship better than one reached by managing it.
  const administered =
    administering.find(
      ({ administratorOrganizationId, organizationId }) =>
        administratorOrganizationId === organizationId,
    ) ?? administering[0];
  return administered
    ? {
        userId: administered.id,
        jurisdiction: administered.jurisdiction,
        name: administered.name,
        email: administered.email,
        organization: {
          id: administered.organizationId,
          name: administered.organizationName,
          slug: administered.organizationSlug,
        },
      }
    : null;
}

/** The organization managing this one, or null when none does. */
export async function findManagingOrganization(
  database: Kysely<AuthDatabase>,
  organizationId: string,
): Promise<{ organizationId: string; name: string; slug: string } | null> {
  const managing = await database
    .selectFrom("organization")
    .innerJoin("organization as managing", "managing.id", "organization.managingOrganizationId")
    .select(["managing.id", "managing.name", "managing.slug"])
    .where("organization.id", "=", organizationId)
    .executeTakeFirst();
  return managing
    ? { organizationId: managing.id, name: managing.name, slug: managing.slug }
    : null;
}

/**
 * Three reads keyed by the organization, run together: its member count, the organization managing
 * it, and the organizations it manages with their member counts, ordered by name.
 */
export async function readOrganizationRelations(
  database: Kysely<AuthDatabase>,
  organizationId: string,
): Promise<OrganizationRelations> {
  const [members, managing, managed] = await Promise.all([
    database
      .selectFrom("member")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("organizationId", "=", organizationId)
      .executeTakeFirstOrThrow(),
    findManagingOrganization(database, organizationId),
    database
      .selectFrom("organization")
      .leftJoin("member", "member.organizationId", "organization.id")
      .select((eb) => [
        "organization.id",
        "organization.name",
        "organization.slug",
        "organization.createdAt",
        eb.fn.count<number>("member.id").as("memberCount"),
      ])
      .where("organization.managingOrganizationId", "=", organizationId)
      .groupBy("organization.id")
      .orderBy("organization.name")
      .orderBy("organization.id")
      .execute(),
  ]);
  return {
    memberCount: members.count,
    managingOrganization: managing,
    managedOrganizations: managed.map(
      (organization): ManagedOrganizationRecord => ({
        organizationId: organization.id,
        name: organization.name,
        slug: organization.slug,
        createdAt: toDate(organization.createdAt).toISOString(),
        memberCount: organization.memberCount,
      }),
    ),
  };
}
