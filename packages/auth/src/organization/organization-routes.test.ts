import { afterAll, assert, describe, expect, it } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { authFragmentDefinition } from "..";
import { sessionRoutesFactory } from "../session/session";
import { hashPassword } from "../user/password";
import { userActionsRoutesFactory } from "../user/user-actions";
import { organizationRoutesFactory } from "./routes";

describe("organization routes", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition).withRoutes([
        userActionsRoutesFactory,
        sessionRoutesFactory,
        organizationRoutesFactory,
      ]),
    )
    .build();

  const fragment = fragments.auth;
  let userCounter = 0;
  let organizationCounter = 0;

  const authHeaders = (credentialToken: string) => ({
    Cookie: `fragno_auth=${credentialToken}`,
  });

  const createUserWithCredential = async (email?: string) => {
    const resolvedEmail = email ?? `user-${(userCounter += 1)}@orgs.test`;
    const passwordHash = await hashPassword("password");
    const [user] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated(resolvedEmail, passwordHash),
        ])
        .execute();
    });

    const [session] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.issueCredential(user.id)])
        .execute();
    });

    if (!session.ok) {
      throw new Error(`Failed to issue credential: ${session.code}`);
    }

    return { user, credentialToken: session.credential.id };
  };

  const createOrganization = async (credentialToken: string, name?: string, slug?: string) => {
    const resolvedName = name ?? `Org ${(organizationCounter += 1)}`;
    const resolvedSlug = slug ?? `org-${organizationCounter}`;
    const response = await fragment.callRoute("POST", "/organizations", {
      headers: authHeaders(credentialToken),
      body: {
        name: resolvedName,
        slug: resolvedSlug,
      },
    });

    assert(response.type === "json");
    return response.data;
  };

  const addMember = async (
    credentialToken: string,
    organizationId: string,
    userId: string,
    roles?: string[],
  ) =>
    fragment.callRoute("POST", "/organizations/:organizationId/members", {
      pathParams: { organizationId },
      headers: authHeaders(credentialToken),
      body: { userId, roles },
    });

  afterAll(async () => {
    await test.cleanup();
  });

  it("creates organizations and lists them", async () => {
    const { credentialToken } = await createUserWithCredential("owner@orgs.test");

    const createResponse = await createOrganization(credentialToken, "Acme", "acme");
    expect(createResponse.organization.slug).toBe("acme");
    expect(createResponse.member.roles).toEqual(["owner"]);

    const orgId = createResponse.organization.id;

    const listResponse = await fragment.callRoute("GET", "/organizations", {
      headers: authHeaders(credentialToken),
    });

    assert(listResponse.type === "json");
    expect(listResponse.data.organizations).toHaveLength(1);
    expect(listResponse.data.organizations[0]?.member.roles).toEqual(["owner"]);

    const detailResponse = await fragment.callRoute("GET", "/organizations/:organizationId", {
      pathParams: { organizationId: orgId },
      headers: authHeaders(credentialToken),
    });

    assert(detailResponse.type === "json");
    expect(detailResponse.data.organization.id).toBe(orgId);
    expect(detailResponse.data.member.roles).toEqual(["owner"]);
  });

  it("paginates organization listing and requires a valid session", async () => {
    const { credentialToken } = await createUserWithCredential();

    await createOrganization(credentialToken, "Page Org One", "page-org-one");
    await createOrganization(credentialToken, "Page Org Two", "page-org-two");

    const firstPage = await fragment.callRoute("GET", "/organizations", {
      headers: authHeaders(credentialToken),
      query: { pageSize: "1" },
    });

    assert(firstPage.type === "json");
    expect(firstPage.data.organizations).toHaveLength(1);
    expect(firstPage.data.hasNextPage).toBe(true);
    expect(firstPage.data.cursor).toBeTruthy();

    const missingCredential = await fragment.callRoute("GET", "/organizations", {});
    assert(missingCredential.type === "error");
    expect(missingCredential.error.code).toBe("credential_invalid");
  });

  it("rejects invalid cursors for organization and member listings", async () => {
    const { credentialToken: ownerCredentialToken } =
      await createUserWithCredential("cursor-owner@test.com");
    const { user: memberUser } = await createUserWithCredential("cursor-member@test.com");

    const firstOrganization = await createOrganization(
      ownerCredentialToken,
      "Cursor Org One",
      "cursor-org-one",
    );
    await createOrganization(ownerCredentialToken, "Cursor Org Two", "cursor-org-two");

    const organizationsPage = await fragment.callRoute("GET", "/organizations", {
      headers: authHeaders(ownerCredentialToken),
      query: { pageSize: "1" },
    });

    assert(organizationsPage.type === "json");
    const organizationsCursor = organizationsPage.data.cursor;
    expect(organizationsCursor).toBeTruthy();
    if (!organizationsCursor) {
      throw new Error("Expected organizations cursor");
    }

    const malformedOrganizationsCursor = await fragment.callRoute("GET", "/organizations", {
      headers: authHeaders(ownerCredentialToken),
      query: { cursor: "not-a-valid-cursor" },
    });

    assert(malformedOrganizationsCursor.type === "error");
    expect(malformedOrganizationsCursor.error.code).toBe("invalid_input");
    expect(malformedOrganizationsCursor.status).toBe(400);

    const addMemberResponse = await addMember(
      ownerCredentialToken,
      firstOrganization.organization.id,
      memberUser.id,
      ["member"],
    );
    assert(addMemberResponse.type === "json");

    const membersPage = await fragment.callRoute("GET", "/organizations/:organizationId/members", {
      pathParams: { organizationId: firstOrganization.organization.id },
      headers: authHeaders(ownerCredentialToken),
      query: { pageSize: "1" },
    });

    assert(membersPage.type === "json");
    const membersCursor = membersPage.data.cursor;
    expect(membersCursor).toBeTruthy();
    if (!membersCursor) {
      throw new Error("Expected members cursor");
    }

    const invalidMembersCursor = await fragment.callRoute(
      "GET",
      "/organizations/:organizationId/members",
      {
        pathParams: { organizationId: firstOrganization.organization.id },
        headers: authHeaders(ownerCredentialToken),
        query: {
          cursor: organizationsCursor,
        },
      },
    );

    assert(invalidMembersCursor.type === "error");
    expect(invalidMembersCursor.error.code).toBe("invalid_input");
    expect(invalidMembersCursor.status).toBe(400);

    const invalidOrganizationsCursor = await fragment.callRoute("GET", "/organizations", {
      headers: authHeaders(ownerCredentialToken),
      query: {
        cursor: membersCursor,
      },
    });

    assert(invalidOrganizationsCursor.type === "error");
    expect(invalidOrganizationsCursor.error.code).toBe("invalid_input");
    expect(invalidOrganizationsCursor.status).toBe(400);
  });

  it("invites members and accepts invitations", async () => {
    const { credentialToken: ownerCredentialToken } =
      await createUserWithCredential("invite-owner@test.com");
    const { user: invitedUser, credentialToken: invitedCredentialToken } =
      await createUserWithCredential("invitee@test.com");

    const createResponse = await fragment.callRoute("POST", "/organizations", {
      headers: authHeaders(ownerCredentialToken),
      body: {
        name: "Invite Org",
        slug: "invite-org",
      },
    });

    assert(createResponse.type === "json");
    const orgId = createResponse.data.organization.id;

    const inviteResponse = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: orgId },
        headers: authHeaders(ownerCredentialToken),
        body: {
          email: invitedUser.email,
          roles: ["member"],
        },
      },
    );

    assert(inviteResponse.type === "json");
    expect(inviteResponse.data.invitation.email).toBe(invitedUser.email);

    const acceptResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        headers: authHeaders(invitedCredentialToken),
        body: {
          action: "accept",
          token: inviteResponse.data.invitation.token,
        },
      },
    );

    assert(acceptResponse.type === "json");
    expect(acceptResponse.data.invitation.status).toBe("accepted");

    const membersResponse = await fragment.callRoute(
      "GET",
      "/organizations/:organizationId/members",
      {
        pathParams: { organizationId: orgId },
        headers: authHeaders(ownerCredentialToken),
      },
    );

    assert(membersResponse.type === "json");
    const inviteeMember = membersResponse.data.members.find(
      (member: { userId: string }) => member.userId === invitedUser.id,
    );
    expect(inviteeMember?.roles).toEqual(["member"]);
  });

  it("accepting an invitation is idempotent for existing members", async () => {
    const { credentialToken: ownerCredentialToken } = await createUserWithCredential(
      "idempotent-owner@test.com",
    );
    const { user: invitedUser, credentialToken: invitedCredentialToken } =
      await createUserWithCredential("idempotent-invitee@test.com");

    const createResponse = await fragment.callRoute("POST", "/organizations", {
      headers: authHeaders(ownerCredentialToken),
      body: {
        name: "Idempotent Org",
        slug: "idempotent-org",
      },
    });

    assert(createResponse.type === "json");
    const orgId = createResponse.data.organization.id;

    const inviteResponse = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: orgId },
        headers: authHeaders(ownerCredentialToken),
        body: {
          email: invitedUser.email,
          roles: ["member"],
        },
      },
    );

    assert(inviteResponse.type === "json");

    const addMemberResponse = await addMember(ownerCredentialToken, orgId, invitedUser.id, [
      "member",
    ]);
    assert(addMemberResponse.type === "json");

    const acceptResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        headers: authHeaders(invitedCredentialToken),
        body: {
          action: "accept",
          token: inviteResponse.data.invitation.token,
        },
      },
    );

    assert(acceptResponse.type === "json");
    expect(acceptResponse.data.invitation.status).toBe("accepted");

    const membersResponse = await fragment.callRoute(
      "GET",
      "/organizations/:organizationId/members",
      {
        pathParams: { organizationId: orgId },
        headers: authHeaders(ownerCredentialToken),
      },
    );

    assert(membersResponse.type === "json");
    const inviteeMembers = membersResponse.data.members.filter(
      (member: { userId: string }) => member.userId === invitedUser.id,
    );
    expect(inviteeMembers).toHaveLength(1);
  });

  it("sets active organization explicitly and enforces membership", async () => {
    const { credentialToken } = await createUserWithCredential("active-owner@test.com");
    const { credentialToken: nonMemberCredentialToken } = await createUserWithCredential(
      "active-non-member@test.com",
    );

    const activeBefore = await fragment.callRoute("GET", "/organizations/active", {
      headers: authHeaders(credentialToken),
    });
    expect(activeBefore.type).toBe("empty");

    const createResponse = await createOrganization(credentialToken, "Active Org", "active-org");
    const orgId = createResponse.organization.id;

    const missingMembership = await fragment.callRoute("POST", "/organizations/active", {
      headers: authHeaders(nonMemberCredentialToken),
      body: { organizationId: orgId },
    });

    assert(missingMembership.type === "error");
    expect(missingMembership.error.code).toBe("membership_not_found");

    const setActiveResponse = await fragment.callRoute("POST", "/organizations/active", {
      headers: authHeaders(credentialToken),
      body: { organizationId: orgId },
    });

    assert(setActiveResponse.type === "json");
    expect(setActiveResponse.data.organization.id).toBe(orgId);

    const activeResponse = await fragment.callRoute("GET", "/organizations/active", {
      headers: authHeaders(credentialToken),
    });

    assert(activeResponse.type === "json");
    expect(activeResponse.data?.organization.id).toBe(orgId);
  });

  it("enforces membership for organization details", async () => {
    const { credentialToken } = await createUserWithCredential("detail-owner@test.com");
    const { credentialToken: nonMemberCredentialToken } = await createUserWithCredential(
      "detail-non-member@test.com",
    );

    const created = await createOrganization(credentialToken, "Detail Org", "detail-org");

    const detailResponse = await fragment.callRoute("GET", "/organizations/:organizationId", {
      pathParams: { organizationId: created.organization.id },
      headers: authHeaders(nonMemberCredentialToken),
    });

    assert(detailResponse.type === "error");
    expect(detailResponse.error.code).toBe("permission_denied");
    expect(detailResponse.status).toBe(403);
  });

  it("updates and deletes organizations with permission checks", async () => {
    const { credentialToken: ownerCredentialToken } =
      await createUserWithCredential("update-owner@test.com");
    const { user: memberUser, credentialToken: memberCredentialToken } =
      await createUserWithCredential("update-member@test.com");

    const created = await createOrganization(ownerCredentialToken, "Update Org", "update-org");

    const addMemberResponse = await addMember(
      ownerCredentialToken,
      created.organization.id,
      memberUser.id,
      ["member"],
    );
    assert(addMemberResponse.type === "json");

    const deniedUpdate = await fragment.callRoute("PATCH", "/organizations/:organizationId", {
      pathParams: { organizationId: created.organization.id },
      headers: authHeaders(memberCredentialToken),
      body: { name: "Blocked Update" },
    });

    assert(deniedUpdate.type === "error");
    expect(deniedUpdate.error.code).toBe("permission_denied");
    expect(deniedUpdate.status).toBe(403);

    const updateResponse = await fragment.callRoute("PATCH", "/organizations/:organizationId", {
      pathParams: { organizationId: created.organization.id },
      headers: authHeaders(ownerCredentialToken),
      body: { name: "Updated Org" },
    });

    assert(updateResponse.type === "json");
    expect(updateResponse.data.organization.name).toBe("Updated Org");

    const deniedDelete = await fragment.callRoute("DELETE", "/organizations/:organizationId", {
      pathParams: { organizationId: created.organization.id },
      headers: authHeaders(memberCredentialToken),
    });

    assert(deniedDelete.type === "error");
    expect(deniedDelete.error.code).toBe("permission_denied");
    expect(deniedDelete.status).toBe(403);

    const deleteResponse = await fragment.callRoute("DELETE", "/organizations/:organizationId", {
      pathParams: { organizationId: created.organization.id },
      headers: authHeaders(ownerCredentialToken),
    });

    assert(deleteResponse.type === "json");
    expect(deleteResponse.data.success).toBe(true);

    const updateDeleted = await fragment.callRoute("PATCH", "/organizations/:organizationId", {
      pathParams: { organizationId: created.organization.id },
      headers: authHeaders(ownerCredentialToken),
      body: { name: "Still Deleted" },
    });

    assert(updateDeleted.type === "error");
    expect(updateDeleted.error.code).toBe("organization_not_found");
    expect(updateDeleted.status).toBe(404);

    const deleteDeleted = await fragment.callRoute("DELETE", "/organizations/:organizationId", {
      pathParams: { organizationId: created.organization.id },
      headers: authHeaders(ownerCredentialToken),
    });

    assert(deleteDeleted.type === "error");
    expect(deleteDeleted.error.code).toBe("organization_not_found");
    expect(deleteDeleted.status).toBe(404);
  });

  it("manages members with pagination and permissions", async () => {
    const { credentialToken: ownerCredentialToken } =
      await createUserWithCredential("member-owner@test.com");
    const { user: memberUser, credentialToken: memberCredentialToken } =
      await createUserWithCredential("member-user@test.com");
    const { user: secondMember } = await createUserWithCredential("member-two@test.com");
    const { credentialToken: nonMemberCredentialToken } = await createUserWithCredential(
      "member-outsider@test.com",
    );

    const created = await createOrganization(ownerCredentialToken, "Members Org", "members-org");

    const deniedAdd = await addMember(
      memberCredentialToken,
      created.organization.id,
      secondMember.id,
      ["member"],
    );
    assert(deniedAdd.type === "error");
    expect(deniedAdd.error.code).toBe("permission_denied");

    const addMemberResponse = await addMember(
      ownerCredentialToken,
      created.organization.id,
      memberUser.id,
      ["member"],
    );
    assert(addMemberResponse.type === "json");

    const addSecondResponse = await addMember(
      ownerCredentialToken,
      created.organization.id,
      secondMember.id,
      ["member"],
    );
    assert(addSecondResponse.type === "json");

    const firstPage = await fragment.callRoute("GET", "/organizations/:organizationId/members", {
      pathParams: { organizationId: created.organization.id },
      headers: authHeaders(ownerCredentialToken),
      query: { pageSize: "1" },
    });

    assert(firstPage.type === "json");
    expect(firstPage.data.members).toHaveLength(1);
    expect(firstPage.data.hasNextPage).toBe(true);
    expect(firstPage.data.cursor).toBeTruthy();

    const forbiddenList = await fragment.callRoute(
      "GET",
      "/organizations/:organizationId/members",
      {
        pathParams: { organizationId: created.organization.id },
        headers: authHeaders(nonMemberCredentialToken),
      },
    );

    assert(forbiddenList.type === "error");
    expect(forbiddenList.error.code).toBe("permission_denied");
  });

  it("updates and removes members with permission checks", async () => {
    const { credentialToken: ownerCredentialToken } =
      await createUserWithCredential("role-owner@test.com");
    const { user: memberUser } = await createUserWithCredential("role-member@test.com");
    const { user: nonAdminUser, credentialToken: nonAdminCredentialToken } =
      await createUserWithCredential("role-non-admin@test.com");

    const created = await createOrganization(ownerCredentialToken, "Role Org", "role-org");

    const addMemberResponse = await addMember(
      ownerCredentialToken,
      created.organization.id,
      memberUser.id,
      ["member"],
    );
    assert(addMemberResponse.type === "json");

    const memberId = addMemberResponse.data.member.id;

    const addNonAdmin = await addMember(
      ownerCredentialToken,
      created.organization.id,
      nonAdminUser.id,
      ["member"],
    );
    assert(addNonAdmin.type === "json");

    const deniedUpdate = await fragment.callRoute(
      "PATCH",
      "/organizations/:organizationId/members/:memberId",
      {
        pathParams: { organizationId: created.organization.id, memberId },
        headers: authHeaders(nonAdminCredentialToken),
        body: { roles: ["member"] },
      },
    );

    assert(deniedUpdate.type === "error");
    expect(deniedUpdate.error.code).toBe("permission_denied");

    const deniedRemove = await fragment.callRoute(
      "DELETE",
      "/organizations/:organizationId/members/:memberId",
      {
        pathParams: { organizationId: created.organization.id, memberId },
        headers: authHeaders(nonAdminCredentialToken),
      },
    );

    assert(deniedRemove.type === "error");
    expect(deniedRemove.error.code).toBe("permission_denied");

    const updateResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/:organizationId/members/:memberId",
      {
        pathParams: { organizationId: created.organization.id, memberId },
        headers: authHeaders(ownerCredentialToken),
        body: { roles: ["admin"] },
      },
    );

    assert(updateResponse.type === "json");
    expect(updateResponse.data.member.roles).toEqual(["admin"]);

    const removeResponse = await fragment.callRoute(
      "DELETE",
      "/organizations/:organizationId/members/:memberId",
      {
        pathParams: { organizationId: created.organization.id, memberId },
        headers: authHeaders(ownerCredentialToken),
      },
    );

    assert(removeResponse.type === "json");
    expect(removeResponse.data.success).toBe(true);
  });

  it("returns credential_invalid for member mutations with invalid sessions", async () => {
    const { credentialToken: ownerCredentialToken } = await createUserWithCredential(
      "invalid-member-owner@test.com",
    );
    const { user: memberUser } = await createUserWithCredential("invalid-member-user@test.com");

    const created = await createOrganization(
      ownerCredentialToken,
      "Invalid Session Org",
      "invalid-session-org",
    );

    const addMemberResponse = await addMember(
      ownerCredentialToken,
      created.organization.id,
      memberUser.id,
      ["member"],
    );
    assert(addMemberResponse.type === "json");

    const memberId = addMemberResponse.data.member.id;
    const invalidCredentialToken = "invalid-session-id";

    const invalidCreate = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/members",
      {
        pathParams: { organizationId: created.organization.id },
        headers: authHeaders(invalidCredentialToken),
        body: { userId: memberUser.id },
      },
    );

    assert(invalidCreate.type === "error");
    expect(invalidCreate.error.code).toBe("credential_invalid");
    expect(invalidCreate.status).toBe(401);

    const invalidUpdate = await fragment.callRoute(
      "PATCH",
      "/organizations/:organizationId/members/:memberId",
      {
        pathParams: { organizationId: created.organization.id, memberId },
        headers: authHeaders(invalidCredentialToken),
        body: { roles: ["member"] },
      },
    );

    assert(invalidUpdate.type === "error");
    expect(invalidUpdate.error.code).toBe("credential_invalid");
    expect(invalidUpdate.status).toBe(401);

    const invalidDelete = await fragment.callRoute(
      "DELETE",
      "/organizations/:organizationId/members/:memberId",
      {
        pathParams: { organizationId: created.organization.id, memberId },
        headers: authHeaders(invalidCredentialToken),
      },
    );

    assert(invalidDelete.type === "error");
    expect(invalidDelete.error.code).toBe("credential_invalid");
    expect(invalidDelete.status).toBe(401);
  });

  it("returns organization_not_found when adding members to missing organizations", async () => {
    const { credentialToken } = await createUserWithCredential("missing-org-owner@test.com");
    const { user: memberUser } = await createUserWithCredential("missing-org-member@test.com");

    const response = await fragment.callRoute("POST", "/organizations/:organizationId/members", {
      pathParams: { organizationId: "missing-org-id" },
      headers: authHeaders(credentialToken),
      body: { userId: memberUser.id },
    });

    assert(response.type === "error");
    expect(response.error.code).toBe("organization_not_found");
    expect(response.status).toBe(404);
  });

  it("lists invitations and handles invitation errors", async () => {
    const { credentialToken: ownerCredentialToken } = await createUserWithCredential(
      "invite-list-owner@test.com",
    );
    const { user: memberUser, credentialToken: memberCredentialToken } =
      await createUserWithCredential("invite-list-member@test.com");
    const { user: inviteeUser, credentialToken: inviteeCredentialToken } =
      await createUserWithCredential("invite-list-invitee@test.com");
    const { credentialToken: outsiderCredentialToken } = await createUserWithCredential(
      "invite-list-outsider@test.com",
    );

    const created = await createOrganization(
      ownerCredentialToken,
      "Invite List Org",
      "invite-list-org",
    );

    const addMemberResponse = await addMember(
      ownerCredentialToken,
      created.organization.id,
      memberUser.id,
      ["member"],
    );
    assert(addMemberResponse.type === "json");

    const deniedInvite = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: created.organization.id },
        headers: authHeaders(memberCredentialToken),
        body: { email: inviteeUser.email },
      },
    );

    assert(deniedInvite.type === "error");
    expect(deniedInvite.error.code).toBe("permission_denied");

    const inviteResponse = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: created.organization.id },
        headers: authHeaders(ownerCredentialToken),
        body: { email: inviteeUser.email, roles: ["member"] },
      },
    );

    assert(inviteResponse.type === "json");

    const listOrgInvites = await fragment.callRoute(
      "GET",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: created.organization.id },
        headers: authHeaders(ownerCredentialToken),
      },
    );

    assert(listOrgInvites.type === "json");
    expect(listOrgInvites.data.invitations).toHaveLength(1);

    const forbiddenMemberInvites = await fragment.callRoute(
      "GET",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: created.organization.id },
        headers: authHeaders(memberCredentialToken),
      },
    );

    assert(forbiddenMemberInvites.type === "error");
    expect(forbiddenMemberInvites.error.code).toBe("permission_denied");

    const forbiddenOrgInvites = await fragment.callRoute(
      "GET",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: created.organization.id },
        headers: authHeaders(outsiderCredentialToken),
      },
    );

    assert(forbiddenOrgInvites.type === "error");
    expect(forbiddenOrgInvites.error.code).toBe("permission_denied");

    const listUserInvites = await fragment.callRoute("GET", "/organizations/invitations", {
      headers: authHeaders(inviteeCredentialToken),
    });

    assert(listUserInvites.type === "json");
    expect(listUserInvites.data.invitations).toHaveLength(1);

    const invalidToken = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        headers: authHeaders(inviteeCredentialToken),
        body: { action: "accept", token: "invalid-token" },
      },
    );

    assert(invalidToken.type === "error");
    expect(invalidToken.error.code).toBe("invalid_token");
  });

  it("resends invitations for the same email and updates roles", async () => {
    const { credentialToken: ownerCredentialToken } = await createUserWithCredential(
      "invite-resend-owner@test.com",
    );
    const { user: invitedUser, credentialToken: invitedCredentialToken } =
      await createUserWithCredential("invite-resend-user@test.com");

    const created = await createOrganization(ownerCredentialToken, "Resend Org", "resend-org");

    const firstInvite = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: created.organization.id },
        headers: authHeaders(ownerCredentialToken),
        body: { email: invitedUser.email, roles: ["member"] },
      },
    );

    assert(firstInvite.type === "json");

    const secondInvite = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: created.organization.id },
        headers: authHeaders(ownerCredentialToken),
        body: { email: invitedUser.email, roles: ["admin"] },
      },
    );

    assert(secondInvite.type === "json");
    expect(secondInvite.data.invitation.id).toBe(firstInvite.data.invitation.id);
    expect(secondInvite.data.invitation.token).not.toBe(firstInvite.data.invitation.token);
    expect(secondInvite.data.invitation.roles).toEqual(["admin"]);

    const listOrgInvites = await fragment.callRoute(
      "GET",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: created.organization.id },
        headers: authHeaders(ownerCredentialToken),
      },
    );

    assert(listOrgInvites.type === "json");
    expect(listOrgInvites.data.invitations).toHaveLength(1);
    expect(listOrgInvites.data.invitations[0]?.roles).toEqual(["admin"]);

    const tamperedAccept = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: secondInvite.data.invitation.id },
        headers: authHeaders(invitedCredentialToken),
        body: { action: "accept", token: firstInvite.data.invitation.token },
      },
    );

    assert(tamperedAccept.type === "error");
    expect(tamperedAccept.error.code).toBe("invalid_token");
  });

  it("rejects tokens from other invitations", async () => {
    const { credentialToken: ownerCredentialToken } = await createUserWithCredential(
      "invite-token-owner@test.com",
    );
    const { user: inviteeA, credentialToken: inviteeCredentialToken } =
      await createUserWithCredential("invite-token-a@test.com");
    const { user: inviteeB } = await createUserWithCredential("invite-token-b@test.com");

    const created = await createOrganization(ownerCredentialToken, "Token Org", "token-org");

    const inviteA = await fragment.callRoute("POST", "/organizations/:organizationId/invitations", {
      pathParams: { organizationId: created.organization.id },
      headers: authHeaders(ownerCredentialToken),
      body: { email: inviteeA.email, roles: ["member"] },
    });

    const inviteB = await fragment.callRoute("POST", "/organizations/:organizationId/invitations", {
      pathParams: { organizationId: created.organization.id },
      headers: authHeaders(ownerCredentialToken),
      body: { email: inviteeB.email, roles: ["member"] },
    });

    assert(inviteA.type === "json");
    assert(inviteB.type === "json");

    const tamperedAccept = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteA.data.invitation.id },
        headers: authHeaders(inviteeCredentialToken),
        body: { action: "accept", token: inviteB.data.invitation.token },
      },
    );

    assert(tamperedAccept.type === "error");
    expect(tamperedAccept.error.code).toBe("invalid_token");
  });

  it("blocks accepting invitations for a different email", async () => {
    const { credentialToken: ownerCredentialToken } = await createUserWithCredential(
      "invite-owner-mismatch@test.com",
    );
    const { user: invitedUser } = await createUserWithCredential("invitee-mismatch@test.com");
    const { credentialToken: otherCredentialToken } =
      await createUserWithCredential("other-mismatch@test.com");

    const createResponse = await createOrganization(
      ownerCredentialToken,
      "Mismatch Org",
      "mismatch-org",
    );
    const orgId = createResponse.organization.id;

    const inviteResponse = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: orgId },
        headers: authHeaders(ownerCredentialToken),
        body: { email: invitedUser.email, roles: ["member"] },
      },
    );

    assert(inviteResponse.type === "json");

    const acceptResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        headers: authHeaders(otherCredentialToken),
        body: { action: "accept", token: inviteResponse.data.invitation.token },
      },
    );

    assert(acceptResponse.type === "error");
    expect(acceptResponse.error.code).toBe("permission_denied");
    expect(acceptResponse.status).toBe(403);
  });

  it("blocks rejecting invitations for a different email", async () => {
    const { credentialToken: ownerCredentialToken } = await createUserWithCredential(
      "invite-owner-reject@test.com",
    );
    const { user: invitedUser } = await createUserWithCredential("invitee-reject@test.com");
    const { credentialToken: otherCredentialToken } =
      await createUserWithCredential("other-reject@test.com");

    const createResponse = await createOrganization(
      ownerCredentialToken,
      "Reject Org",
      "reject-org",
    );
    const orgId = createResponse.organization.id;

    const inviteResponse = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: orgId },
        headers: authHeaders(ownerCredentialToken),
        body: { email: invitedUser.email, roles: ["member"] },
      },
    );

    assert(inviteResponse.type === "json");

    const rejectResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        headers: authHeaders(otherCredentialToken),
        body: { action: "reject", token: inviteResponse.data.invitation.token },
      },
    );

    assert(rejectResponse.type === "error");
    expect(rejectResponse.error.code).toBe("permission_denied");
    expect(rejectResponse.status).toBe(403);
  });

  it("allows the inviter to cancel invitations", async () => {
    const { credentialToken: ownerCredentialToken } = await createUserWithCredential(
      "invite-owner-cancel@test.com",
    );
    const { user: invitedUser } = await createUserWithCredential("invitee-cancel@test.com");

    const createResponse = await createOrganization(
      ownerCredentialToken,
      "Cancel Org",
      "cancel-org",
    );
    const orgId = createResponse.organization.id;

    const inviteResponse = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: orgId },
        headers: authHeaders(ownerCredentialToken),
        body: { email: invitedUser.email, roles: ["member"] },
      },
    );

    assert(inviteResponse.type === "json");

    const cancelResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        headers: authHeaders(ownerCredentialToken),
        body: { action: "cancel" },
      },
    );

    assert(cancelResponse.type === "json");
    expect(cancelResponse.data.invitation.status).toBe("canceled");
  });

  it("allows organization admins to cancel invitations", async () => {
    const { credentialToken: ownerCredentialToken } = await createUserWithCredential(
      "invite-owner-admin-cancel@test.com",
    );
    const { user: adminUser, credentialToken: adminCredentialToken } =
      await createUserWithCredential("invite-admin-cancel@test.com");
    const { user: invitedUser } = await createUserWithCredential("invitee-admin-cancel@test.com");

    const createResponse = await createOrganization(
      ownerCredentialToken,
      "Admin Cancel Org",
      "admin-cancel-org",
    );
    const orgId = createResponse.organization.id;

    const adminAddResponse = await addMember(ownerCredentialToken, orgId, adminUser.id, ["admin"]);
    assert(adminAddResponse.type === "json");

    const inviteResponse = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: orgId },
        headers: authHeaders(ownerCredentialToken),
        body: { email: invitedUser.email, roles: ["member"] },
      },
    );

    assert(inviteResponse.type === "json");

    const cancelResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        headers: authHeaders(adminCredentialToken),
        body: { action: "cancel" },
      },
    );

    assert(cancelResponse.type === "json");
    expect(cancelResponse.data.invitation.status).toBe("canceled");
  });

  it("denies cancel for non-admin non-inviters", async () => {
    const { credentialToken: ownerCredentialToken } = await createUserWithCredential(
      "invite-owner-deny-cancel@test.com",
    );
    const { user: memberUser, credentialToken: memberCredentialToken } =
      await createUserWithCredential("invite-member-deny-cancel@test.com");
    const { user: invitedUser } = await createUserWithCredential("invitee-deny-cancel@test.com");

    const createResponse = await createOrganization(
      ownerCredentialToken,
      "Deny Cancel Org",
      "deny-cancel-org",
    );
    const orgId = createResponse.organization.id;

    const addMemberResponse = await addMember(ownerCredentialToken, orgId, memberUser.id, [
      "member",
    ]);
    assert(addMemberResponse.type === "json");

    const inviteResponse = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: orgId },
        headers: authHeaders(ownerCredentialToken),
        body: { email: invitedUser.email, roles: ["member"] },
      },
    );

    assert(inviteResponse.type === "json");

    const cancelResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        headers: authHeaders(memberCredentialToken),
        body: { action: "cancel" },
      },
    );

    assert(cancelResponse.type === "error");
    expect(cancelResponse.error.code).toBe("permission_denied");
    expect(cancelResponse.status).toBe(403);
  });

  it("returns invitation_expired for expired invitations", async () => {
    const { user: ownerUser, credentialToken: ownerCredentialToken } =
      await createUserWithCredential("invite-owner-expired@test.com");
    const { user: invitedUser, credentialToken: invitedCredentialToken } =
      await createUserWithCredential("invitee-expired@test.com");

    const createResponse = await createOrganization(
      ownerCredentialToken,
      "Expired Invite Org",
      "expired-invite-org",
    );
    const orgId = createResponse.organization.id;

    const [invitationResult] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createOrganizationInvitation({
            organizationId: orgId,
            email: invitedUser.email,
            inviterId: ownerUser.id,
            roles: ["member"],
            expiresAt: new Date(Date.now() - 1_000),
            actor: { userId: ownerUser.id, userRole: ownerUser.role },
            actorMemberId: createResponse.member.id,
          }),
        ])
        .execute();
    });

    assert(invitationResult.ok);

    await drainDurableHooks(fragment.fragment);

    const acceptResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: invitationResult.invitation.id },
        headers: authHeaders(invitedCredentialToken),
        body: { action: "accept", token: invitationResult.invitation.token },
      },
    );

    assert(acceptResponse.type === "error");
    expect(acceptResponse.error.code).toBe("invitation_expired");
  });

  it("cancels pending invitations when an organization is deleted", async () => {
    const { credentialToken: ownerCredentialToken } = await createUserWithCredential(
      "invite-delete-owner@test.com",
    );
    const { user: invitedUser, credentialToken: invitedCredentialToken } =
      await createUserWithCredential("invite-delete-user@test.com");

    const created = await createOrganization(
      ownerCredentialToken,
      "Invite Delete Org",
      "invite-del-org",
    );

    const inviteResponse = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: created.organization.id },
        headers: authHeaders(ownerCredentialToken),
        body: { email: invitedUser.email, roles: ["member"] },
      },
    );

    assert(inviteResponse.type === "json");

    const deleteResponse = await fragment.callRoute("DELETE", "/organizations/:organizationId", {
      pathParams: { organizationId: created.organization.id },
      headers: authHeaders(ownerCredentialToken),
    });

    assert(deleteResponse.type === "json");
    expect(deleteResponse.data.success).toBe(true);

    const acceptResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        headers: authHeaders(invitedCredentialToken),
        body: { action: "accept", token: inviteResponse.data.invitation.token },
      },
    );

    assert(acceptResponse.type === "error");
    expect(acceptResponse.error.code).toBe("invitation_not_found");

    const listUserInvites = await fragment.callRoute("GET", "/organizations/invitations", {
      headers: authHeaders(invitedCredentialToken),
    });

    assert(listUserInvites.type === "json");
    expect(listUserInvites.data.invitations).toHaveLength(0);
  });

  it("requires a token when rejecting invitations", async () => {
    const { credentialToken: ownerCredentialToken } = await createUserWithCredential(
      "invite-owner-reject-token@test.com",
    );
    const { user: invitedUser, credentialToken: invitedCredentialToken } =
      await createUserWithCredential("invitee-reject-token@test.com");

    const createResponse = await createOrganization(
      ownerCredentialToken,
      "Reject Token Org",
      "reject-token-org",
    );
    const orgId = createResponse.organization.id;

    const inviteResponse = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: orgId },
        headers: authHeaders(ownerCredentialToken),
        body: { email: invitedUser.email, roles: ["member"] },
      },
    );

    assert(inviteResponse.type === "json");

    const rejectResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        headers: authHeaders(invitedCredentialToken),
        body: { action: "reject" },
      },
    );

    assert(rejectResponse.type === "error");
    expect(rejectResponse.error.code).toBe("invalid_token");
  });
});

describe("organization routes limits regressions", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          organizations: {
            limits: {
              organizationsPerUser: 2,
              membersPerOrganization: 2,
            },
          },
        })
        .withRoutes([userActionsRoutesFactory, sessionRoutesFactory, organizationRoutesFactory]),
    )
    .build();

  const fragment = fragments.auth;
  let userCounter = 0;
  let organizationCounter = 0;

  const authHeaders = (credentialToken: string) => ({
    Cookie: `fragno_auth=${credentialToken}`,
  });

  const createUserWithCredential = async (email?: string) => {
    const resolvedEmail = email ?? `limit-user-${(userCounter += 1)}@orgs.test`;
    const passwordHash = await hashPassword("password");
    const [user] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated(resolvedEmail, passwordHash),
        ])
        .execute();
    });

    const [session] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.issueCredential(user.id)])
        .execute();
    });

    if (!session.ok) {
      throw new Error(`Failed to issue credential: ${session.code}`);
    }

    return { user, credentialToken: session.credential.id };
  };

  const createOrganization = async (credentialToken: string, name?: string, slug?: string) => {
    const resolvedName = name ?? `Limit Org ${(organizationCounter += 1)}`;
    const resolvedSlug = slug ?? `limit-org-${organizationCounter}`;
    const response = await fragment.callRoute("POST", "/organizations", {
      headers: authHeaders(credentialToken),
      body: {
        name: resolvedName,
        slug: resolvedSlug,
      },
    });

    assert(response.type === "json");
    return response.data;
  };

  const addMember = async (
    credentialToken: string,
    organizationId: string,
    userId: string,
    roles?: string[],
  ) =>
    fragment.callRoute("POST", "/organizations/:organizationId/members", {
      pathParams: { organizationId },
      headers: authHeaders(credentialToken),
      body: { userId, roles },
    });

  afterAll(async () => {
    await test.cleanup();
  });

  it("enforces organizationsPerUser based on full membership count", async () => {
    const { credentialToken } = await createUserWithCredential("limit-owner@test.com");
    const { user: memberUser } = await createUserWithCredential("limit-member@test.com");

    const firstOrg = await createOrganization(credentialToken, "Limit Org One", "limit-org-one");
    await createOrganization(credentialToken, "Limit Org Two", "limit-org-two");

    const addMemberResponse = await addMember(
      credentialToken,
      firstOrg.organization.id,
      memberUser.id,
      ["member"],
    );
    assert(addMemberResponse.type === "json");

    const thirdOrg = await fragment.callRoute("POST", "/organizations", {
      headers: authHeaders(credentialToken),
      body: { name: "Limit Org Three", slug: "limit-org-three" },
    });

    assert(thirdOrg.type === "error");
    expect(thirdOrg.error.code).toBe("limit_reached");
  });

  it("rejects invitation acceptance when membersPerOrganization is reached", async () => {
    const { credentialToken: ownerCredentialToken } = await createUserWithCredential(
      "invite-limit-owner@test.com",
    );
    const { user: memberUser } = await createUserWithCredential("invite-limit-member@test.com");
    const { user: inviteeUser, credentialToken: inviteeCredentialToken } =
      await createUserWithCredential("invite-limit-invitee@test.com");

    const created = await createOrganization(
      ownerCredentialToken,
      "Invite Limit Org",
      "invite-limit-org",
    );
    const orgId = created.organization.id;

    const addMemberResponse = await addMember(ownerCredentialToken, orgId, memberUser.id, [
      "member",
    ]);
    assert(addMemberResponse.type === "json");

    const inviteResponse = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: orgId },
        headers: authHeaders(ownerCredentialToken),
        body: {
          email: inviteeUser.email,
          roles: ["member"],
        },
      },
    );

    assert(inviteResponse.type === "json");

    const acceptResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        headers: authHeaders(inviteeCredentialToken),
        body: {
          action: "accept",
          token: inviteResponse.data.invitation.token,
        },
      },
    );

    assert(acceptResponse.type === "error");
    expect(acceptResponse.error.code).toBe("limit_reached");
  });

  it("returns a single member entry with aggregated roles", async () => {
    const { credentialToken: ownerCredentialToken } =
      await createUserWithCredential("roles-owner@test.com");
    const { user: memberUser } = await createUserWithCredential("roles-member@test.com");

    const created = await createOrganization(ownerCredentialToken, "Roles Org", "roles-org");
    const orgId = created.organization.id;

    const addMemberResponse = await addMember(ownerCredentialToken, orgId, memberUser.id, [
      "admin",
      "member",
    ]);
    assert(addMemberResponse.type === "json");

    const listResponse = await fragment.callRoute("GET", "/organizations/:organizationId/members", {
      pathParams: { organizationId: orgId },
      headers: authHeaders(ownerCredentialToken),
    });

    assert(listResponse.type === "json");
    expect(listResponse.data.members).toHaveLength(2);

    const memberEntries = listResponse.data.members.filter(
      (member: { userId: string }) => member.userId === memberUser.id,
    );
    expect(memberEntries).toHaveLength(1);
    expect(new Set(memberEntries[0]?.roles)).toEqual(new Set(["admin", "member"]));
  });
});
