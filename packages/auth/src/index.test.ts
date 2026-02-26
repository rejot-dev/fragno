import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";
import { authFragmentDefinition } from ".";
import { userActionsRoutesFactory } from "./user/user-actions";
import { sessionRoutesFactory } from "./session/session";
import { userOverviewRoutesFactory } from "./user/user-overview";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import { hashPassword } from "./user/password";
import { getInternalFragment } from "@fragno-dev/db";
import { organizationRoutesFactory } from "./organization/routes";
import { authSchema } from "./schema";
import { tmpdir } from "node:os";
import { join } from "node:path";

const preOrganizationSchemaVersion = (() => {
  const index = authSchema.operations.findIndex(
    (operation) => operation.type === "add-table" && operation.tableName === "organization",
  );
  if (index === -1) {
    throw new Error("Expected auth schema to include organization table operations.");
  }
  if (index < 2) {
    throw new Error("Expected organization table to be added after user and session tables.");
  }
  return index;
})();

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
          fragment.services.createUserUnvalidated("admin@test.com", passwordHash, "admin"),
        ])
        .execute();
    });

    const [adminSession] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.createSession(adminUser.id)])
        .execute();
    });

    if (!adminSession.ok) {
      throw new Error(`Failed to create admin session: ${adminSession.code}`);
    }
    adminSessionId = adminSession.session.id;
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
            fragment.services.createUserUnvalidated("other-owner@test.com", otherPassword),
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
              actorMemberId: otherOrg.member.id,
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
      expect("token" in meResponse.data.invitations[0]!.invitation).toBe(false);
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

    it("/sign-in - banned user denied", async () => {
      const email = "banned-user@test.com";
      const password = "bannedpassword123";
      const passwordHash = await hashPassword(password);

      const [bannedUser] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [fragment.services.createUserUnvalidated(email, passwordHash)])
          .execute();
      });

      await test.inContext(function () {
        return this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(authSchema).update("user", bannedUser.id, (b) =>
              b.set({ bannedAt: new Date() }),
            );
            return true;
          })
          .execute();
      });

      const response = await fragment.callRoute("POST", "/sign-in", {
        body: { email, password },
      });

      assert(response.type === "error");
      expect(response.error.code).toBe("user_banned");
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
          .withServiceCalls(() => [fragment.services.createUserUnvalidated(email, passwordHash)])
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
      const createdSessionId = session.session?.id;
      if (!createdSessionId) {
        throw new Error("Expected session id for getSession test");
      }

      const headers = new Headers({ Cookie: `sessionid=${createdSessionId}` });
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
          .withServiceCalls(() => [fragment.services.createUserUnvalidated(email, passwordHash)])
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
          .withServiceCalls(() => [fragment.services.createUserUnvalidated(email, passwordHash)])
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

    it("setActiveOrganization - requires membership", async () => {
      const ownerPassword = await hashPassword("ownerpassword123");
      const [owner] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.createUserUnvalidated("active-owner@test.com", ownerPassword),
          ])
          .execute();
      });

      const [orgResult] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.createOrganization({
              name: "Active Org",
              slug: "active-org",
              creatorUserId: owner.id,
              creatorUserRole: owner.role,
            }),
          ])
          .execute();
      });

      assert(orgResult.ok);

      const outsiderPassword = await hashPassword("outsiderpassword123");
      const [outsider] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.createUserUnvalidated("active-outsider@test.com", outsiderPassword),
          ])
          .execute();
      });

      const [outsiderSession] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [fragment.services.createSession(outsider.id)])
          .execute();
      });
      if (!outsiderSession.ok) {
        throw new Error(`Failed to create session: ${outsiderSession.code}`);
      }

      const [setResult] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.setActiveOrganization(
              outsiderSession.session.id,
              orgResult.organization.id,
            ),
          ])
          .execute();
      });

      expect(setResult.ok).toBe(false);
      if (!setResult.ok) {
        expect(setResult.code).toBe("membership_not_found");
      }
    });
  });

  describe("Hooks", () => {
    it("records auth and organization hook events", async () => {
      const passwordHash = await hashPassword("hookspassword123");
      const [user] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.createUserUnvalidated("hooks-user@test.com", passwordHash, "user"),
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
      const createdSessionId = session.session?.id;
      if (!createdSessionId) {
        throw new Error("Expected session id for hook test");
      }

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

      const userHooks = hooks.filter(
        (hook) => (hook.payload as { user?: { id?: string } }).user?.id === user.id,
      );
      expect(userHooks.some((hook) => hook.hookName === "onUserCreated")).toBe(true);
      expect(
        hooks.some(
          (hook) =>
            hook.hookName === "onSessionCreated" &&
            (hook.payload as { session?: { id?: string } }).session?.id === createdSessionId,
        ),
      ).toBe(true);

      const orgHooks = hooks.filter(
        (hook) =>
          (hook.payload as { organization?: { id?: string } }).organization?.id ===
          organizationResult.organization.id,
      );
      expect(orgHooks.some((hook) => hook.hookName === "onOrganizationCreated")).toBe(true);
      expect(
        orgHooks.some(
          (hook) =>
            hook.hookName === "onMemberAdded" &&
            (hook.payload as { member?: { id?: string } }).member?.id ===
              organizationResult.member.id,
        ),
      ).toBe(true);
      expect(
        orgHooks.some(
          (hook) =>
            hook.hookName === "onInvitationCreated" &&
            (hook.payload as { invitation?: { id?: string } }).invitation?.id ===
              invitationResult.invitation.id,
        ),
      ).toBe(true);
    });
  });
});

describe("auth-fragment email/password disabled", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          emailAndPassword: {
            enabled: false,
          },
        })
        .withRoutes([userActionsRoutesFactory]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  it("blocks email/password sign-up when disabled", async () => {
    const response = await fragment.callRoute("POST", "/sign-up", {
      body: {
        email: "disabled@test.com",
        password: "password",
      },
    });

    assert(response.type === "error");
    expect(response.error.code).toBe("email_password_disabled");
    expect(response.status).toBe(403);
  });

  it("blocks email/password sign-in when disabled", async () => {
    const response = await fragment.callRoute("POST", "/sign-in", {
      body: {
        email: "disabled@test.com",
        password: "password",
      },
    });

    assert(response.type === "error");
    expect(response.error.code).toBe("email_password_disabled");
    expect(response.status).toBe(403);
  });
});

describe("auth-fragment organization upgrades", async () => {
  const databasePath = join(
    tmpdir(),
    `fragno-auth-upgrade-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite", databasePath })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({ organizations: false })
        .withRoutes([userActionsRoutesFactory, sessionRoutesFactory]),
      { migrateToVersion: preOrganizationSchemaVersion },
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  it("supports enabling organizations after upgrading", async () => {
    const signUpResponse = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "upgrade-user@test.com", password: "password" },
    });

    assert(signUpResponse.type === "json");
    const sessionId = signUpResponse.data.sessionId as string;

    const meBeforeUpgrade = await fragment.callRoute("GET", "/me", {
      query: { sessionId },
    });

    assert(meBeforeUpgrade.type === "json");
    expect(meBeforeUpgrade.data.organizations).toHaveLength(0);
    expect(meBeforeUpgrade.data.activeOrganization).toBeNull();

    if (!test.adapter.prepareMigrations) {
      throw new Error("Adapter does not support migrations in upgrade test.");
    }
    const migrations = test.adapter.prepareMigrations(authSchema, "auth");
    await migrations.execute(preOrganizationSchemaVersion, authSchema.version, {
      updateVersionInMigration: false,
    });

    const upgradedFragment = instantiate(authFragmentDefinition)
      .withConfig({ organizations: {} })
      .withOptions({ databaseAdapter: test.adapter })
      .withRoutes([userActionsRoutesFactory, sessionRoutesFactory, organizationRoutesFactory])
      .build();

    const meAfterUpgrade = await upgradedFragment.callRoute("GET", "/me", {
      query: { sessionId },
    });

    assert(meAfterUpgrade.type === "json");
    expect(meAfterUpgrade.data.organizations).toHaveLength(0);
    expect(meAfterUpgrade.data.activeOrganization).toBeNull();

    const createResponse = await upgradedFragment.callRoute("POST", "/organizations", {
      query: { sessionId },
      body: { name: "Upgraded Org", slug: "upgraded-org" },
    });

    assert(createResponse.type === "json");
    const createdOrgId = createResponse.data.organization.id as string;

    const meAfterCreate = await upgradedFragment.callRoute("GET", "/me", {
      query: { sessionId },
    });

    assert(meAfterCreate.type === "json");
    expect(meAfterCreate.data.organizations).toHaveLength(1);
    expect(meAfterCreate.data.organizations[0]?.organization.id).toBe(createdOrgId);

    const setActiveResponse = await upgradedFragment.callRoute("POST", "/organizations/active", {
      query: { sessionId },
      body: { organizationId: createdOrgId },
    });

    assert(setActiveResponse.type === "json");

    const meAfterActive = await upgradedFragment.callRoute("GET", "/me", {
      query: { sessionId },
    });

    assert(meAfterActive.type === "json");
    expect(meAfterActive.data.activeOrganization?.organization.id).toBe(createdOrgId);

    await drainDurableHooks(upgradedFragment);
  });
});

describe("auth-fragment auto-create organizations", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          organizations: {
            autoCreateOrganization: {
              name: ({ email }) => `${email.split("@")[0] ?? "user"} Workspace`,
              slug: ({ email }) => `${email.split("@")[0] ?? "user"}-workspace`,
            },
          },
        })
        .withRoutes([userActionsRoutesFactory, sessionRoutesFactory]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  it("creates a default organization on sign up", async () => {
    const signUpResponse = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "auto-org-user@test.com", password: "password" },
    });

    assert(signUpResponse.type === "json");
    const sessionId = signUpResponse.data.sessionId as string;

    const meResponse = await fragment.callRoute("GET", "/me", {
      query: { sessionId },
    });

    assert(meResponse.type === "json");
    expect(meResponse.data.organizations).toHaveLength(1);
    expect(meResponse.data.organizations[0]?.organization.slug).toBe("auto-org-user-workspace");
    expect(meResponse.data.activeOrganization?.organization.id).toBe(
      meResponse.data.organizations[0]?.organization.id ?? null,
    );
  });
});

describe("auth-fragment beforeCreateUser hook", async () => {
  const blockedDomain = "blocked.test";
  const hookCalls: string[] = [];
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          beforeCreateUser: ({ email }) => {
            hookCalls.push(email);
            if (email.endsWith(`@${blockedDomain}`)) {
              throw new Error("blocked_domain");
            }
          },
        })
        .withRoutes([]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  it("invokes beforeCreateUser and blocks matching domains", async () => {
    const passwordHash = await hashPassword("hookspassword123");
    await expect(
      test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.createUserUnvalidated(`user@${blockedDomain}`, passwordHash, "user"),
          ])
          .execute();
      }),
    ).rejects.toThrow(/blocked_domain/);
  });

  it("blocks sign-up flows when beforeCreateUser throws", async () => {
    const passwordHash = await hashPassword("hookspassword789");
    await expect(
      test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.signUpWithSession(`blocked@${blockedDomain}`, passwordHash),
          ])
          .execute();
      }),
    ).rejects.toThrow(/blocked_domain/);
  });

  it("allows user creation when hook passes", async () => {
    const passwordHash = await hashPassword("hookspassword456");
    const [user] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated("allowed@test.com", passwordHash),
        ])
        .execute();
    });

    expect(user.email).toBe("allowed@test.com");
    expect(hookCalls).toContain("allowed@test.com");
  });
});
