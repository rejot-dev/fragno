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

  const createUserWithSession = async (email?: string) => {
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
        .withServiceCalls(() => [fragment.services.createSession(user.id)])
        .execute();
    });

    if (!session.ok) {
      throw new Error(`Failed to create session: ${session.code}`);
    }

    return { user, sessionId: session.session.id };
  };

  const createOrganization = async (sessionId: string, name?: string, slug?: string) => {
    const resolvedName = name ?? `Org ${(organizationCounter += 1)}`;
    const resolvedSlug = slug ?? `org-${organizationCounter}`;
    const response = await fragment.callRoute("POST", "/organizations", {
      query: { sessionId },
      body: {
        name: resolvedName,
        slug: resolvedSlug,
      },
    });

    assert(response.type === "json");
    return response.data;
  };

  const addMember = async (
    sessionId: string,
    organizationId: string,
    userId: string,
    roles?: string[],
  ) =>
    fragment.callRoute("POST", "/organizations/:organizationId/members", {
      pathParams: { organizationId },
      query: { sessionId },
      body: { userId, roles },
    });

  afterAll(async () => {
    await test.cleanup();
  });

  it("creates organizations and lists them", async () => {
    const { sessionId } = await createUserWithSession("owner@orgs.test");

    const createResponse = await createOrganization(sessionId, "Acme", "acme");
    expect(createResponse.organization.slug).toBe("acme");
    expect(createResponse.member.roles).toEqual(["owner"]);

    const orgId = createResponse.organization.id;

    const listResponse = await fragment.callRoute("GET", "/organizations", {
      query: { sessionId },
    });

    assert(listResponse.type === "json");
    expect(listResponse.data.organizations).toHaveLength(1);
    expect(listResponse.data.organizations[0]?.member.roles).toEqual(["owner"]);

    const detailResponse = await fragment.callRoute("GET", "/organizations/:organizationId", {
      pathParams: { organizationId: orgId },
      query: { sessionId },
    });

    assert(detailResponse.type === "json");
    expect(detailResponse.data.organization.id).toBe(orgId);
    expect(detailResponse.data.member.roles).toEqual(["owner"]);
  });

  it("paginates organization listing and requires a valid session", async () => {
    const { sessionId } = await createUserWithSession();

    await createOrganization(sessionId, "Page Org One", "page-org-one");
    await createOrganization(sessionId, "Page Org Two", "page-org-two");

    const firstPage = await fragment.callRoute("GET", "/organizations", {
      query: { sessionId, pageSize: "1" },
    });

    assert(firstPage.type === "json");
    expect(firstPage.data.organizations).toHaveLength(1);
    expect(firstPage.data.hasNextPage).toBe(true);
    expect(firstPage.data.cursor).toBeTruthy();

    const missingSession = await fragment.callRoute("GET", "/organizations", {});
    assert(missingSession.type === "error");
    expect(missingSession.error.code).toBe("session_invalid");
  });

  it("rejects invalid cursors for organization and member listings", async () => {
    const { sessionId: ownerSessionId } = await createUserWithSession("cursor-owner@test.com");
    const { user: memberUser } = await createUserWithSession("cursor-member@test.com");

    const firstOrganization = await createOrganization(
      ownerSessionId,
      "Cursor Org One",
      "cursor-org-one",
    );
    await createOrganization(ownerSessionId, "Cursor Org Two", "cursor-org-two");

    const organizationsPage = await fragment.callRoute("GET", "/organizations", {
      query: { sessionId: ownerSessionId, pageSize: "1" },
    });

    assert(organizationsPage.type === "json");
    const organizationsCursor = organizationsPage.data.cursor;
    expect(organizationsCursor).toBeTruthy();
    if (!organizationsCursor) {
      throw new Error("Expected organizations cursor");
    }

    const malformedOrganizationsCursor = await fragment.callRoute("GET", "/organizations", {
      query: { sessionId: ownerSessionId, cursor: "not-a-valid-cursor" },
    });

    assert(malformedOrganizationsCursor.type === "error");
    expect(malformedOrganizationsCursor.error.code).toBe("invalid_input");
    expect(malformedOrganizationsCursor.status).toBe(400);

    const addMemberResponse = await addMember(
      ownerSessionId,
      firstOrganization.organization.id,
      memberUser.id,
      ["member"],
    );
    assert(addMemberResponse.type === "json");

    const membersPage = await fragment.callRoute("GET", "/organizations/:organizationId/members", {
      pathParams: { organizationId: firstOrganization.organization.id },
      query: { sessionId: ownerSessionId, pageSize: "1" },
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
        query: {
          sessionId: ownerSessionId,
          cursor: organizationsCursor,
        },
      },
    );

    assert(invalidMembersCursor.type === "error");
    expect(invalidMembersCursor.error.code).toBe("invalid_input");
    expect(invalidMembersCursor.status).toBe(400);

    const invalidOrganizationsCursor = await fragment.callRoute("GET", "/organizations", {
      query: {
        sessionId: ownerSessionId,
        cursor: membersCursor,
      },
    });

    assert(invalidOrganizationsCursor.type === "error");
    expect(invalidOrganizationsCursor.error.code).toBe("invalid_input");
    expect(invalidOrganizationsCursor.status).toBe(400);
  });

  it("invites members and accepts invitations", async () => {
    const { sessionId: ownerSessionId } = await createUserWithSession("invite-owner@test.com");
    const { user: invitedUser, sessionId: invitedSessionId } =
      await createUserWithSession("invitee@test.com");

    const createResponse = await fragment.callRoute("POST", "/organizations", {
      query: { sessionId: ownerSessionId },
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
        query: { sessionId: ownerSessionId },
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
        query: { sessionId: invitedSessionId },
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
        query: { sessionId: ownerSessionId },
      },
    );

    assert(membersResponse.type === "json");
    const inviteeMember = membersResponse.data.members.find(
      (member: { userId: string }) => member.userId === invitedUser.id,
    );
    expect(inviteeMember?.roles).toEqual(["member"]);
  });

  it("accepting an invitation is idempotent for existing members", async () => {
    const { sessionId: ownerSessionId } = await createUserWithSession("idempotent-owner@test.com");
    const { user: invitedUser, sessionId: invitedSessionId } = await createUserWithSession(
      "idempotent-invitee@test.com",
    );

    const createResponse = await fragment.callRoute("POST", "/organizations", {
      query: { sessionId: ownerSessionId },
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
        query: { sessionId: ownerSessionId },
        body: {
          email: invitedUser.email,
          roles: ["member"],
        },
      },
    );

    assert(inviteResponse.type === "json");

    const addMemberResponse = await addMember(ownerSessionId, orgId, invitedUser.id, ["member"]);
    assert(addMemberResponse.type === "json");

    const acceptResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        query: { sessionId: invitedSessionId },
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
        query: { sessionId: ownerSessionId },
      },
    );

    assert(membersResponse.type === "json");
    const inviteeMembers = membersResponse.data.members.filter(
      (member: { userId: string }) => member.userId === invitedUser.id,
    );
    expect(inviteeMembers).toHaveLength(1);
  });

  it("sets active organization explicitly and enforces membership", async () => {
    const { sessionId } = await createUserWithSession("active-owner@test.com");
    const { sessionId: nonMemberSessionId } = await createUserWithSession(
      "active-non-member@test.com",
    );

    const activeBefore = await fragment.callRoute("GET", "/organizations/active", {
      query: { sessionId },
    });
    expect(activeBefore.type).toBe("empty");

    const createResponse = await createOrganization(sessionId, "Active Org", "active-org");
    const orgId = createResponse.organization.id;

    const missingMembership = await fragment.callRoute("POST", "/organizations/active", {
      query: { sessionId: nonMemberSessionId },
      body: { organizationId: orgId },
    });

    assert(missingMembership.type === "error");
    expect(missingMembership.error.code).toBe("membership_not_found");

    const setActiveResponse = await fragment.callRoute("POST", "/organizations/active", {
      query: { sessionId },
      body: { organizationId: orgId },
    });

    assert(setActiveResponse.type === "json");
    expect(setActiveResponse.data.organization.id).toBe(orgId);

    const activeResponse = await fragment.callRoute("GET", "/organizations/active", {
      query: { sessionId },
    });

    assert(activeResponse.type === "json");
    expect(activeResponse.data?.organization.id).toBe(orgId);
  });

  it("enforces membership for organization details", async () => {
    const { sessionId } = await createUserWithSession("detail-owner@test.com");
    const { sessionId: nonMemberSessionId } = await createUserWithSession(
      "detail-non-member@test.com",
    );

    const created = await createOrganization(sessionId, "Detail Org", "detail-org");

    const detailResponse = await fragment.callRoute("GET", "/organizations/:organizationId", {
      pathParams: { organizationId: created.organization.id },
      query: { sessionId: nonMemberSessionId },
    });

    assert(detailResponse.type === "error");
    expect(detailResponse.error.code).toBe("permission_denied");
    expect(detailResponse.status).toBe(403);
  });

  it("updates and deletes organizations with permission checks", async () => {
    const { sessionId: ownerSessionId } = await createUserWithSession("update-owner@test.com");
    const { user: memberUser, sessionId: memberSessionId } =
      await createUserWithSession("update-member@test.com");

    const created = await createOrganization(ownerSessionId, "Update Org", "update-org");

    const addMemberResponse = await addMember(
      ownerSessionId,
      created.organization.id,
      memberUser.id,
      ["member"],
    );
    assert(addMemberResponse.type === "json");

    const deniedUpdate = await fragment.callRoute("PATCH", "/organizations/:organizationId", {
      pathParams: { organizationId: created.organization.id },
      query: { sessionId: memberSessionId },
      body: { name: "Blocked Update" },
    });

    assert(deniedUpdate.type === "error");
    expect(deniedUpdate.error.code).toBe("permission_denied");
    expect(deniedUpdate.status).toBe(403);

    const updateResponse = await fragment.callRoute("PATCH", "/organizations/:organizationId", {
      pathParams: { organizationId: created.organization.id },
      query: { sessionId: ownerSessionId },
      body: { name: "Updated Org" },
    });

    assert(updateResponse.type === "json");
    expect(updateResponse.data.organization.name).toBe("Updated Org");

    const deniedDelete = await fragment.callRoute("DELETE", "/organizations/:organizationId", {
      pathParams: { organizationId: created.organization.id },
      query: { sessionId: memberSessionId },
    });

    assert(deniedDelete.type === "error");
    expect(deniedDelete.error.code).toBe("permission_denied");
    expect(deniedDelete.status).toBe(403);

    const deleteResponse = await fragment.callRoute("DELETE", "/organizations/:organizationId", {
      pathParams: { organizationId: created.organization.id },
      query: { sessionId: ownerSessionId },
    });

    assert(deleteResponse.type === "json");
    expect(deleteResponse.data.success).toBe(true);

    const updateDeleted = await fragment.callRoute("PATCH", "/organizations/:organizationId", {
      pathParams: { organizationId: created.organization.id },
      query: { sessionId: ownerSessionId },
      body: { name: "Still Deleted" },
    });

    assert(updateDeleted.type === "error");
    expect(updateDeleted.error.code).toBe("organization_not_found");
    expect(updateDeleted.status).toBe(404);

    const deleteDeleted = await fragment.callRoute("DELETE", "/organizations/:organizationId", {
      pathParams: { organizationId: created.organization.id },
      query: { sessionId: ownerSessionId },
    });

    assert(deleteDeleted.type === "error");
    expect(deleteDeleted.error.code).toBe("organization_not_found");
    expect(deleteDeleted.status).toBe(404);
  });

  it("manages members with pagination and permissions", async () => {
    const { sessionId: ownerSessionId } = await createUserWithSession("member-owner@test.com");
    const { user: memberUser, sessionId: memberSessionId } =
      await createUserWithSession("member-user@test.com");
    const { user: secondMember } = await createUserWithSession("member-two@test.com");
    const { sessionId: nonMemberSessionId } = await createUserWithSession(
      "member-outsider@test.com",
    );

    const created = await createOrganization(ownerSessionId, "Members Org", "members-org");

    const deniedAdd = await addMember(memberSessionId, created.organization.id, secondMember.id, [
      "member",
    ]);
    assert(deniedAdd.type === "error");
    expect(deniedAdd.error.code).toBe("permission_denied");

    const addMemberResponse = await addMember(
      ownerSessionId,
      created.organization.id,
      memberUser.id,
      ["member"],
    );
    assert(addMemberResponse.type === "json");

    const addSecondResponse = await addMember(
      ownerSessionId,
      created.organization.id,
      secondMember.id,
      ["member"],
    );
    assert(addSecondResponse.type === "json");

    const firstPage = await fragment.callRoute("GET", "/organizations/:organizationId/members", {
      pathParams: { organizationId: created.organization.id },
      query: { sessionId: ownerSessionId, pageSize: "1" },
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
        query: { sessionId: nonMemberSessionId },
      },
    );

    assert(forbiddenList.type === "error");
    expect(forbiddenList.error.code).toBe("permission_denied");
  });

  it("updates and removes members with permission checks", async () => {
    const { sessionId: ownerSessionId } = await createUserWithSession("role-owner@test.com");
    const { user: memberUser } = await createUserWithSession("role-member@test.com");
    const { user: nonAdminUser, sessionId: nonAdminSessionId } =
      await createUserWithSession("role-non-admin@test.com");

    const created = await createOrganization(ownerSessionId, "Role Org", "role-org");

    const addMemberResponse = await addMember(
      ownerSessionId,
      created.organization.id,
      memberUser.id,
      ["member"],
    );
    assert(addMemberResponse.type === "json");

    const memberId = addMemberResponse.data.member.id;

    const addNonAdmin = await addMember(ownerSessionId, created.organization.id, nonAdminUser.id, [
      "member",
    ]);
    assert(addNonAdmin.type === "json");

    const deniedUpdate = await fragment.callRoute(
      "PATCH",
      "/organizations/:organizationId/members/:memberId",
      {
        pathParams: { organizationId: created.organization.id, memberId },
        query: { sessionId: nonAdminSessionId },
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
        query: { sessionId: nonAdminSessionId },
      },
    );

    assert(deniedRemove.type === "error");
    expect(deniedRemove.error.code).toBe("permission_denied");

    const updateResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/:organizationId/members/:memberId",
      {
        pathParams: { organizationId: created.organization.id, memberId },
        query: { sessionId: ownerSessionId },
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
        query: { sessionId: ownerSessionId },
      },
    );

    assert(removeResponse.type === "json");
    expect(removeResponse.data.success).toBe(true);
  });

  it("returns session_invalid for member mutations with invalid sessions", async () => {
    const { sessionId: ownerSessionId } = await createUserWithSession(
      "invalid-member-owner@test.com",
    );
    const { user: memberUser } = await createUserWithSession("invalid-member-user@test.com");

    const created = await createOrganization(
      ownerSessionId,
      "Invalid Session Org",
      "invalid-session-org",
    );

    const addMemberResponse = await addMember(
      ownerSessionId,
      created.organization.id,
      memberUser.id,
      ["member"],
    );
    assert(addMemberResponse.type === "json");

    const memberId = addMemberResponse.data.member.id;
    const invalidSessionId = "invalid-session-id";

    const invalidCreate = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/members",
      {
        pathParams: { organizationId: created.organization.id },
        query: { sessionId: invalidSessionId },
        body: { userId: memberUser.id },
      },
    );

    assert(invalidCreate.type === "error");
    expect(invalidCreate.error.code).toBe("session_invalid");
    expect(invalidCreate.status).toBe(401);

    const invalidUpdate = await fragment.callRoute(
      "PATCH",
      "/organizations/:organizationId/members/:memberId",
      {
        pathParams: { organizationId: created.organization.id, memberId },
        query: { sessionId: invalidSessionId },
        body: { roles: ["member"] },
      },
    );

    assert(invalidUpdate.type === "error");
    expect(invalidUpdate.error.code).toBe("session_invalid");
    expect(invalidUpdate.status).toBe(401);

    const invalidDelete = await fragment.callRoute(
      "DELETE",
      "/organizations/:organizationId/members/:memberId",
      {
        pathParams: { organizationId: created.organization.id, memberId },
        query: { sessionId: invalidSessionId },
      },
    );

    assert(invalidDelete.type === "error");
    expect(invalidDelete.error.code).toBe("session_invalid");
    expect(invalidDelete.status).toBe(401);
  });

  it("returns organization_not_found when adding members to missing organizations", async () => {
    const { sessionId } = await createUserWithSession("missing-org-owner@test.com");
    const { user: memberUser } = await createUserWithSession("missing-org-member@test.com");

    const response = await fragment.callRoute("POST", "/organizations/:organizationId/members", {
      pathParams: { organizationId: "missing-org-id" },
      query: { sessionId },
      body: { userId: memberUser.id },
    });

    assert(response.type === "error");
    expect(response.error.code).toBe("organization_not_found");
    expect(response.status).toBe(404);
  });

  it("lists invitations and handles invitation errors", async () => {
    const { sessionId: ownerSessionId } = await createUserWithSession("invite-list-owner@test.com");
    const { user: memberUser, sessionId: memberSessionId } = await createUserWithSession(
      "invite-list-member@test.com",
    );
    const { user: inviteeUser, sessionId: inviteeSessionId } = await createUserWithSession(
      "invite-list-invitee@test.com",
    );
    const { sessionId: outsiderSessionId } = await createUserWithSession(
      "invite-list-outsider@test.com",
    );

    const created = await createOrganization(ownerSessionId, "Invite List Org", "invite-list-org");

    const addMemberResponse = await addMember(
      ownerSessionId,
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
        query: { sessionId: memberSessionId },
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
        query: { sessionId: ownerSessionId },
        body: { email: inviteeUser.email, roles: ["member"] },
      },
    );

    assert(inviteResponse.type === "json");

    const listOrgInvites = await fragment.callRoute(
      "GET",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: created.organization.id },
        query: { sessionId: ownerSessionId },
      },
    );

    assert(listOrgInvites.type === "json");
    expect(listOrgInvites.data.invitations).toHaveLength(1);

    const forbiddenMemberInvites = await fragment.callRoute(
      "GET",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: created.organization.id },
        query: { sessionId: memberSessionId },
      },
    );

    assert(forbiddenMemberInvites.type === "error");
    expect(forbiddenMemberInvites.error.code).toBe("permission_denied");

    const forbiddenOrgInvites = await fragment.callRoute(
      "GET",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: created.organization.id },
        query: { sessionId: outsiderSessionId },
      },
    );

    assert(forbiddenOrgInvites.type === "error");
    expect(forbiddenOrgInvites.error.code).toBe("permission_denied");

    const listUserInvites = await fragment.callRoute("GET", "/organizations/invitations", {
      query: { sessionId: inviteeSessionId },
    });

    assert(listUserInvites.type === "json");
    expect(listUserInvites.data.invitations).toHaveLength(1);

    const invalidToken = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        query: { sessionId: inviteeSessionId },
        body: { action: "accept", token: "invalid-token" },
      },
    );

    assert(invalidToken.type === "error");
    expect(invalidToken.error.code).toBe("invalid_token");
  });

  it("resends invitations for the same email and updates roles", async () => {
    const { sessionId: ownerSessionId } = await createUserWithSession(
      "invite-resend-owner@test.com",
    );
    const { user: invitedUser, sessionId: invitedSessionId } = await createUserWithSession(
      "invite-resend-user@test.com",
    );

    const created = await createOrganization(ownerSessionId, "Resend Org", "resend-org");

    const firstInvite = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: created.organization.id },
        query: { sessionId: ownerSessionId },
        body: { email: invitedUser.email, roles: ["member"] },
      },
    );

    assert(firstInvite.type === "json");

    const secondInvite = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: created.organization.id },
        query: { sessionId: ownerSessionId },
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
        query: { sessionId: ownerSessionId },
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
        query: { sessionId: invitedSessionId },
        body: { action: "accept", token: firstInvite.data.invitation.token },
      },
    );

    assert(tamperedAccept.type === "error");
    expect(tamperedAccept.error.code).toBe("invalid_token");
  });

  it("rejects tokens from other invitations", async () => {
    const { sessionId: ownerSessionId } = await createUserWithSession(
      "invite-token-owner@test.com",
    );
    const { user: inviteeA, sessionId: inviteeSessionId } =
      await createUserWithSession("invite-token-a@test.com");
    const { user: inviteeB } = await createUserWithSession("invite-token-b@test.com");

    const created = await createOrganization(ownerSessionId, "Token Org", "token-org");

    const inviteA = await fragment.callRoute("POST", "/organizations/:organizationId/invitations", {
      pathParams: { organizationId: created.organization.id },
      query: { sessionId: ownerSessionId },
      body: { email: inviteeA.email, roles: ["member"] },
    });

    const inviteB = await fragment.callRoute("POST", "/organizations/:organizationId/invitations", {
      pathParams: { organizationId: created.organization.id },
      query: { sessionId: ownerSessionId },
      body: { email: inviteeB.email, roles: ["member"] },
    });

    assert(inviteA.type === "json");
    assert(inviteB.type === "json");

    const tamperedAccept = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteA.data.invitation.id },
        query: { sessionId: inviteeSessionId },
        body: { action: "accept", token: inviteB.data.invitation.token },
      },
    );

    assert(tamperedAccept.type === "error");
    expect(tamperedAccept.error.code).toBe("invalid_token");
  });

  it("blocks accepting invitations for a different email", async () => {
    const { sessionId: ownerSessionId } = await createUserWithSession(
      "invite-owner-mismatch@test.com",
    );
    const { user: invitedUser } = await createUserWithSession("invitee-mismatch@test.com");
    const { sessionId: otherSessionId } = await createUserWithSession("other-mismatch@test.com");

    const createResponse = await createOrganization(ownerSessionId, "Mismatch Org", "mismatch-org");
    const orgId = createResponse.organization.id;

    const inviteResponse = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: orgId },
        query: { sessionId: ownerSessionId },
        body: { email: invitedUser.email, roles: ["member"] },
      },
    );

    assert(inviteResponse.type === "json");

    const acceptResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        query: { sessionId: otherSessionId },
        body: { action: "accept", token: inviteResponse.data.invitation.token },
      },
    );

    assert(acceptResponse.type === "error");
    expect(acceptResponse.error.code).toBe("permission_denied");
    expect(acceptResponse.status).toBe(403);
  });

  it("blocks rejecting invitations for a different email", async () => {
    const { sessionId: ownerSessionId } = await createUserWithSession(
      "invite-owner-reject@test.com",
    );
    const { user: invitedUser } = await createUserWithSession("invitee-reject@test.com");
    const { sessionId: otherSessionId } = await createUserWithSession("other-reject@test.com");

    const createResponse = await createOrganization(ownerSessionId, "Reject Org", "reject-org");
    const orgId = createResponse.organization.id;

    const inviteResponse = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: orgId },
        query: { sessionId: ownerSessionId },
        body: { email: invitedUser.email, roles: ["member"] },
      },
    );

    assert(inviteResponse.type === "json");

    const rejectResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        query: { sessionId: otherSessionId },
        body: { action: "reject", token: inviteResponse.data.invitation.token },
      },
    );

    assert(rejectResponse.type === "error");
    expect(rejectResponse.error.code).toBe("permission_denied");
    expect(rejectResponse.status).toBe(403);
  });

  it("allows the inviter to cancel invitations", async () => {
    const { sessionId: ownerSessionId } = await createUserWithSession(
      "invite-owner-cancel@test.com",
    );
    const { user: invitedUser } = await createUserWithSession("invitee-cancel@test.com");

    const createResponse = await createOrganization(ownerSessionId, "Cancel Org", "cancel-org");
    const orgId = createResponse.organization.id;

    const inviteResponse = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: orgId },
        query: { sessionId: ownerSessionId },
        body: { email: invitedUser.email, roles: ["member"] },
      },
    );

    assert(inviteResponse.type === "json");

    const cancelResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        query: { sessionId: ownerSessionId },
        body: { action: "cancel" },
      },
    );

    assert(cancelResponse.type === "json");
    expect(cancelResponse.data.invitation.status).toBe("canceled");
  });

  it("allows organization admins to cancel invitations", async () => {
    const { sessionId: ownerSessionId } = await createUserWithSession(
      "invite-owner-admin-cancel@test.com",
    );
    const { user: adminUser, sessionId: adminSessionId } = await createUserWithSession(
      "invite-admin-cancel@test.com",
    );
    const { user: invitedUser } = await createUserWithSession("invitee-admin-cancel@test.com");

    const createResponse = await createOrganization(
      ownerSessionId,
      "Admin Cancel Org",
      "admin-cancel-org",
    );
    const orgId = createResponse.organization.id;

    const adminAddResponse = await addMember(ownerSessionId, orgId, adminUser.id, ["admin"]);
    assert(adminAddResponse.type === "json");

    const inviteResponse = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: orgId },
        query: { sessionId: ownerSessionId },
        body: { email: invitedUser.email, roles: ["member"] },
      },
    );

    assert(inviteResponse.type === "json");

    const cancelResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        query: { sessionId: adminSessionId },
        body: { action: "cancel" },
      },
    );

    assert(cancelResponse.type === "json");
    expect(cancelResponse.data.invitation.status).toBe("canceled");
  });

  it("denies cancel for non-admin non-inviters", async () => {
    const { sessionId: ownerSessionId } = await createUserWithSession(
      "invite-owner-deny-cancel@test.com",
    );
    const { user: memberUser, sessionId: memberSessionId } = await createUserWithSession(
      "invite-member-deny-cancel@test.com",
    );
    const { user: invitedUser } = await createUserWithSession("invitee-deny-cancel@test.com");

    const createResponse = await createOrganization(
      ownerSessionId,
      "Deny Cancel Org",
      "deny-cancel-org",
    );
    const orgId = createResponse.organization.id;

    const addMemberResponse = await addMember(ownerSessionId, orgId, memberUser.id, ["member"]);
    assert(addMemberResponse.type === "json");

    const inviteResponse = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: orgId },
        query: { sessionId: ownerSessionId },
        body: { email: invitedUser.email, roles: ["member"] },
      },
    );

    assert(inviteResponse.type === "json");

    const cancelResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        query: { sessionId: memberSessionId },
        body: { action: "cancel" },
      },
    );

    assert(cancelResponse.type === "error");
    expect(cancelResponse.error.code).toBe("permission_denied");
    expect(cancelResponse.status).toBe(403);
  });

  it("returns invitation_expired for expired invitations", async () => {
    const { user: ownerUser, sessionId: ownerSessionId } = await createUserWithSession(
      "invite-owner-expired@test.com",
    );
    const { user: invitedUser, sessionId: invitedSessionId } = await createUserWithSession(
      "invitee-expired@test.com",
    );

    const createResponse = await createOrganization(
      ownerSessionId,
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
        query: { sessionId: invitedSessionId },
        body: { action: "accept", token: invitationResult.invitation.token },
      },
    );

    assert(acceptResponse.type === "error");
    expect(acceptResponse.error.code).toBe("invitation_expired");
  });

  it("cancels pending invitations when an organization is deleted", async () => {
    const { sessionId: ownerSessionId } = await createUserWithSession(
      "invite-delete-owner@test.com",
    );
    const { user: invitedUser, sessionId: invitedSessionId } = await createUserWithSession(
      "invite-delete-user@test.com",
    );

    const created = await createOrganization(ownerSessionId, "Invite Delete Org", "invite-del-org");

    const inviteResponse = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: created.organization.id },
        query: { sessionId: ownerSessionId },
        body: { email: invitedUser.email, roles: ["member"] },
      },
    );

    assert(inviteResponse.type === "json");

    const deleteResponse = await fragment.callRoute("DELETE", "/organizations/:organizationId", {
      pathParams: { organizationId: created.organization.id },
      query: { sessionId: ownerSessionId },
    });

    assert(deleteResponse.type === "json");
    expect(deleteResponse.data.success).toBe(true);

    const acceptResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        query: { sessionId: invitedSessionId },
        body: { action: "accept", token: inviteResponse.data.invitation.token },
      },
    );

    assert(acceptResponse.type === "error");
    expect(acceptResponse.error.code).toBe("invitation_not_found");

    const listUserInvites = await fragment.callRoute("GET", "/organizations/invitations", {
      query: { sessionId: invitedSessionId },
    });

    assert(listUserInvites.type === "json");
    expect(listUserInvites.data.invitations).toHaveLength(0);
  });

  it("requires a token when rejecting invitations", async () => {
    const { sessionId: ownerSessionId } = await createUserWithSession(
      "invite-owner-reject-token@test.com",
    );
    const { user: invitedUser, sessionId: invitedSessionId } = await createUserWithSession(
      "invitee-reject-token@test.com",
    );

    const createResponse = await createOrganization(
      ownerSessionId,
      "Reject Token Org",
      "reject-token-org",
    );
    const orgId = createResponse.organization.id;

    const inviteResponse = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: orgId },
        query: { sessionId: ownerSessionId },
        body: { email: invitedUser.email, roles: ["member"] },
      },
    );

    assert(inviteResponse.type === "json");

    const rejectResponse = await fragment.callRoute(
      "PATCH",
      "/organizations/invitations/:invitationId",
      {
        pathParams: { invitationId: inviteResponse.data.invitation.id },
        query: { sessionId: invitedSessionId },
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

  const createUserWithSession = async (email?: string) => {
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
        .withServiceCalls(() => [fragment.services.createSession(user.id)])
        .execute();
    });

    if (!session.ok) {
      throw new Error(`Failed to create session: ${session.code}`);
    }

    return { user, sessionId: session.session.id };
  };

  const createOrganization = async (sessionId: string, name?: string, slug?: string) => {
    const resolvedName = name ?? `Limit Org ${(organizationCounter += 1)}`;
    const resolvedSlug = slug ?? `limit-org-${organizationCounter}`;
    const response = await fragment.callRoute("POST", "/organizations", {
      query: { sessionId },
      body: {
        name: resolvedName,
        slug: resolvedSlug,
      },
    });

    assert(response.type === "json");
    return response.data;
  };

  const addMember = async (
    sessionId: string,
    organizationId: string,
    userId: string,
    roles?: string[],
  ) =>
    fragment.callRoute("POST", "/organizations/:organizationId/members", {
      pathParams: { organizationId },
      query: { sessionId },
      body: { userId, roles },
    });

  afterAll(async () => {
    await test.cleanup();
  });

  it("enforces organizationsPerUser based on full membership count", async () => {
    const { sessionId } = await createUserWithSession("limit-owner@test.com");
    const { user: memberUser } = await createUserWithSession("limit-member@test.com");

    const firstOrg = await createOrganization(sessionId, "Limit Org One", "limit-org-one");
    await createOrganization(sessionId, "Limit Org Two", "limit-org-two");

    const addMemberResponse = await addMember(sessionId, firstOrg.organization.id, memberUser.id, [
      "member",
    ]);
    assert(addMemberResponse.type === "json");

    const thirdOrg = await fragment.callRoute("POST", "/organizations", {
      query: { sessionId },
      body: { name: "Limit Org Three", slug: "limit-org-three" },
    });

    assert(thirdOrg.type === "error");
    expect(thirdOrg.error.code).toBe("limit_reached");
  });

  it("rejects invitation acceptance when membersPerOrganization is reached", async () => {
    const { sessionId: ownerSessionId } = await createUserWithSession(
      "invite-limit-owner@test.com",
    );
    const { user: memberUser } = await createUserWithSession("invite-limit-member@test.com");
    const { user: inviteeUser, sessionId: inviteeSessionId } = await createUserWithSession(
      "invite-limit-invitee@test.com",
    );

    const created = await createOrganization(
      ownerSessionId,
      "Invite Limit Org",
      "invite-limit-org",
    );
    const orgId = created.organization.id;

    const addMemberResponse = await addMember(ownerSessionId, orgId, memberUser.id, ["member"]);
    assert(addMemberResponse.type === "json");

    const inviteResponse = await fragment.callRoute(
      "POST",
      "/organizations/:organizationId/invitations",
      {
        pathParams: { organizationId: orgId },
        query: { sessionId: ownerSessionId },
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
        query: { sessionId: inviteeSessionId },
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
    const { sessionId: ownerSessionId } = await createUserWithSession("roles-owner@test.com");
    const { user: memberUser } = await createUserWithSession("roles-member@test.com");

    const created = await createOrganization(ownerSessionId, "Roles Org", "roles-org");
    const orgId = created.organization.id;

    const addMemberResponse = await addMember(ownerSessionId, orgId, memberUser.id, [
      "admin",
      "member",
    ]);
    assert(addMemberResponse.type === "json");

    const listResponse = await fragment.callRoute("GET", "/organizations/:organizationId/members", {
      pathParams: { organizationId: orgId },
      query: { sessionId: ownerSessionId },
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
