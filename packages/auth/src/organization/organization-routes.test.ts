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

  const createUserWithSession = async (email: string) => {
    const passwordHash = await hashPassword("password");
    const [user] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.createUser(email, passwordHash)])
        .execute();
    });

    const [session] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.createSession(user.id)])
        .execute();
    });

    return { user, sessionId: session.id };
  };

  afterAll(async () => {
    await test.cleanup();
  });

  it("creates organizations and lists them", async () => {
    const { sessionId } = await createUserWithSession("owner@orgs.test");

    const createResponse = await fragment.callRoute("POST", "/organizations", {
      query: { sessionId },
      body: {
        name: "Acme",
        slug: "acme",
      },
    });

    assert(createResponse.type === "json");
    expect(createResponse.data.organization.slug).toBe("acme");
    expect(createResponse.data.member.roles).toEqual(["owner"]);

    const orgId = createResponse.data.organization.id;

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

  it("sets active organization explicitly", async () => {
    const { sessionId } = await createUserWithSession("active-owner@test.com");

    const createResponse = await fragment.callRoute("POST", "/organizations", {
      query: { sessionId },
      body: {
        name: "Active Org",
        slug: "active-org",
      },
    });

    assert(createResponse.type === "json");
    const orgId = createResponse.data.organization.id;

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
});
