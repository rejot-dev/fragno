import type { OrganizationRole } from "@fragno-dev/backoffice-api/v0/organization";
import { DurableObject } from "cloudflare:workers";

import { applyMigrations } from "../migrations";
import workspacesMigration from "./migrations/0001-workspaces.sql?raw";
import administrationsMigration from "./migrations/0002-administrations.sql?raw";

export type WorkspaceRole = OrganizationRole;

/** A Backoffice organization Bookkeeping is installed in. */
export type Workspace = { id: string; slug: string; name: string };

export type WorkspaceMember = {
  /** The Backoffice user's ID. */
  userId: string;
  name: string;
  email: string;
  roles: WorkspaceRole[];
};

/** A user's membership, as Backoffice last confirmed it at `confirmedAt` (epoch milliseconds). */
export type WorkspaceMembership = {
  workspace: Workspace;
  roles: WorkspaceRole[];
  confirmedAt: number;
};

/** The books of one business in a workspace; `id` is its Backoffice project's, which names its books. */
export type Administration = { id: string; workspaceId: string; slug: string; name: string };

export type WorkspaceInvitation = {
  /** The Backoffice invitation's ID. */
  id: string;
  workspace: Workspace;
  email: string;
  roles: WorkspaceRole[];
  invitedBy: string;
  expiresAt: number;
};

type MembershipRow = { id: string; slug: string; name: string; roles: string; confirmedAt: number };
type InvitationRow = {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  email: string;
  roles: string;
  invitedBy: string;
  expiresAt: number;
};

// Roles are written only from Backoffice responses parsed at the edge.
function parseRoles(roles: string): WorkspaceRole[] {
  return roles.split(",") as WorkspaceRole[];
}

function toMembership(row: MembershipRow): WorkspaceMembership {
  return {
    workspace: { id: row.id, slug: row.slug, name: row.name },
    roles: parseRoles(row.roles),
    confirmedAt: row.confirmedAt,
  };
}

function toInvitation(row: InvitationRow): WorkspaceInvitation {
  return {
    id: row.id,
    workspace: { id: row.workspaceId, slug: row.slug, name: row.name },
    email: row.email,
    roles: parseRoles(row.roles),
    invitedBy: row.invitedBy,
    expiresAt: row.expiresAt,
  };
}

/**
 * Bookkeeping's read-only copy of its Backoffice organizations, their members, and the
 * invitations it sent. Backoffice is authoritative: Bookkeeping records what Backoffice confirms
 * and removes what Backoffice refuses.
 */
export class Workspaces extends DurableObject<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      applyMigrations(ctx, [workspacesMigration, administrationsMigration]);
    });
  }

  /** The workspaces the user belongs to, by name. */
  listMemberships(userId: string): WorkspaceMembership[] {
    return this.ctx.storage.sql
      .exec<MembershipRow>(
        `SELECT w."id", w."slug", w."name", m."roles", m."confirmedAt"
         FROM "workspace_member" m JOIN "workspace" w ON w."id" = m."workspaceId"
         WHERE m."userId" = ?
         ORDER BY w."name", w."slug"`,
        userId,
      )
      .toArray()
      .map(toMembership);
  }

  findMembership(input: { slug: string; userId: string }): WorkspaceMembership | null {
    const [row] = this.ctx.storage.sql
      .exec<MembershipRow>(
        `SELECT w."id", w."slug", w."name", m."roles", m."confirmedAt"
         FROM "workspace_member" m JOIN "workspace" w ON w."id" = m."workspaceId"
         WHERE w."slug" = ? AND m."userId" = ?`,
        input.slug,
        input.userId,
      )
      .toArray();
    return row ? toMembership(row) : null;
  }

  findWorkspace(slug: string): Workspace | null {
    const [row] = this.ctx.storage.sql
      .exec<Workspace>(`SELECT "id", "slug", "name" FROM "workspace" WHERE "slug" = ?`, slug)
      .toArray();
    return row ?? null;
  }

  /** What Bookkeeping tells Backoffice about a workspace. */
  describeWorkspace(id: string): (Workspace & { memberCount: number }) | null {
    const [row] = this.ctx.storage.sql
      .exec<Workspace & { memberCount: number }>(
        `SELECT w."id", w."slug", w."name",
           (SELECT COUNT(*) FROM "workspace_member" m WHERE m."workspaceId" = w."id") AS "memberCount"
         FROM "workspace" w WHERE w."id" = ?`,
        id,
      )
      .toArray();
    return row ?? null;
  }

  /** Records a membership Backoffice confirmed, with the workspace as Backoffice named it then. */
  recordMembership(input: {
    workspace: Workspace;
    member: WorkspaceMember;
    confirmedAt: number;
  }): void {
    this.ctx.storage.transactionSync(() => {
      this.#recordWorkspace(input.workspace);
      this.#recordMember(input.workspace.id, input.member, input.confirmedAt);
    });
  }

  /** Makes the copy's members exactly those Backoffice listed. */
  replaceMembers(input: {
    workspace: Workspace;
    members: WorkspaceMember[];
    confirmedAt: number;
  }): void {
    this.ctx.storage.transactionSync(() => {
      this.#recordWorkspace(input.workspace);
      this.ctx.storage.sql.exec(
        `DELETE FROM "workspace_member" WHERE "workspaceId" = ?`,
        input.workspace.id,
      );
      for (const member of input.members) {
        this.#recordMember(input.workspace.id, member, input.confirmedAt);
      }
    });
  }

  /**
   * Backoffice no longer lets the user into the workspace: they were removed, or Bookkeeping was
   * uninstalled there.
   */
  removeMembership(input: { workspaceId: string; userId: string }): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM "workspace_member" WHERE "workspaceId" = ? AND "userId" = ?`,
      input.workspaceId,
      input.userId,
    );
  }

  listMembers(workspaceId: string): WorkspaceMember[] {
    return this.ctx.storage.sql
      .exec<{ userId: string; name: string; email: string; roles: string }>(
        `SELECT "userId", "name", "email", "roles" FROM "workspace_member"
         WHERE "workspaceId" = ? ORDER BY "email"`,
        workspaceId,
      )
      .toArray()
      .map((row) => ({ ...row, roles: parseRoles(row.roles) }));
  }

  /** Records an administration once its books are open; recording it again changes nothing. */
  recordAdministration(administration: Administration): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO "administration" ("id", "workspaceId", "slug", "name") VALUES (?, ?, ?, ?)
       ON CONFLICT ("id") DO NOTHING`,
      administration.id,
      administration.workspaceId,
      administration.slug,
      administration.name,
    );
  }

  /** The workspace's administrations, by name. */
  listAdministrations(workspaceId: string): Administration[] {
    return this.ctx.storage.sql
      .exec<Administration>(
        `SELECT "id", "workspaceId", "slug", "name" FROM "administration"
         WHERE "workspaceId" = ? ORDER BY "name", "slug"`,
        workspaceId,
      )
      .toArray();
  }

  findAdministration(input: { workspaceId: string; slug: string }): Administration | null {
    const [row] = this.ctx.storage.sql
      .exec<Administration>(
        `SELECT "id", "workspaceId", "slug", "name" FROM "administration"
         WHERE "workspaceId" = ? AND "slug" = ?`,
        input.workspaceId,
        input.slug,
      )
      .toArray();
    return row ?? null;
  }

  addInvitation(input: Omit<WorkspaceInvitation, "workspace"> & { workspaceId: string }): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO "workspace_invitation"
         ("id", "workspaceId", "email", "roles", "invitedBy", "expiresAt")
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.id,
      input.workspaceId,
      input.email,
      input.roles.join(","),
      input.invitedBy,
      input.expiresAt,
    );
  }

  findInvitation(id: string): WorkspaceInvitation | null {
    const [row] = this.ctx.storage.sql
      .exec<InvitationRow>(`${INVITATION_QUERY} WHERE i."id" = ?`, id)
      .toArray();
    return row ? toInvitation(row) : null;
  }

  /** Invitations not yet accepted and not expired at `now`, newest last. */
  listInvitations(input: { workspaceId: string; now: number }): WorkspaceInvitation[] {
    return this.ctx.storage.sql
      .exec<InvitationRow>(
        `${INVITATION_QUERY} WHERE i."workspaceId" = ? AND i."expiresAt" > ? ORDER BY i."expiresAt"`,
        input.workspaceId,
        input.now,
      )
      .toArray()
      .map(toInvitation);
  }

  removeInvitation(id: string): void {
    this.ctx.storage.sql.exec(`DELETE FROM "workspace_invitation" WHERE "id" = ?`, id);
  }

  #recordWorkspace(workspace: Workspace): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO "workspace" ("id", "slug", "name") VALUES (?, ?, ?)
       ON CONFLICT ("id") DO UPDATE SET "slug" = excluded."slug", "name" = excluded."name"`,
      workspace.id,
      workspace.slug,
      workspace.name,
    );
  }

  #recordMember(workspaceId: string, member: WorkspaceMember, confirmedAt: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO "workspace_member"
         ("workspaceId", "userId", "name", "email", "roles", "confirmedAt")
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT ("workspaceId", "userId") DO UPDATE SET "name" = excluded."name",
         "email" = excluded."email", "roles" = excluded."roles",
         "confirmedAt" = excluded."confirmedAt"`,
      workspaceId,
      member.userId,
      member.name,
      member.email,
      member.roles.join(","),
      confirmedAt,
    );
  }
}

const INVITATION_QUERY = `SELECT i."id", i."workspaceId", w."slug", w."name", i."email", i."roles",
    i."invitedBy", i."expiresAt"
  FROM "workspace_invitation" i JOIN "workspace" w ON w."id" = i."workspaceId"`;
