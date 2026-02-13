import { afterAll, assert, describe, expect, it } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import { authFragmentDefinition } from "..";
import { userActionsRoutesFactory } from "../user/user-actions";
import { sessionRoutesFactory } from "../session/session";
import { organizationRoutesFactory } from "./routes";
import { hashPassword } from "../user/password";

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
        .withServiceCalls(() => [fragment.services.createUser(resolvedEmail, passwordHash)])
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
});
