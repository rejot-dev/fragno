import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";
import { authFragmentDefinition } from ".";
import { userActionsRoutesFactory } from "./user/user-actions";
import { sessionRoutesFactory } from "./session/session";
import { userOverviewRoutesFactory } from "./user/user-overview";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import { hashPassword } from "./user/password";
import { getInternalFragment } from "@fragno-dev/db";

describe("auth-fragment", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition).withRoutes([
        userActionsRoutesFactory,
        sessionRoutesFactory,
        userOverviewRoutesFactory,
      ]),
    )
    .build();

  const fragment = fragments.auth;
  let adminSessionId: string;

  afterAll(async () => {
    await test.cleanup();
  });

  beforeAll(async () => {
    const passwordHash = await hashPassword("adminpassword123");
    const [adminUser] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUser("admin@test.com", passwordHash, "admin"),
        ])
        .execute();
    });

    const [adminSession] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.createSession(adminUser.id)])
        .execute();
    });

    adminSessionId = adminSession.id;
  });

  describe("Full session flow", async () => {
    let sessionId: string;
    let userId: string;

    it("/sign-up - create user", async () => {
      const response = await fragment.callRoute("POST", "/sign-up", {
        body: {
          email: "test@test.com",
          password: "password",
        },
      });
      assert(response.type === "json");
      expect(response.data).toMatchObject({
        sessionId: expect.any(String),
        userId: expect.any(String),
        email: "test@test.com",
      });
      const data = response.data;
      sessionId = data.sessionId;
      userId = data.userId;
    });

    it("/sign-up - duplicate email", async () => {
      const response = await fragment.callRoute("POST", "/sign-up", {
        body: {
          email: "test@test.com",
          password: "password",
        },
      });

      assert(response.type === "error");
      expect(response.error.code).toBe("email_already_exists");
    });

    it("/me - get active session", async () => {
      const response = await fragment.callRoute("GET", "/me", {
        query: { sessionId },
      });

      assert(response.type === "json");
      expect(response.data).toMatchObject({
        user: {
          id: userId,
          email: "test@test.com",
          role: "user",
        },
        organizations: [],
        activeOrganization: null,
        invitations: [],
      });
    });

    it("/me - includes organizations and invitations", async () => {
      const [ownedOrg] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.createOrganization({
              name: "My Org",
              slug: "my-org",
              creatorUserId: userId,
              creatorUserRole: "user",
              sessionId,
            }),
          ])
          .execute();
      });

      assert(ownedOrg.ok);

      await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.setActiveOrganization(sessionId, ownedOrg.organization.id),
          ])
          .execute();
      });

      const otherPassword = await hashPassword("otherpassword123");
      const [otherUser] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.createUser("other-owner@test.com", otherPassword),
          ])
          .execute();
      });

      const [otherOrg] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.createOrganization({
              name: "Other Org",
              slug: "other-org",
              creatorUserId: otherUser.id,
              creatorUserRole: otherUser.role,
            }),
          ])
          .execute();
      });

      assert(otherOrg.ok);

      const [invitation] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.createOrganizationInvitation({
              organizationId: otherOrg.organization.id,
              email: "test@test.com",
              inviterId: otherUser.id,
              roles: ["member"],
              actor: { userId: otherUser.id, userRole: otherUser.role },
            }),
          ])
          .execute();
      });

      assert(invitation.ok);

      const meResponse = await fragment.callRoute("GET", "/me", {
        query: { sessionId },
      });

      assert(meResponse.type === "json");
      expect(meResponse.data.organizations).toHaveLength(1);
      expect(meResponse.data.organizations[0]?.organization.id).toBe(ownedOrg.organization.id);
      expect(meResponse.data.activeOrganization?.organization.id).toBe(ownedOrg.organization.id);
      expect(meResponse.data.invitations).toHaveLength(1);
      expect(meResponse.data.invitations[0]?.invitation.email).toBe("test@test.com");
      expect(meResponse.data.invitations[0]?.organization.id).toBe(otherOrg.organization.id);
    });

    it("/sign-out - invalidate session", async () => {
      const response = await fragment.callRoute("POST", "/sign-out", {
        body: { sessionId },
      });
      assert(response.type === "json");
      expect(response.data).toMatchObject({ success: true });
    });

    it("/me - get inactive session", async () => {
      const response = await fragment.callRoute("GET", "/me", {
        query: { sessionId },
      });

      assert(response.type === "error");
      expect(response.error.code).toBe("session_invalid");
    });

    it("/sign-in - invalid credentials", async () => {
      const response = await fragment.callRoute("POST", "/sign-in", {
        body: { email: "test@test.com", password: "wrongpassword" },
      });
      assert(response.type === "error");
      expect(response.error.code).toBe("invalid_credentials");
    });

    it("/sign-in - sign in user", async () => {
      const response = await fragment.callRoute("POST", "/sign-in", {
        body: { email: "test@test.com", password: "password" },
      });
      assert(response.type === "json");
      expect(response.data).toMatchObject({
        sessionId: expect.any(String),
        userId: expect.any(String),
        email: "test@test.com",
      });

      const data = response.data as { sessionId: string; userId: string; email: string };
      sessionId = data.sessionId;
      userId = data.userId;
    });

    it("/change-password - update password", async () => {
      const response = await fragment.callRoute("POST", "/change-password", {
        query: { sessionId },
        body: { newPassword: "newpassword123" },
      });

      assert(response.type === "json");
      expect(response.data).toMatchObject({ success: true });

      const oldPasswordResponse = await fragment.callRoute("POST", "/sign-in", {
        body: { email: "test@test.com", password: "password" },
      });
      assert(oldPasswordResponse.type === "error");
      expect(oldPasswordResponse.error.code).toBe("invalid_credentials");

      const newPasswordResponse = await fragment.callRoute("POST", "/sign-in", {
        body: { email: "test@test.com", password: "newpassword123" },
      });
      assert(newPasswordResponse.type === "json");
      const data = newPasswordResponse.data as {
        sessionId: string;
        userId: string;
        email: string;
      };
      sessionId = data.sessionId;
      userId = data.userId;
    });

    it("/users/:userId/role - non-admin denied", async () => {
      const response = await fragment.callRoute("PATCH", "/users/:userId/role", {
        pathParams: { userId },
        query: { sessionId },
        body: { role: "admin" },
      });

      assert(response.type === "error");
      expect(response.error.code).toBe("permission_denied");
    });

    it("/users/:userId/role - admin update", async () => {
      const response = await fragment.callRoute("PATCH", "/users/:userId/role", {
        pathParams: { userId },
        query: { sessionId: adminSessionId },
        body: { role: "admin" },
      });

      assert(response.type === "json");
      expect(response.data).toMatchObject({ success: true });

      const meResponse = await fragment.callRoute("GET", "/me", {
        query: { sessionId },
      });

      assert(meResponse.type === "json");
      expect(meResponse.data).toMatchObject({
        user: {
          id: userId,
          email: "test@test.com",
          role: "admin",
        },
      });
    });

    it("GET /users - route returns users", async () => {
      const response = await fragment.callRoute("GET", "/users");

      assert(response.type === "json");
      expect(response.data).toMatchObject({
        users: expect.any(Array),
        hasNextPage: expect.any(Boolean),
        sortBy: expect.any(String),
      });
    });
  });

  describe("Service helpers", () => {
    it("buildSessionCookie - sets cookie name and value", () => {
      const cookie = fragment.services.buildSessionCookie("session-123");
      expect(cookie).toContain("sessionid=session-123");
      expect(cookie).toContain("Path=/");
    });

    it("getSession - returns undefined without cookie", async () => {
      const result = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [fragment.services.getSession(new Headers())])
          .transform(({ serviceResult: [session] }) => session)
          .execute();
      });

      expect(result).toBeUndefined();
    });

    it("getSession - returns user from cookie", async () => {
      const email = "cookie-user@test.com";
      const passwordHash = await hashPassword("cookiepassword123");
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

      const headers = new Headers({ Cookie: `sessionid=${session.id}` });
      const result = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [fragment.services.getSession(headers)])
          .transform(({ serviceResult: [sessionResult] }) => sessionResult)
          .execute();
      });

      expect(result).toMatchObject({
        userId: user.id,
        email,
      });
    });

    it("updateUserRole - updates role", async () => {
      const email = "role-user@test.com";
      const passwordHash = await hashPassword("rolepassword123");
      const [user] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [fragment.services.createUser(email, passwordHash)])
          .execute();
      });

      await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [fragment.services.updateUserRole(user.id, "admin")])
          .execute();
      });

      const updated = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [fragment.services.getUserByEmail(email)])
          .transform(({ serviceResult: [result] }) => result)
          .execute();
      });

      expect(updated?.role).toBe("admin");
    });

    it("updateUserPassword - updates password hash", async () => {
      const email = "password-user@test.com";
      const passwordHash = await hashPassword("password123");
      const [user] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [fragment.services.createUser(email, passwordHash)])
          .execute();
      });

      const nextHash = await hashPassword("newpassword456");
      await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [fragment.services.updateUserPassword(user.id, nextHash)])
          .execute();
      });

      const updated = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [fragment.services.getUserByEmail(email)])
          .transform(({ serviceResult: [result] }) => result)
          .execute();
      });

      expect(updated?.passwordHash).toBe(nextHash);
    });
  });

  describe("Hooks", () => {
    it("records auth and organization hook events", async () => {
      const passwordHash = await hashPassword("hookspassword123");
      const [user] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.createUser("hooks-user@test.com", passwordHash, "user"),
          ])
          .execute();
      });

      const [session] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [fragment.services.createSession(user.id)])
          .execute();
      });

      const [organizationResult] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.createOrganization({
              name: "Hooks Org",
              slug: "hooks-org",
              creatorUserId: user.id,
              creatorUserRole: user.role,
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
              email: "hooks-invitee@test.com",
              inviterId: user.id,
              actor: { userId: user.id, userRole: user.role },
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

      const userHooks = hooks.filter(
        (hook) => (hook.payload as { userId?: string }).userId === user.id,
      );
      expect(userHooks.some((hook) => hook.hookName === "onUserCreated")).toBe(true);
      expect(
        hooks.some(
          (hook) =>
            hook.hookName === "onSessionCreated" &&
            (hook.payload as { sessionId?: string }).sessionId === session.id,
        ),
      ).toBe(true);

      const orgHooks = hooks.filter(
        (hook) =>
          (hook.payload as { organizationId?: string }).organizationId ===
          organizationResult.organization.id,
      );
      expect(orgHooks.some((hook) => hook.hookName === "onOrganizationCreated")).toBe(true);
      expect(
        orgHooks.some(
          (hook) =>
            hook.hookName === "onMemberAdded" &&
            (hook.payload as { memberId?: string }).memberId === organizationResult.member.id,
        ),
      ).toBe(true);
      expect(
        orgHooks.some(
          (hook) =>
            hook.hookName === "onInvitationCreated" &&
            (hook.payload as { invitationId?: string }).invitationId ===
              invitationResult.invitation.id,
        ),
      ).toBe(true);
    });
  });
});
