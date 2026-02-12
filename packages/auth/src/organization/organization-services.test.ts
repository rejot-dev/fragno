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
          fragment.services.updateOrganizationMemberRoles(memberResult.member.id, [
            "admin",
            "member",
          ]),
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
            userId: invitedUser.id,
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
});
