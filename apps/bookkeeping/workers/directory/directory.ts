import type { OrganizationRole } from "@fragno-dev/backoffice-api/v0/organization";
import { DurableObject } from "cloudflare:workers";

import { applyMigrations } from "../migrations";
import directoryMigration from "./migrations/0001-directory.sql?raw";
import operatorsMigration from "./migrations/0002-operators.sql?raw";
import firmAgentsMigration from "./migrations/0003-firm-agents.sql?raw";
import firmAccessMigration from "./migrations/0004-firm-access.sql?raw";

/**
 * Operators run Bookkeeping; a firm keeps the books of its clients; a client is one business whose
 * books it keeps.
 */
export type OrganizationKind = "operator" | "firm" | "client";

/** A Backoffice organization Bookkeeping is installed in; clients name the firm that manages them. */
export type Organization = { id: string; slug: string; name: string } & (
  | { kind: "operator" }
  | { kind: "firm" }
  | { kind: "client"; firmId: string }
);

/** The organizations Bookkeeping creates; Backoffice's administrator creates the operators'. */
export type ProvisionedOrganization = Extract<Organization, { kind: "firm" | "client" }>;

/**
 * How someone reaches an organization: as one of its members, or as a member of the firm managing
 * it, with their role in the firm, owners as admins.
 */
export type MembershipThrough = "membership" | "firm";

/** Someone's membership, as Backoffice last confirmed it at `confirmedAt` (epoch milliseconds). */
export type Membership = {
  roles: OrganizationRole[];
  through: MembershipThrough;
  confirmedAt: number;
};

export type OrganizationMembership = Membership & { organization: Organization };

/** What Backoffice confirmed about one person in one organization. */
export type MembershipConfirmation = Membership & {
  /** The organization as Backoffice named it then. */
  organization: Pick<Organization, "id" | "slug" | "name">;
  /** The Backoffice user's ID. */
  userId: string;
};

/** An invitation Bookkeeping created in Backoffice, to an organization it knows. */
export type Invitation = {
  /** The Backoffice invitation's ID. */
  id: string;
  organization: Organization;
  email: string;
  roles: OrganizationRole[];
  /** The inviting person's name. */
  invitedBy: string;
  /** When Backoffice stops accepting it, in epoch milliseconds. */
  expiresAt: number;
};

/** The books of one business; `id` is its Backoffice project's, which names its books. */
export type Administration = { id: string; clientId: string; slug: string; name: string };

type OrganizationRow = {
  id: string;
  slug: string;
  name: string;
  kind: OrganizationKind;
  firmId: string | null;
};
type MembershipRow = OrganizationRow & {
  roles: string;
  through: MembershipThrough;
  confirmedAt: number;
};
type InvitationRow = OrganizationRow & {
  invitationId: string;
  email: string;
  roles: string;
  invitedBy: string;
  expiresAt: number;
};

const ORGANIZATION_COLUMNS = `o."id", o."slug", o."name", o."kind", o."firmId"`;
const MEMBERSHIP_QUERY = `SELECT ${ORGANIZATION_COLUMNS}, m."roles", m."through", m."confirmedAt"
  FROM "membership" m JOIN "organization" o ON o."id" = m."organizationId"`;
const INVITATION_QUERY = `SELECT ${ORGANIZATION_COLUMNS}, i."id" AS "invitationId", i."email",
    i."roles", i."invitedBy", i."expiresAt"
  FROM "invitation" i JOIN "organization" o ON o."id" = i."organizationId"`;

function toOrganization(row: OrganizationRow): Organization {
  const { id, slug, name } = row;
  // The table's CHECK constraint pairs every client with its firm.
  return row.kind === "client"
    ? { id, slug, name, kind: "client", firmId: row.firmId! }
    : { id, slug, name, kind: row.kind };
}

// Roles are written only from Backoffice responses, parsed at the edge.
function parseRoles(roles: string): OrganizationRole[] {
  return JSON.parse(roles) as OrganizationRole[];
}

function toMembership(row: MembershipRow): OrganizationMembership {
  return {
    organization: toOrganization(row),
    roles: parseRoles(row.roles),
    through: row.through,
    confirmedAt: row.confirmedAt,
  };
}

function toInvitation(row: InvitationRow): Invitation {
  return {
    id: row.invitationId,
    organization: toOrganization(row),
    email: row.email,
    roles: parseRoles(row.roles),
    invitedBy: row.invitedBy,
    expiresAt: row.expiresAt,
  };
}

/**
 * The organizations Bookkeeping knows, a read-only copy of their memberships, the invitations it
 * created, and its clients' administrations. Backoffice is authoritative: Bookkeeping records what
 * Backoffice confirms and forgets what Backoffice refuses.
 */
export class Directory extends DurableObject<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      applyMigrations(ctx, [
        directoryMigration,
        operatorsMigration,
        firmAgentsMigration,
        firmAccessMigration,
      ]);
    });
  }

  findOrganization(slug: string): Organization | null {
    const [row] = this.ctx.storage.sql
      .exec<OrganizationRow>(
        `SELECT ${ORGANIZATION_COLUMNS} FROM "organization" o WHERE o."slug" = ?`,
        slug,
      )
      .toArray();
    return row ? toOrganization(row) : null;
  }

  /** The operator organization, once an operator's membership was confirmed. */
  findOperators(id: string): Organization | null {
    const [row] = this.ctx.storage.sql
      .exec<OrganizationRow>(
        `SELECT ${ORGANIZATION_COLUMNS} FROM "organization" o
         WHERE o."id" = ? AND o."kind" = 'operator'`,
        id,
      )
      .toArray();
    return row ? toOrganization(row) : null;
  }

  findMembership(input: { organizationId: string; userId: string }): Membership | null {
    const [row] = this.ctx.storage.sql
      .exec<MembershipRow>(
        `${MEMBERSHIP_QUERY} WHERE m."organizationId" = ? AND m."userId" = ?`,
        input.organizationId,
        input.userId,
      )
      .toArray();
    return row
      ? { roles: parseRoles(row.roles), through: row.through, confirmedAt: row.confirmedAt }
      : null;
  }

  /**
   * The organizations the user belongs to: operators, then firms, then clients, by name. Clients
   * they reach through their firm are its, not theirs.
   */
  listMemberships(userId: string): OrganizationMembership[] {
    return this.ctx.storage.sql
      .exec<MembershipRow>(
        `${MEMBERSHIP_QUERY} WHERE m."userId" = ? AND m."through" = 'membership'
         ORDER BY CASE o."kind" WHEN 'operator' THEN 0 WHEN 'firm' THEN 1 ELSE 2 END,
           o."name", o."slug"`,
        userId,
      )
      .toArray()
      .map(toMembership);
  }

  /** Every firm Bookkeeping created, by name. */
  listFirms(): Organization[] {
    return this.ctx.storage.sql
      .exec<OrganizationRow>(
        `SELECT ${ORGANIZATION_COLUMNS} FROM "organization" o
         WHERE o."kind" = 'firm' ORDER BY o."name", o."slug"`,
      )
      .toArray()
      .map(toOrganization);
  }

  /** A firm's clients, by name. */
  listClients(firmId: string): Organization[] {
    return this.ctx.storage.sql
      .exec<OrganizationRow>(
        `SELECT ${ORGANIZATION_COLUMNS} FROM "organization" o
         WHERE o."firmId" = ? ORDER BY o."name", o."slug"`,
        firmId,
      )
      .toArray()
      .map(toOrganization);
  }

  /** What Bookkeeping tells Backoffice about one of its organizations. */
  describeOrganization(
    id: string,
  ): (Pick<Organization, "id" | "slug" | "name" | "kind"> & { memberCount: number }) | null {
    const [row] = this.ctx.storage.sql
      .exec<OrganizationRow & { memberCount: number }>(
        `SELECT ${ORGANIZATION_COLUMNS},
           (SELECT COUNT(*) FROM "membership" m
             WHERE m."organizationId" = o."id" AND m."through" = 'membership') AS "memberCount"
         FROM "organization" o WHERE o."id" = ?`,
        id,
      )
      .toArray();
    return row
      ? { id: row.id, slug: row.slug, name: row.name, kind: row.kind, memberCount: row.memberCount }
      : null;
  }

  /**
   * Records an organization Bookkeeping provisioned, with the owner Backoffice made of it, or none
   * while its owner is invited or when it already existed. Recording it again, after a retried
   * provisioning, keeps its kind and firm.
   */
  recordProvisioned(input: {
    organization: ProvisionedOrganization;
    ownerUserId: string | null;
  }): void {
    const { organization } = input;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO "organization" ("id", "slug", "name", "kind", "firmId")
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT ("id") DO UPDATE SET "slug" = excluded."slug", "name" = excluded."name"`,
        organization.id,
        organization.slug,
        organization.name,
        organization.kind,
        organization.kind === "client" ? organization.firmId : null,
      );
      if (input.ownerUserId !== null) {
        this.#recordMembership(organization.id, {
          userId: input.ownerUserId,
          roles: ["owner"],
          through: "membership",
          confirmedAt: Date.now(),
        });
      }
    });
  }

  /**
   * Records an operator's membership Backoffice confirmed. Bookkeeping learns of the operator
   * organization this way: Backoffice's administrator creates it, not Bookkeeping.
   */
  confirmOperator(confirmation: MembershipConfirmation): void {
    const { id, slug, name } = confirmation.organization;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO "organization" ("id", "slug", "name", "kind", "firmId")
         VALUES (?, ?, ?, 'operator', NULL)
         ON CONFLICT ("id") DO UPDATE SET "slug" = excluded."slug", "name" = excluded."name"`,
        id,
        slug,
        name,
      );
      this.#recordMembership(id, confirmation);
    });
  }

  /** Records what Backoffice confirmed about one person in an organization Bookkeeping knows. */
  confirmMembership(confirmation: MembershipConfirmation): void {
    this.ctx.storage.transactionSync(() => {
      this.#renameOrganization(confirmation.organization);
      this.#recordMembership(confirmation.organization.id, confirmation);
    });
  }

  /**
   * Replaces the copy of an organization's memberships with Backoffice's full list of its members,
   * confirmed at `confirmedAt`. Any member missing from it was removed; people reaching it through
   * its firm are not listed, and keep their own confirmation.
   */
  confirmMembers(input: {
    organizationId: string;
    members: Pick<MembershipConfirmation, "userId" | "roles">[];
    confirmedAt: number;
  }): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `DELETE FROM "membership" WHERE "organizationId" = ? AND "through" = 'membership'
         AND "userId" NOT IN (SELECT "value" FROM json_each(?))`,
        input.organizationId,
        JSON.stringify(input.members.map(({ userId }) => userId)),
      );
      for (const { userId, roles } of input.members) {
        this.#recordMembership(input.organizationId, {
          userId,
          roles,
          through: "membership",
          confirmedAt: input.confirmedAt,
        });
      }
    });
  }

  /**
   * Backoffice no longer lets the user into the organization: they were removed, or Bookkeeping
   * was uninstalled there.
   */
  removeMembership(input: { organizationId: string; userId: string }): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM "membership" WHERE "organizationId" = ? AND "userId" = ?`,
      input.organizationId,
      input.userId,
    );
  }

  /** Records an invitation Backoffice created; recording it again changes nothing. */
  addInvitation(input: Omit<Invitation, "organization"> & { organizationId: string }): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO "invitation" ("id", "organizationId", "email", "roles", "invitedBy", "expiresAt")
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT ("id") DO NOTHING`,
      input.id,
      input.organizationId,
      input.email,
      JSON.stringify(input.roles),
      input.invitedBy,
      input.expiresAt,
    );
  }

  findInvitation(id: string): Invitation | null {
    const [row] = this.ctx.storage.sql
      .exec<InvitationRow>(`${INVITATION_QUERY} WHERE i."id" = ?`, id)
      .toArray();
    return row ? toInvitation(row) : null;
  }

  /** The invitations Bookkeeping created to an organization, pending or not. */
  listInvitations(organizationId: string): Invitation[] {
    return this.ctx.storage.sql
      .exec<InvitationRow>(`${INVITATION_QUERY} WHERE i."organizationId" = ?`, organizationId)
      .toArray()
      .map(toInvitation);
  }

  /**
   * The unexpired invitations Bookkeeping created to `email`. Backoffice and Bookkeeping both keep
   * emails lowercased. Backoffice may have withdrawn one since; accepting it says so.
   */
  listInvitationsTo(email: string, now: number): Invitation[] {
    return this.ctx.storage.sql
      .exec<InvitationRow>(
        `${INVITATION_QUERY} WHERE i."email" = ? AND i."expiresAt" > ? ORDER BY i."expiresAt"`,
        email,
        now,
      )
      .toArray()
      .map(toInvitation);
  }

  /** It was accepted, or Backoffice no longer offers it. */
  removeInvitation(id: string): void {
    this.ctx.storage.sql.exec(`DELETE FROM "invitation" WHERE "id" = ?`, id);
  }

  /** Records an administration once its books are open; recording it again changes nothing. */
  recordAdministration(administration: Administration): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO "administration" ("id", "clientId", "slug", "name") VALUES (?, ?, ?, ?)
       ON CONFLICT ("id") DO NOTHING`,
      administration.id,
      administration.clientId,
      administration.slug,
      administration.name,
    );
  }

  /** The client's administrations, by name. */
  listAdministrations(clientId: string): Administration[] {
    return this.ctx.storage.sql
      .exec<Administration>(
        `SELECT "id", "clientId", "slug", "name" FROM "administration"
         WHERE "clientId" = ? ORDER BY "name", "slug"`,
        clientId,
      )
      .toArray();
  }

  /** The client's administration with this slug, or with this ID: its Backoffice project's. */
  findAdministration(
    input: { clientId: string } & ({ slug: string } | { id: string }),
  ): Administration | null {
    const [column, value] = "slug" in input ? ["slug", input.slug] : ["id", input.id];
    const [row] = this.ctx.storage.sql
      .exec<Administration>(
        `SELECT "id", "clientId", "slug", "name" FROM "administration"
         WHERE "clientId" = ? AND "${column}" = ?`,
        input.clientId,
        value,
      )
      .toArray();
    return row ?? null;
  }

  /**
   * The administration `id` of one of the firm's clients, or null when no client of the firm has
   * it: what the firm's bookkeeping agent may keep.
   */
  findFirmAdministration(input: { firmId: string; id: string }): Administration | null {
    const [row] = this.ctx.storage.sql
      .exec<Administration>(
        `SELECT a."id", a."clientId", a."slug", a."name" FROM "administration" a
         JOIN "organization" o ON o."id" = a."clientId"
         WHERE a."id" = ? AND o."firmId" = ?`,
        input.id,
        input.firmId,
      )
      .toArray();
    return row ?? null;
  }

  /** Records the project holding the firm's bookkeeping agent; recording it again changes nothing. */
  recordFirmAgent(input: { firmId: string; projectId: string }): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO "firm_agent" ("firmId", "projectId") VALUES (?, ?)
       ON CONFLICT ("firmId") DO NOTHING`,
      input.firmId,
      input.projectId,
    );
  }

  /** The ID of the project holding the firm's bookkeeping agent, once an owner or admin set it up. */
  findFirmAgent(firmId: string): string | null {
    const [row] = this.ctx.storage.sql
      .exec<{ projectId: string }>(
        `SELECT "projectId" FROM "firm_agent" WHERE "firmId" = ?`,
        firmId,
      )
      .toArray();
    return row?.projectId ?? null;
  }

  /** The project holding the bookkeeping agent of the firm managing the client, once set up. */
  findClientsFirmAgent(clientId: string): { firmId: string; projectId: string } | null {
    const [row] = this.ctx.storage.sql
      .exec<{ firmId: string; projectId: string }>(
        `SELECT a."firmId", a."projectId" FROM "organization" o
         JOIN "firm_agent" a ON a."firmId" = o."firmId" WHERE o."id" = ?`,
        clientId,
      )
      .toArray();
    return row ?? null;
  }

  #renameOrganization(organization: Pick<Organization, "id" | "slug" | "name">): void {
    this.ctx.storage.sql.exec(
      `UPDATE "organization" SET "slug" = ?, "name" = ? WHERE "id" = ?`,
      organization.slug,
      organization.name,
      organization.id,
    );
  }

  #recordMembership(
    organizationId: string,
    membership: Omit<MembershipConfirmation, "organization">,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO "membership" ("organizationId", "userId", "roles", "through", "confirmedAt")
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT ("organizationId", "userId") DO UPDATE SET "roles" = excluded."roles",
         "through" = excluded."through", "confirmedAt" = excluded."confirmedAt"`,
      organizationId,
      membership.userId,
      JSON.stringify(membership.roles),
      membership.through,
      membership.confirmedAt,
    );
  }
}
