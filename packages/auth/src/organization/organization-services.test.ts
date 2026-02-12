import { afterAll, describe, expect, it } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import { authFragmentDefinition } from "..";
import { hashPassword } from "../user/password";

describe("organization services", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment("auth", instantiate(authFragmentDefinition))
    .build();

  const fragment = fragments.auth;

  const createUser = async (email: string) => {
    const passwordHash = await hashPassword("password");
    const [user] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.createUser(email, passwordHash)])
        .execute();
    });
    return user;
  };

  afterAll(async () => {
    await test.cleanup();
  });

  it("creates organization with creator roles", async () => {
    const user = await createUser("owner@test.com");

    const [result] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Acme Inc",
            slug: "acme-inc",
            creatorUserId: user.id,
            creatorUserRole: user.role,
            creatorRoles: ["owner", "admin"],
          }),
        ])
        .execute();
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.organization.slug).toBe("acme-inc");
    expect(result.member.roles).toEqual(["owner", "admin"]);

    const [membersResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.listOrganizationMembers({
            organizationId: result.organization.id,
            pageSize: 10,
          }),
        ])
        .execute();
    });

    expect(membersResult.members).toHaveLength(1);

    const [rolesResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.listOrganizationMemberRoles(result.member.id)])
        .execute();
    });

    expect(rolesResult.roles).toEqual(["owner", "admin"]);
  });

  it("rejects duplicate organization slug", async () => {
    const user = await createUser("dupe@test.com");

    const [first] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Dupe Org",
            slug: "dupe-org",
            creatorUserId: user.id,
            creatorUserRole: user.role,
          }),
        ])
        .execute();
    });

    expect(first.ok).toBe(true);

    const [second] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Dupe Org Two",
            slug: "dupe-org",
            creatorUserId: user.id,
            creatorUserRole: user.role,
          }),
        ])
        .execute();
    });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("organization_slug_taken");
    }
  });

  it("updates member roles", async () => {
    const owner = await createUser("roles-owner@test.com");
    const memberUser = await createUser("roles-member@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Roles Org",
            slug: "roles-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    if (!organizationResult.ok) {
      throw new Error("Failed to create organization for roles test");
    }

    const [memberResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationMember({
            organizationId: organizationResult.organization.id,
            userId: memberUser.id,
            roles: ["member"],
            actor: { userId: owner.id, userRole: owner.role },
          }),
        ])
        .execute();
    });

    if (!memberResult.ok) {
      throw new Error("Failed to create member for roles test");
    }

    const [updated] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.updateOrganizationMemberRoles({
            organizationId: organizationResult.organization.id,
            memberId: memberResult.member.id,
            roles: ["admin", "member"],
            actor: { userId: owner.id, userRole: owner.role },
          }),
        ])
        .execute();
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) {
      return;
    }

    expect(updated.member.roles).toEqual(["admin", "member"]);

    const [rolesResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.listOrganizationMemberRoles(memberResult.member.id),
        ])
        .execute();
    });

    expect(rolesResult.roles).toEqual(["admin", "member"]);
  });

  it("rejects organization updates by non-admin members", async () => {
    const owner = await createUser("update-owner@test.com");
    const memberUser = await createUser("update-member@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Update Org",
            slug: "update-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    if (!organizationResult.ok) {
      throw new Error("Failed to create organization for update test");
    }

    const [memberResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationMember({
            organizationId: organizationResult.organization.id,
            userId: memberUser.id,
            roles: ["member"],
            actor: { userId: owner.id, userRole: owner.role },
          }),
        ])
        .execute();
    });

    if (!memberResult.ok) {
      throw new Error("Failed to create member for update test");
    }

    const [result] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.updateOrganization(
            organizationResult.organization.id,
            { name: "Updated Org" },
            { userId: memberUser.id, userRole: memberUser.role },
          ),
        ])
        .execute();
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("permission_denied");
    }
  });

  it("prevents demoting the last owner", async () => {
    const owner = await createUser("last-owner@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Last Owner Org",
            slug: "last-owner-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    if (!organizationResult.ok) {
      throw new Error("Failed to create organization for last owner test");
    }

    const [result] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.updateOrganizationMemberRoles({
            organizationId: organizationResult.organization.id,
            memberId: organizationResult.member.id,
            roles: ["member"],
            actor: { userId: owner.id, userRole: owner.role },
          }),
        ])
        .execute();
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("last_owner");
    }
  });

  it("accepts invitations and creates memberships", async () => {
    const owner = await createUser("invite-owner@test.com");
    const invitedUser = await createUser("invitee@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Invite Org",
            slug: "invite-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    if (!organizationResult.ok) {
      throw new Error("Failed to create organization for invitation test");
    }

    const [invitationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationInvitation({
            organizationId: organizationResult.organization.id,
            email: invitedUser.email,
            inviterId: owner.id,
            roles: ["member"],
            actor: { userId: owner.id, userRole: owner.role },
          }),
        ])
        .execute();
    });

    if (!invitationResult.ok) {
      throw new Error("Failed to create invitation");
    }

    const [accepted] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.respondToOrganizationInvitation({
            invitationId: invitationResult.invitation.id,
            action: "accept",
            token: invitationResult.invitation.token,
            actor: { userId: invitedUser.id, userRole: invitedUser.role },
            organizationId: invitationResult.invitation.organizationId,
          }),
        ])
        .execute();
    });

    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.invitation.status).toBe("accepted");
    }
  });

  it("auto-creates organization on sign up", async () => {
    const passwordHash = await hashPassword("password");

    const [signUpResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.signUpWithSession("auto-org@test.com", passwordHash, {
            autoCreateOrganization: {
              name: ({ email }) => `${email.split("@")[0]}'s Workspace`,
              slug: ({ email }) => `${email.split("@")[0]}-workspace`,
            },
          }),
        ])
        .execute();
    });

    if (!signUpResult.ok) {
      throw new Error("Expected sign up to succeed");
    }

    const [orgsResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.getOrganizationsForUser({
            userId: signUpResult.userId,
            pageSize: 10,
          }),
        ])
        .execute();
    });

    expect(orgsResult.organizations).toHaveLength(1);
    expect(orgsResult.organizations[0]?.organization.slug).toBe("auto-org-workspace");

    const [activeOrg] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.getActiveOrganization(signUpResult.sessionId)])
        .execute();
    });

    expect(activeOrg.organizationId).toBe(orgsResult.organizations[0]?.organization.id ?? null);
  });

  it("paginates organizations for a user", async () => {
    const owner = await createUser("paginate-owner@test.com");

    const [firstOrg] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Page Org One",
            slug: "page-org-one",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    const [secondOrg] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Page Org Two",
            slug: "page-org-two",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    expect(firstOrg.ok).toBe(true);
    expect(secondOrg.ok).toBe(true);

    const [firstPage] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.getOrganizationsForUser({
            userId: owner.id,
            pageSize: 1,
          }),
        ])
        .execute();
    });

    expect(firstPage.organizations).toHaveLength(1);
    expect(firstPage.hasNextPage).toBe(true);
    expect(firstPage.cursor).toBeTruthy();
  });

  it("paginates organization members", async () => {
    const owner = await createUser("members-owner@test.com");
    const memberOne = await createUser("members-one@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Members Org",
            slug: "members-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    if (!organizationResult.ok) {
      throw new Error("Failed to create organization for member pagination test");
    }

    const [memberResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationMember({
            organizationId: organizationResult.organization.id,
            userId: memberOne.id,
            roles: ["member"],
            actor: { userId: owner.id, userRole: owner.role },
          }),
        ])
        .execute();
    });

    expect(memberResult.ok).toBe(true);

    const [firstPage] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.listOrganizationMembers({
            organizationId: organizationResult.organization.id,
            pageSize: 1,
          }),
        ])
        .execute();
    });

    expect(firstPage.members).toHaveLength(1);
    expect(firstPage.hasNextPage).toBe(true);
    expect(firstPage.cursor).toBeTruthy();
  });

  it("lists invitations for org and user", async () => {
    const owner = await createUser("invite-list-owner@test.com");
    const invitedUser = await createUser("invite-list-user@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Invite List Org",
            slug: "invite-list-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    if (!organizationResult.ok) {
      throw new Error("Failed to create organization for invitation list test");
    }

    const [invitationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationInvitation({
            organizationId: organizationResult.organization.id,
            email: invitedUser.email,
            inviterId: owner.id,
            roles: ["member"],
            actor: { userId: owner.id, userRole: owner.role },
          }),
        ])
        .execute();
    });

    expect(invitationResult.ok).toBe(true);

    const [orgInvites] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.listOrganizationInvitations({
            organizationId: organizationResult.organization.id,
          }),
        ])
        .execute();
    });

    expect(orgInvites.invitations).toHaveLength(1);
    expect(orgInvites.invitations[0]?.email).toBe(invitedUser.email);

    const [userInvites] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.listOrganizationInvitationsForUser(invitedUser.email),
        ])
        .execute();
    });

    expect(userInvites.invitations).toHaveLength(1);
    expect(userInvites.invitations[0]?.invitation.email).toBe(invitedUser.email);
    expect(userInvites.invitations[0]?.organization?.id).toBe(organizationResult.organization.id);
  });

  it("removes members from organizations", async () => {
    const owner = await createUser("remove-owner@test.com");
    const memberUser = await createUser("remove-member@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Remove Org",
            slug: "remove-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    if (!organizationResult.ok) {
      throw new Error("Failed to create organization for removal test");
    }

    const [memberResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationMember({
            organizationId: organizationResult.organization.id,
            userId: memberUser.id,
            roles: ["member"],
            actor: { userId: owner.id, userRole: owner.role },
          }),
        ])
        .execute();
    });

    if (!memberResult.ok) {
      throw new Error("Failed to create member for removal test");
    }

    const [removeResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.removeOrganizationMember({
            organizationId: organizationResult.organization.id,
            memberId: memberResult.member.id,
            actor: { userId: owner.id, userRole: owner.role },
          }),
        ])
        .execute();
    });

    expect(removeResult.ok).toBe(true);

    const [membersResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.listOrganizationMembers({
            organizationId: organizationResult.organization.id,
            pageSize: 10,
          }),
        ])
        .execute();
    });

    const remainingUserIds = membersResult.members.map((member) => member.userId);
    expect(remainingUserIds).not.toContain(memberUser.id);
  });
});

describe("organization service limits", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition).withConfig({
        organizations: {
          limits: {
            organizationsPerUser: 1,
            membersPerOrganization: 1,
            invitationsPerOrganization: 1,
          },
        },
      }),
    )
    .build();

  const fragment = fragments.auth;

  const createUser = async (email: string) => {
    const passwordHash = await hashPassword("password");
    const [user] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.createUser(email, passwordHash)])
        .execute();
    });
    return user;
  };

  afterAll(async () => {
    await test.cleanup();
  });

  it("enforces organization and member limits", async () => {
    const owner = await createUser("limits-owner@test.com");
    const member = await createUser("limits-member@test.com");

    const [firstOrg] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Limits Org",
            slug: "limits-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    expect(firstOrg.ok).toBe(true);

    const [secondOrg] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Limits Org Two",
            slug: "limits-org-two",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    expect(secondOrg.ok).toBe(false);
    if (!secondOrg.ok) {
      expect(secondOrg.code).toBe("limit_reached");
    }

    if (!firstOrg.ok) {
      throw new Error("Expected first organization to be created");
    }

    const [memberResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationMember({
            organizationId: firstOrg.organization.id,
            userId: member.id,
            roles: ["member"],
            actor: { userId: owner.id, userRole: owner.role },
          }),
        ])
        .execute();
    });

    expect(memberResult.ok).toBe(false);
    if (!memberResult.ok) {
      expect(memberResult.code).toBe("limit_reached");
    }
  });

  it("enforces invitation limits", async () => {
    const owner = await createUser("invite-limit-owner@test.com");

    const [orgResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Invite Limit Org",
            slug: "invite-limit-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    if (!orgResult.ok) {
      throw new Error("Expected organization to be created");
    }

    const [firstInvite] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationInvitation({
            organizationId: orgResult.organization.id,
            email: "invitee-1@test.com",
            inviterId: owner.id,
            actor: { userId: owner.id, userRole: owner.role },
          }),
        ])
        .execute();
    });

    expect(firstInvite.ok).toBe(true);

    const [secondInvite] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationInvitation({
            organizationId: orgResult.organization.id,
            email: "invitee-2@test.com",
            inviterId: owner.id,
            actor: { userId: owner.id, userRole: owner.role },
          }),
        ])
        .execute();
    });

    expect(secondInvite.ok).toBe(false);
    if (!secondInvite.ok) {
      expect(secondInvite.code).toBe("limit_reached");
    }
  });
});
