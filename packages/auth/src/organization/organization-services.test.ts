import { afterAll, assert, describe, expect, it } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { getInternalFragment } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { authFragmentDefinition } from "..";
import { authSchema } from "../schema";
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
        .withServiceCalls(() => [fragment.services.createUserUnvalidated(email, passwordHash)])
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

  it("allows updating organization with the same slug", async () => {
    const user = await createUser("same-slug@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Stable Org",
            slug: "stable-org",
            creatorUserId: user.id,
            creatorUserRole: user.role,
          }),
        ])
        .execute();
    });

    assert(organizationResult.ok);

    const [updateResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.updateOrganization(
            organizationResult.organization.id,
            { slug: "stable-org" },
            { userId: user.id, userRole: user.role },
          ),
        ])
        .execute();
    });

    expect(updateResult.ok).toBe(true);
    if (!updateResult.ok) {
      return;
    }
    expect(updateResult.organization.slug).toBe("stable-org");
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

  it("guards direct member role mutations", async () => {
    const owner = await createUser("role-guard-owner@test.com");
    const memberUser = await createUser("role-guard-member@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Role Guard Org",
            slug: "role-guard-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    expect(organizationResult.ok).toBe(true);
    if (!organizationResult.ok) {
      return;
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

    expect(memberResult.ok).toBe(true);
    if (!memberResult.ok) {
      return;
    }

    const [denied] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationMemberRole({
            organizationId: organizationResult.organization.id,
            memberId: memberResult.member.id,
            role: "admin",
            actor: { userId: memberUser.id, userRole: memberUser.role },
          }),
        ])
        .execute();
    });

    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.code).toBe("permission_denied");
    }

    const [added] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationMemberRole({
            organizationId: organizationResult.organization.id,
            memberId: memberResult.member.id,
            role: "admin",
            actor: { userId: owner.id, userRole: owner.role },
          }),
        ])
        .execute();
    });

    expect(added.ok).toBe(true);

    const [addedAgain] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationMemberRole({
            organizationId: organizationResult.organization.id,
            memberId: memberResult.member.id,
            role: "admin",
            actor: { userId: owner.id, userRole: owner.role },
          }),
        ])
        .execute();
    });

    expect(addedAgain.ok).toBe(true);

    const [rolesAfterAdd] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.listOrganizationMemberRoles(memberResult.member.id),
        ])
        .execute();
    });

    expect(rolesAfterAdd.roles).toEqual(expect.arrayContaining(["member", "admin"]));

    const [removed] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.removeOrganizationMemberRole({
            organizationId: organizationResult.organization.id,
            memberId: memberResult.member.id,
            role: "admin",
            actor: { userId: owner.id, userRole: owner.role },
          }),
        ])
        .execute();
    });

    expect(removed.ok).toBe(true);

    const [rolesAfterRemove] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.listOrganizationMemberRoles(memberResult.member.id),
        ])
        .execute();
    });

    expect(rolesAfterRemove.roles).toEqual(["member"]);

    const [lastOwner] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.removeOrganizationMemberRole({
            organizationId: organizationResult.organization.id,
            memberId: organizationResult.member.id,
            role: "owner",
            actor: { userId: owner.id, userRole: owner.role },
          }),
        ])
        .execute();
    });

    expect(lastOwner.ok).toBe(false);
    if (!lastOwner.ok) {
      expect(lastOwner.code).toBe("last_owner");
    }
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
            actorMemberId: organizationResult.member.id,
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

  it("avoids unbounded member scans when resolving active organizations", async () => {
    const txResult = await test.inContext(function () {
      return fragment.services.getActiveOrganizationForSession({
        sessionId: "inactive-session",
      });
    });

    const typedUow = txResult._internal.typedUow;
    if (!typedUow) {
      throw new Error("Expected typed unit of work for getActiveOrganizationForSession");
    }

    const operations = typedUow.getRetrievalOperations();
    const hasUnboundedMemberScan = operations.some(
      (operation) =>
        operation.type === "find" &&
        operation.table.name === "organizationMember" &&
        operation.indexName === "primary" &&
        !operation.options.where,
    );

    expect(hasUnboundedMemberScan).toBe(false);
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

    assert(firstOrg.ok);
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
            actorMemberId: organizationResult.member.id,
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
          fragment.services.listOrganizationInvitationsForUser({
            email: invitedUser.email,
          }),
        ])
        .execute();
    });

    expect(userInvites.invitations).toHaveLength(1);
    expect(userInvites.invitations[0]?.invitation.email).toBe(invitedUser.email);
    expect(userInvites.invitations[0]?.organization?.id).toBe(organizationResult.organization.id);
  });

  it("resends pending invitations for the same email with updated roles and token", async () => {
    const owner = await createUser("invite-resend-owner@test.com");
    const invitedUser = await createUser("invite-resend-user@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Invite Resend Org",
            slug: "invite-resend-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    assert(organizationResult.ok);

    const [firstInvite] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationInvitation({
            organizationId: organizationResult.organization.id,
            email: invitedUser.email,
            inviterId: owner.id,
            roles: ["member"],
            actor: { userId: owner.id, userRole: owner.role },
            actorMemberId: organizationResult.member.id,
          }),
        ])
        .execute();
    });

    assert(firstInvite.ok);

    const [secondInvite] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationInvitation({
            organizationId: organizationResult.organization.id,
            email: invitedUser.email,
            inviterId: owner.id,
            roles: ["admin"],
            actor: { userId: owner.id, userRole: owner.role },
            actorMemberId: organizationResult.member.id,
          }),
        ])
        .execute();
    });

    assert(secondInvite.ok);
    expect(secondInvite.invitation.id).toBe(firstInvite.invitation.id);
    expect(secondInvite.invitation.token).not.toBe(firstInvite.invitation.token);
    expect(secondInvite.invitation.roles).toEqual(["admin"]);

    const [tamperedResponse] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.respondToOrganizationInvitation({
            invitationId: secondInvite.invitation.id,
            action: "accept",
            token: firstInvite.invitation.token,
            actor: { userId: invitedUser.id, userRole: invitedUser.role },
            organizationId: secondInvite.invitation.organizationId,
          }),
        ])
        .execute();
    });

    expect(tamperedResponse.ok).toBe(false);
    if (!tamperedResponse.ok) {
      expect(tamperedResponse.code).toBe("invalid_token");
    }

    const [pendingInvites] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.listOrganizationInvitations({
            organizationId: organizationResult.organization.id,
            status: "pending",
          }),
        ])
        .execute();
    });

    const pendingForEmail = pendingInvites.invitations.filter(
      (invitation) => invitation.email === invitedUser.email,
    );
    expect(pendingForEmail).toHaveLength(1);
    expect(pendingForEmail[0]?.roles).toEqual(["admin"]);
  });

  it("rejects tokens from other invitations", async () => {
    const owner = await createUser("invite-token-owner@test.com");
    const inviteeA = await createUser("invitee-token-a@test.com");
    const inviteeB = await createUser("invitee-token-b@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Invite Token Org",
            slug: "invite-token-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    assert(organizationResult.ok);

    const [inviteA] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationInvitation({
            organizationId: organizationResult.organization.id,
            email: inviteeA.email,
            inviterId: owner.id,
            roles: ["member"],
            actor: { userId: owner.id, userRole: owner.role },
            actorMemberId: organizationResult.member.id,
          }),
        ])
        .execute();
    });

    const [inviteB] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationInvitation({
            organizationId: organizationResult.organization.id,
            email: inviteeB.email,
            inviterId: owner.id,
            roles: ["member"],
            actor: { userId: owner.id, userRole: owner.role },
            actorMemberId: organizationResult.member.id,
          }),
        ])
        .execute();
    });

    assert(inviteA.ok);
    assert(inviteB.ok);

    const [tamperedResponse] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.respondToOrganizationInvitation({
            invitationId: inviteA.invitation.id,
            action: "accept",
            token: inviteB.invitation.token,
            actor: { userId: inviteeA.id, userRole: inviteeA.role },
            organizationId: inviteA.invitation.organizationId,
          }),
        ])
        .execute();
    });

    expect(tamperedResponse.ok).toBe(false);
    if (!tamperedResponse.ok) {
      expect(tamperedResponse.code).toBe("invalid_token");
    }
  });

  it("schedules invitation expiration hooks", async () => {
    const owner = await createUser("invite-expire-owner@test.com");
    const invitedUser = await createUser("invite-expire-user@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Expire Hook Org",
            slug: "expire-hook-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    assert(organizationResult.ok);

    const [invitationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationInvitation({
            organizationId: organizationResult.organization.id,
            email: invitedUser.email,
            inviterId: owner.id,
            roles: ["member"],
            expiresAt: new Date(Date.now() + 60_000),
            actor: { userId: owner.id, userRole: owner.role },
            actorMemberId: organizationResult.member.id,
          }),
        ])
        .execute();
    });

    assert(invitationResult.ok);

    const internalFragment = getInternalFragment(test.adapter);
    const hooks = await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [internalFragment.services.hookService.getHooksByNamespace("auth")] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });

    const expirationHook = hooks.find((hook) => {
      const payload = hook.payload as { invitationId?: string } | null;
      return (
        hook.hookName === "onInvitationExpired" &&
        payload?.invitationId === invitationResult.invitation.id
      );
    });

    expect(expirationHook).toBeDefined();
    expect(expirationHook?.nextRetryAt?.getTime()).toBe(
      invitationResult.invitation.expiresAt.getTime(),
    );
  });

  it("expires invitations via durable hook processing", async () => {
    const owner = await createUser("invite-expire-owner-2@test.com");
    const invitedUser = await createUser("invite-expire-user-2@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Expire Org",
            slug: "expire-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    assert(organizationResult.ok);

    const [invitationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationInvitation({
            organizationId: organizationResult.organization.id,
            email: invitedUser.email,
            inviterId: owner.id,
            roles: ["member"],
            expiresAt: new Date(Date.now() - 1_000),
            actor: { userId: owner.id, userRole: owner.role },
            actorMemberId: organizationResult.member.id,
          }),
        ])
        .execute();
    });

    assert(invitationResult.ok);

    const internalFragment = getInternalFragment(test.adapter);
    const hooks = await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [internalFragment.services.hookService.getHooksByNamespace("auth")] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });

    const expirationHook = hooks.find((hook) => {
      const payload = hook.payload as { invitationId?: string } | null;
      return (
        hook.hookName === "onInvitationExpired" &&
        payload?.invitationId === invitationResult.invitation.id
      );
    });

    expect(expirationHook).toBeDefined();
    if (!expirationHook) {
      throw new Error("Expected invitation expiration hook to be scheduled");
    }

    const internalState = fragment.fragment.$internal as { durableHooksToken?: object } | undefined;
    expect(internalState?.durableHooksToken).toBeDefined();

    await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(internalFragment.$internal.deps.schema);
          uow.update("fragno_hooks", expirationHook.id, (b) =>
            b.set({ nextRetryAt: new Date(Date.now() - 1_000) }),
          );
        })
        .execute();
    });

    await drainDurableHooks(fragment.fragment);

    const hooksAfterDrain = await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [internalFragment.services.hookService.getHooksByNamespace("auth")] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });

    const processedHook = hooksAfterDrain.find((hook) => {
      const payload = hook.payload as { invitationId?: string } | null;
      return (
        hook.hookName === "onInvitationExpired" &&
        payload?.invitationId === invitationResult.invitation.id
      );
    });

    if (processedHook?.status === "failed") {
      throw new Error(`Invitation expiration hook failed: ${processedHook.error ?? "unknown"}`);
    }

    const [expiredLookup] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.getOrganizationInvitationById(invitationResult.invitation.id),
        ])
        .execute();
    });

    expect(expiredLookup?.invitation.status).toBe("expired");
    expect(expiredLookup?.invitation.respondedAt).toBeTruthy();

    const [pendingInvites] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.listOrganizationInvitationsForUser({
            email: invitedUser.email,
            status: "pending",
          }),
        ])
        .execute();
    });

    expect(pendingInvites.invitations).toHaveLength(0);
  });

  it("expires invitations even if the invitee user is deleted", async () => {
    const owner = await createUser("invite-expire-owner-deleted@test.com");
    const invitedUser = await createUser("invite-expire-user-deleted@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Expire Deleted Org",
            slug: "expire-deleted-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    assert(organizationResult.ok);

    const [invitationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationInvitation({
            organizationId: organizationResult.organization.id,
            email: invitedUser.email,
            inviterId: owner.id,
            roles: ["member"],
            expiresAt: new Date(Date.now() - 1_000),
            actor: { userId: owner.id, userRole: owner.role },
            actorMemberId: organizationResult.member.id,
          }),
        ])
        .execute();
    });

    assert(invitationResult.ok);

    await test.inContext(function () {
      return this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(authSchema);
          uow.delete("user", invitedUser.id);
        })
        .execute();
    });

    const internalFragment = getInternalFragment(test.adapter);
    const hooks = await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [internalFragment.services.hookService.getHooksByNamespace("auth")] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });

    const expirationHook = hooks.find((hook) => {
      const payload = hook.payload as { invitationId?: string } | null;
      return (
        hook.hookName === "onInvitationExpired" &&
        payload?.invitationId === invitationResult.invitation.id
      );
    });

    if (!expirationHook) {
      throw new Error("Expected invitation expiration hook to be scheduled");
    }

    await internalFragment.inContext(async function () {
      return await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(internalFragment.$internal.deps.schema);
          uow.update("fragno_hooks", expirationHook.id, (b) =>
            b.set({ nextRetryAt: new Date(Date.now() - 1_000) }),
          );
        })
        .execute();
    });

    await drainDurableHooks(fragment.fragment);

    const [expiredLookup] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.getOrganizationInvitationById(invitationResult.invitation.id),
        ])
        .execute();
    });

    expect(expiredLookup?.invitation.status).toBe("expired");
  });

  it("marks invitations expired when responding after expiry", async () => {
    const owner = await createUser("invite-expire-owner-3@test.com");
    const invitedUser = await createUser("invite-expire-user-3@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Expire Respond Org",
            slug: "expire-respond-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    assert(organizationResult.ok);

    const [invitationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationInvitation({
            organizationId: organizationResult.organization.id,
            email: invitedUser.email,
            inviterId: owner.id,
            roles: ["member"],
            expiresAt: new Date(Date.now() - 1_000),
            actor: { userId: owner.id, userRole: owner.role },
            actorMemberId: organizationResult.member.id,
          }),
        ])
        .execute();
    });

    assert(invitationResult.ok);

    const [response] = await test.inContext(function () {
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

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.code).toBe("invitation_expired");
    }

    const [expiredLookup] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.getOrganizationInvitationById(invitationResult.invitation.id),
        ])
        .execute();
    });

    expect(expiredLookup?.invitation.status).toBe("expired");
  });

  it("lists invitations by status", async () => {
    const owner = await createUser("invite-status-owner@test.com");
    const invitedUser = await createUser("invite-status-user@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Invite Status Org",
            slug: "invite-status-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    assert(organizationResult.ok);

    const [invitationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationInvitation({
            organizationId: organizationResult.organization.id,
            email: invitedUser.email,
            inviterId: owner.id,
            roles: ["member"],
            actor: { userId: owner.id, userRole: owner.role },
            actorMemberId: organizationResult.member.id,
          }),
        ])
        .execute();
    });

    assert(invitationResult.ok);

    const [cancelResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.respondToOrganizationInvitation({
            invitationId: invitationResult.invitation.id,
            action: "cancel",
            actor: { userId: owner.id, userRole: owner.role },
            organizationId: invitationResult.invitation.organizationId,
            actorMemberId: organizationResult.member.id,
          }),
        ])
        .execute();
    });

    expect(cancelResult.ok).toBe(true);

    const [pendingInvites] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.listOrganizationInvitations({
            organizationId: organizationResult.organization.id,
            status: "pending",
          }),
        ])
        .execute();
    });

    expect(pendingInvites.invitations).toHaveLength(0);

    const [canceledInvites] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.listOrganizationInvitations({
            organizationId: organizationResult.organization.id,
            status: "canceled",
          }),
        ])
        .execute();
    });

    expect(canceledInvites.invitations).toHaveLength(1);
  });

  it("cancels pending invitations when an organization is deleted", async () => {
    const owner = await createUser("invite-delete-owner@test.com");
    const invitedUser = await createUser("invite-delete-user@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Invite Delete Org",
            slug: "invite-delete-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    assert(organizationResult.ok);

    const [invitationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationInvitation({
            organizationId: organizationResult.organization.id,
            email: invitedUser.email,
            inviterId: owner.id,
            roles: ["member"],
            actor: { userId: owner.id, userRole: owner.role },
            actorMemberId: organizationResult.member.id,
          }),
        ])
        .execute();
    });

    assert(invitationResult.ok);

    const [deleteResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.deleteOrganization(organizationResult.organization.id, {
            userId: owner.id,
            userRole: owner.role,
          }),
        ])
        .execute();
    });

    expect(deleteResult.ok).toBe(true);

    const [lookup] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.getOrganizationInvitationById(invitationResult.invitation.id),
        ])
        .execute();
    });

    expect(lookup?.invitation.status).toBe("canceled");
    expect(lookup?.invitation.respondedAt).toBeTruthy();

    const [pendingInvites] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.listOrganizationInvitationsForUser({
            email: invitedUser.email,
            status: "pending",
          }),
        ])
        .execute();
    });

    expect(pendingInvites.invitations).toHaveLength(0);

    const [acceptResult] = await test.inContext(function () {
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

    expect(acceptResult.ok).toBe(false);
    if (!acceptResult.ok) {
      expect(acceptResult.code).toBe("invitation_not_found");
    }
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

  it("hides soft-deleted organizations from lookups", async () => {
    const owner = await createUser("deleted-owner@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Deleted Org",
            slug: "deleted-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    if (!organizationResult.ok) {
      throw new Error("Failed to create organization for deletion test");
    }

    const [deleteResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.deleteOrganization(organizationResult.organization.id, {
            userId: owner.id,
            userRole: owner.role,
          }),
        ])
        .execute();
    });

    expect(deleteResult.ok).toBe(true);

    const [getResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.getOrganizationById(organizationResult.organization.id),
        ])
        .execute();
    });

    expect(getResult).toBeNull();

    const [listResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.getOrganizationsForUser({
            userId: owner.id,
            pageSize: 10,
          }),
        ])
        .execute();
    });

    expect(listResult.organizations).toHaveLength(0);
  });

  it("treats soft-deleted organizations as not found for mutations", async () => {
    const owner = await createUser("deleted-mutation-owner@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Deleted Mutation Org",
            slug: "deleted-mutation-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    assert(organizationResult.ok);

    const [deleteResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.deleteOrganization(organizationResult.organization.id, {
            userId: owner.id,
            userRole: owner.role,
          }),
        ])
        .execute();
    });

    expect(deleteResult.ok).toBe(true);

    const [updateResult, deleteAgainResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.updateOrganization(
            organizationResult.organization.id,
            { name: "No Longer Mutable" },
            { userId: owner.id, userRole: owner.role },
          ),
          fragment.services.deleteOrganization(organizationResult.organization.id, {
            userId: owner.id,
            userRole: owner.role,
          }),
        ])
        .execute();
    });

    expect(updateResult.ok).toBe(false);
    if (!updateResult.ok) {
      expect(updateResult.code).toBe("organization_not_found");
    }

    expect(deleteAgainResult.ok).toBe(false);
    if (!deleteAgainResult.ok) {
      expect(deleteAgainResult.code).toBe("organization_not_found");
    }
  });

  it("allows clearing nullable organization fields", async () => {
    const owner = await createUser("clear-owner@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Clear Org",
            slug: "clear-org",
            logoUrl: "https://example.com/logo.png",
            metadata: { tier: "gold" },
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    if (!organizationResult.ok) {
      throw new Error("Failed to create organization for clear test");
    }

    const [updateResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.updateOrganization(
            organizationResult.organization.id,
            { logoUrl: null, metadata: null },
            { userId: owner.id, userRole: owner.role },
          ),
        ])
        .execute();
    });

    expect(updateResult.ok).toBe(true);
    if (!updateResult.ok) {
      return;
    }

    expect(updateResult.organization.logoUrl).toBeNull();
    expect(updateResult.organization.metadata).toBeNull();
  });
});

describe("organization service role defaults", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition).withConfig({
        organizations: {
          creatorRoles: ["owner", "admin"],
          defaultMemberRoles: ["member", "admin"],
        },
      }),
    )
    .build();

  const fragment = fragments.auth;

  const createUser = async (email: string) => {
    const passwordHash = await hashPassword("password");
    const [user] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.createUserUnvalidated(email, passwordHash)])
        .execute();
    });
    return user;
  };

  afterAll(async () => {
    await test.cleanup();
  });

  it("applies configured creator roles when omitted", async () => {
    const user = await createUser("config-owner@test.com");

    const [result] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Config Org",
            slug: "config-org",
            creatorUserId: user.id,
            creatorUserRole: user.role,
          }),
        ])
        .execute();
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.member.roles).toEqual(["owner", "admin"]);
  });

  it("applies configured default member roles for members and invitations", async () => {
    const owner = await createUser("config-owner-2@test.com");
    const memberUser = await createUser("config-member@test.com");

    const [organizationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Defaults Org",
            slug: "defaults-org",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    if (!organizationResult.ok) {
      throw new Error("Failed to create organization for default role test");
    }

    const [memberResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationMember({
            organizationId: organizationResult.organization.id,
            userId: memberUser.id,
            actor: { userId: owner.id, userRole: owner.role },
          }),
        ])
        .execute();
    });

    expect(memberResult.ok).toBe(true);
    if (!memberResult.ok) {
      return;
    }

    expect(memberResult.member.roles).toEqual(["member", "admin"]);

    const [invitationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationInvitation({
            organizationId: organizationResult.organization.id,
            email: "config-invitee@test.com",
            inviterId: owner.id,
            actor: { userId: owner.id, userRole: owner.role },
            actorMemberId: organizationResult.member.id,
          }),
        ])
        .execute();
    });

    expect(invitationResult.ok).toBe(true);
    if (!invitationResult.ok) {
      return;
    }

    expect(invitationResult.invitation.roles).toEqual(["member", "admin"]);
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
        .withServiceCalls(() => [fragment.services.createUserUnvalidated(email, passwordHash)])
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

    assert(firstOrg.ok);

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
            actorMemberId: orgResult.member.id,
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
            actorMemberId: orgResult.member.id,
          }),
        ])
        .execute();
    });

    expect(secondInvite.ok).toBe(false);
    if (!secondInvite.ok) {
      expect(secondInvite.code).toBe("limit_reached");
    }
  });

  it("blocks invitation acceptance when member limit is reached", async () => {
    const owner = await createUser("invite-limit-owner-2@test.com");
    const invitedUser = await createUser("invite-limit-user@test.com");

    const [orgResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganization({
            name: "Invite Limit Org Two",
            slug: "invite-limit-org-two",
            creatorUserId: owner.id,
            creatorUserRole: owner.role,
          }),
        ])
        .execute();
    });

    assert(orgResult.ok);

    const [inviteResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationInvitation({
            organizationId: orgResult.organization.id,
            email: invitedUser.email,
            inviterId: owner.id,
            actor: { userId: owner.id, userRole: owner.role },
            actorMemberId: orgResult.member.id,
          }),
        ])
        .execute();
    });

    assert(inviteResult.ok);

    const [acceptResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.respondToOrganizationInvitation({
            invitationId: inviteResult.invitation.id,
            action: "accept",
            token: inviteResult.invitation.token,
            actor: { userId: invitedUser.id, userRole: invitedUser.role },
            organizationId: inviteResult.invitation.organizationId,
          }),
        ])
        .execute();
    });

    expect(acceptResult.ok).toBe(false);
    if (!acceptResult.ok) {
      expect(acceptResult.code).toBe("limit_reached");
    }
  });
});
