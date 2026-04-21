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
        .addColumn("userId", referenceColumn({ table: "user" }))
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
      return t.addColumn(
        "activeOrganizationId",
        referenceColumn({ table: "organization" }).nullable(),
      );
    })
    .addTable("organization", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("slug", column("string"))
        .addColumn("logoUrl", column("string").nullable())
        .addColumn("metadata", column("json").nullable())
        .addColumn("createdBy", referenceColumn({ table: "user" }))
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
        .addColumn("organizationId", referenceColumn({ table: "organization" }))
        .addColumn("userId", referenceColumn({ table: "user" }))
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
        .addColumn("memberId", referenceColumn({ table: "organizationMember" }))
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
        .addColumn("organizationId", referenceColumn({ table: "organization" }))
        .addColumn("email", column("string"))
        .addColumn("roles", column("json"))
        .addColumn("status", column("string"))
        .addColumn("token", column("string"))
        .addColumn("inviterId", referenceColumn({ table: "user" }))
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
    .noOp("removed obsolete sessionOwner addReference history")
    .noOp("removed obsolete sessionActiveOrganization addReference history")
    .noOp("removed obsolete organizationCreator addReference history")
    .noOp("removed obsolete organizationMemberOrganization addReference history")
    .noOp("removed obsolete organizationMembers join-only relation history")
    .noOp("removed obsolete organizationMemberUser addReference history")
    .noOp("removed obsolete organizationMemberRoleMember addReference history")
    .noOp("removed obsolete organizationInvitationOrganization addReference history")
    .noOp("removed obsolete organizationInvitationInviter addReference history")
    .addTable("oauthAccount", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("userId", referenceColumn({ table: "user" }))
        .addColumn("provider", column("string"))
        .addColumn("providerAccountId", column("string"))
        .addColumn("email", column("string").nullable())
        .addColumn("emailVerified", column("bool").defaultTo(false))
        .addColumn("image", column("string").nullable())
        .addColumn("accessToken", column("string").nullable())
        .addColumn("refreshToken", column("string").nullable())
        .addColumn("idToken", column("string").nullable())
        .addColumn("tokenType", column("string").nullable())
        .addColumn("tokenExpiresAt", column("timestamp").nullable())
        .addColumn("scopes", column("json").nullable())
        .addColumn("rawProfile", column("json").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_oauth_account_provider_account", ["provider", "providerAccountId"], {
          unique: true,
        })
        .createIndex("idx_oauth_account_user", ["userId"])
        .createIndex("idx_oauth_account_provider", ["provider"]);
    })
    .addTable("oauthState", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("provider", column("string"))
        .addColumn("state", column("string"))
        .addColumn("codeVerifier", column("string").nullable())
        .addColumn("redirectUri", column("string").nullable())
        .addColumn("returnTo", column("string").nullable())
        .addColumn("linkUserId", referenceColumn({ table: "user" }).nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn("expiresAt", column("timestamp"))
        .createIndex("idx_oauth_state_state", ["state"], { unique: true })
        .createIndex("idx_oauth_state_provider", ["provider"])
        .createIndex("idx_oauth_state_expiresAt", ["expiresAt"]);
    })
    .noOp("removed obsolete oauthAccountUser addReference history")
    .noOp("removed obsolete oauthStateLinkUser addReference history")
    .alterTable("user", (t) => {
      return t.alterColumn("passwordHash").nullable();
    })
    .noOp("removed obsolete sessionOrganizationMembers join-only relation history")
    .noOp("removed obsolete sessionMembers join-only relation history")
    .noOp("removed obsolete organizationMemberRoles join-only relation history")
    .noOp("removed obsolete roles join-only relation history")
    .noOp("removed obsolete organizationMember.organization join-only relation history")
    .noOp("removed obsolete userOrganizationInvitations join-only relation history")
    .noOp("removed obsolete invitations join-only relation history")
    .noOp("removed obsolete organizationInvitation.organization join-only relation history")
    .alterTable("session", (t) => {
      return t.createIndex("idx_session_id_expiresAt", ["id", "expiresAt"]);
    })
    .noOp("removed obsolete userOrganizationMembers join-only relation history")
    .alterTable("oauthState", (t) => {
      return t.addColumn("sessionSeed", column("json").nullable());
    });
});
