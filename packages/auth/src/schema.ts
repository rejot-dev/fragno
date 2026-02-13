import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

export const authSchema = schema("auth", (s) => {
  return s
    .addTable("user", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("email", column("string"))
        .addColumn("passwordHash", column("string"))
        .addColumn("role", column("string").defaultTo("user"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_user_email", ["email"])
        .createIndex("idx_user_id", ["id"], { unique: true });
    })
    .addTable("session", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("userId", referenceColumn())
        .addColumn("expiresAt", column("timestamp"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_session_user", ["userId"]);
    })
    .alterTable("user", (t) => {
      return t
        .addColumn("bannedAt", column("timestamp").nullable())
        .createIndex("idx_user_createdAt", ["createdAt"]);
    })
    .alterTable("session", (t) => {
      return t.addColumn("activeOrganizationId", referenceColumn().nullable());
    })
    .addTable("organization", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("slug", column("string"))
        .addColumn("logoUrl", column("string").nullable())
        .addColumn("metadata", column("json").nullable())
        .addColumn("createdBy", referenceColumn())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn("deletedAt", column("timestamp").nullable())
        .createIndex("idx_organization_slug", ["slug"], { unique: true })
        .createIndex("idx_organization_createdBy", ["createdBy"]);
    })
    .addTable("organizationMember", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("organizationId", referenceColumn())
        .addColumn("userId", referenceColumn())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_org_member_org_user", ["organizationId", "userId"], {
          unique: true,
        })
        .createIndex("idx_org_member_user", ["userId"])
        .createIndex("idx_org_member_org", ["organizationId"]);
    })
    .addTable("organizationMemberRole", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("memberId", referenceColumn())
        .addColumn("role", column("string"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_org_member_role_member_role", ["memberId", "role"], {
          unique: true,
        })
        .createIndex("idx_org_member_role_member", ["memberId"])
        .createIndex("idx_org_member_role_role", ["role"]);
    })
    .addTable("organizationInvitation", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("organizationId", referenceColumn())
        .addColumn("email", column("string"))
        .addColumn("roles", column("json"))
        .addColumn("status", column("string"))
        .addColumn("token", column("string"))
        .addColumn("inviterId", referenceColumn())
        .addColumn("expiresAt", column("timestamp"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn("respondedAt", column("timestamp").nullable())
        .createIndex("idx_org_invitation_token", ["token"], { unique: true })
        .createIndex("idx_org_invitation_org_status", ["organizationId", "status"])
        .createIndex("idx_org_invitation_email", ["email"])
        .createIndex("idx_org_invitation_email_status", ["email", "status"]);
    })
    .addReference("sessionOwner", {
      from: {
        table: "session",
        column: "userId",
      },
      to: {
        table: "user",
        column: "id",
      },
      type: "one",
    })
    .addReference("sessionActiveOrganization", {
      from: {
        table: "session",
        column: "activeOrganizationId",
      },
      to: {
        table: "organization",
        column: "id",
      },
      type: "one",
    })
    .addReference("organizationCreator", {
      from: {
        table: "organization",
        column: "createdBy",
      },
      to: {
        table: "user",
        column: "id",
      },
      type: "one",
    })
    .addReference("organizationMemberOrganization", {
      from: {
        table: "organizationMember",
        column: "organizationId",
      },
      to: {
        table: "organization",
        column: "id",
      },
      type: "one",
    })
    .addReference("organizationMemberUser", {
      from: {
        table: "organizationMember",
        column: "userId",
      },
      to: {
        table: "user",
        column: "id",
      },
      type: "one",
    })
    .addReference("organizationMemberRoleMember", {
      from: {
        table: "organizationMemberRole",
        column: "memberId",
      },
      to: {
        table: "organizationMember",
        column: "id",
      },
      type: "one",
    })
    .addReference("organizationInvitationOrganization", {
      from: {
        table: "organizationInvitation",
        column: "organizationId",
      },
      to: {
        table: "organization",
        column: "id",
      },
      type: "one",
    })
    .addReference("organizationInvitationInviter", {
      from: {
        table: "organizationInvitation",
        column: "inviterId",
      },
      to: {
        table: "user",
        column: "id",
      },
      type: "one",
    });
});
