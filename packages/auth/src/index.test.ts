import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { getInternalFragment } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { authFragmentDefinition } from ".";
import { authSchema } from "./schema";
import { sessionRoutesFactory } from "./session/session";
import { hashPassword } from "./user/password";
import { userActionsRoutesFactory } from "./user/user-actions";
import { userOverviewRoutesFactory } from "./user/user-overview";

const authHeaders = (token: string) => ({
  Cookie: `fragno_auth=${token}`,
});

describe("auth-fragment", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
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
  let adminCredentialToken: string;

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

    const [adminCredential] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.issueCredential(adminUser.id)])
        .execute();
    });

    if (!adminCredential.ok) {
      throw new Error(`Failed to issue admin credential: ${adminCredential.code}`);
    }
    adminCredentialToken = adminCredential.credential.id;
  });

  describe("Full auth flow", async () => {
    let credentialToken: string;
    let userId: string;
    let ownedOrganizationId: string;

    it("/sign-up - create user", async () => {
      const response = await fragment.callRoute("POST", "/sign-up", {
        body: {
          email: "test@test.com",
          password: "password",
        },
      });
      assert(response.type === "json");
      expect(response.data).toMatchObject({
        auth: {
          token: expect.any(String),
          kind: "session",
        },
        userId: expect.any(String),
        email: "test@test.com",
      });
      expect(response.data.auth.refreshToken).toBeUndefined();
      const data = response.data;
      credentialToken = data.auth.token;
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
      assert(response.error.code === "email_already_exists");
    });

    it("/me - get active session", async () => {
      const response = await fragment.callRoute("GET", "/me", {
        headers: authHeaders(credentialToken),
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
              credentialToken: credentialToken,
            }),
          ])
          .execute();
      });

      assert(ownedOrg.ok);
      ownedOrganizationId = ownedOrg.organization.id;

      await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.setActiveOrganizationForCredential({
              credentialToken: credentialToken,
              organizationId: ownedOrg.organization.id,
            }),
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
        headers: authHeaders(credentialToken),
      });

      assert(meResponse.type === "json");
      expect(meResponse.data.organizations).toHaveLength(1);
      expect(meResponse.data.organizations[0]?.organization.id).toBe(ownedOrg.organization.id);
      expect(meResponse.data.activeOrganization?.organization.id).toBe(ownedOrg.organization.id);
      expect(meResponse.data.invitations).toHaveLength(1);
      assert(meResponse.data.invitations[0]?.invitation.email === "test@test.com");
      expect(meResponse.data.invitations[0]?.organization.id).toBe(otherOrg.organization.id);
      assert(!("token" in meResponse.data.invitations[0]!.invitation));
    });

    it("/sign-out - invalidate session and emit onCredentialInvalidated", async () => {
      const invalidatedCredentialToken = credentialToken;
      const response = await fragment.callRoute("POST", "/sign-out", {
        headers: authHeaders(invalidatedCredentialToken),
      });
      assert(response.type === "json");
      expect(response.data).toMatchObject({ success: true });

      const internalFragment = getInternalFragment(test.adapter);
      const hooks = await internalFragment.inContext(async function () {
        return await this.handlerTx()
          .withServiceCalls(
            () => [internalFragment.services.hookService.getHooksByNamespace("auth")] as const,
          )
          .transform(({ serviceResult: [result] }) => result)
          .execute();
      });

      assert(
        hooks.some(
          (hook) =>
            hook.hookName === "onCredentialInvalidated" &&
            (hook.payload as { credential?: { id?: string } }).credential?.id ===
              invalidatedCredentialToken,
        ),
      );
    });

    it("/sign-out - clears the auth cookie when the credential is already invalid", async () => {
      const response = await fragment.callRoute("POST", "/sign-out", {
        headers: authHeaders(credentialToken),
        body: {},
      });

      assert(response.type === "error");
      assert(response.status === 401);
      assert(response.error.code === "credential_invalid");
      expect(response.headers.get("Set-Cookie")).toContain("fragno_auth=");
      expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    });

    it("/me - get inactive session", async () => {
      const response = await fragment.callRoute("GET", "/me", {
        headers: authHeaders(credentialToken),
      });

      assert(response.type === "error");
      assert(response.error.code === "credential_invalid");
    });

    it("/sign-in - invalid credentials", async () => {
      const response = await fragment.callRoute("POST", "/sign-in", {
        body: { email: "test@test.com", password: "wrongpassword" },
      });
      assert(response.type === "error");
      assert(response.error.code === "invalid_credentials");
    });

    it("/sign-in - sign in user", async () => {
      const response = await fragment.callRoute("POST", "/sign-in", {
        body: { email: "test@test.com", password: "password" },
      });
      assert(response.type === "json");
      expect(response.data).toMatchObject({
        auth: {
          token: expect.any(String),
          kind: "session",
        },
        userId: expect.any(String),
        email: "test@test.com",
      });

      const data = response.data as {
        auth: { token: string };
        userId: string;
        email: string;
      };
      credentialToken = data.auth.token;
      userId = data.userId;
    });

    it("/sign-in - emits db expiry metadata in onCredentialIssued", async () => {
      const response = await fragment.callRoute("POST", "/sign-in", {
        body: { email: "test@test.com", password: "password" },
      });
      assert(response.type === "json");

      const createdCredentialToken = response.data.auth.token;

      const internalFragment = getInternalFragment(test.adapter);
      const hooks = await internalFragment.inContext(async function () {
        return await this.handlerTx()
          .withServiceCalls(
            () => [internalFragment.services.hookService.getHooksByNamespace("auth")] as const,
          )
          .transform(({ serviceResult: [result] }) => result)
          .execute();
      });

      const sessionHook = hooks.find((hook) => {
        const payload = hook.payload as {
          credential?: {
            id?: string;
            expiresAt?: { tag?: string; offsetMs?: number } | Date | string;
          };
        } | null;
        return (
          hook.hookName === "onCredentialIssued" &&
          payload?.credential?.id === createdCredentialToken
        );
      });

      if (!sessionHook) {
        throw new Error(
          `Expected onCredentialIssued hook for credential ${createdCredentialToken}.`,
        );
      }

      const hookExpiresAt = (
        sessionHook.payload as {
          credential?: { expiresAt?: { tag?: string; offsetMs?: number } | Date | string };
        } | null
      )?.credential?.expiresAt;

      expect(hookExpiresAt).toMatchObject({
        tag: "db-now",
        offsetMs: 30 * 24 * 60 * 60 * 1000,
      });
    });

    it("/sign-in - seeds active organization from session input", async () => {
      const [secondOrg] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.createOrganization({
              name: "Second Org",
              slug: "second-org",
              creatorUserId: userId,
              creatorUserRole: "user",
              credentialToken: credentialToken,
            }),
          ])
          .execute();
      });

      assert(secondOrg.ok);

      const response = await fragment.callRoute("POST", "/sign-in", {
        body: {
          email: "test@test.com",
          password: "password",
          auth: {
            activeOrganizationId: secondOrg.organization.id,
          },
        },
      });

      assert(response.type === "json");
      credentialToken = response.data.auth.token;
      userId = response.data.userId;

      const meResponse = await fragment.callRoute("GET", "/me", {
        headers: authHeaders(credentialToken),
      });

      assert(meResponse.type === "json");
      expect(meResponse.data.activeOrganization?.organization.id).toBe(secondOrg.organization.id);
    });

    it("/sign-in - repairs stale active organization credential seeds", async () => {
      const response = await fragment.callRoute("POST", "/sign-in", {
        body: {
          email: "test@test.com",
          password: "password",
          auth: {
            activeOrganizationId: "organization-missing",
          },
        },
      });

      assert(response.type === "json");
      credentialToken = response.data.auth.token;
      userId = response.data.userId;

      const meResponse = await fragment.callRoute("GET", "/me", {
        headers: authHeaders(credentialToken),
      });

      assert(meResponse.type === "json");
      expect(meResponse.data.activeOrganization?.organization.id).toBe(ownedOrganizationId);
    });

    it("/sign-in - repairs credential seeds that target an organization the user cannot access", async () => {
      const outsiderPasswordHash = await hashPassword("outsider-password");
      const [outsider] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.createUserUnvalidated("outsider@test.com", outsiderPasswordHash),
          ])
          .execute();
      });

      const [outsiderOrg] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.createOrganization({
              name: "Outsider Org",
              slug: `outsider-org-${Date.now()}`,
              creatorUserId: outsider.id,
              creatorUserRole: "user",
            }),
          ])
          .execute();
      });

      assert(outsiderOrg.ok);

      const response = await fragment.callRoute("POST", "/sign-in", {
        body: {
          email: "test@test.com",
          password: "password",
          auth: {
            activeOrganizationId: outsiderOrg.organization.id,
          },
        },
      });

      assert(response.type === "json");
      credentialToken = response.data.auth.token;
      userId = response.data.userId;

      const meResponse = await fragment.callRoute("GET", "/me", {
        headers: authHeaders(credentialToken),
      });

      assert(meResponse.type === "json");
      expect(meResponse.data.activeOrganization?.organization.id).toBe(ownedOrganizationId);
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
      assert(response.error.code === "user_banned");
    });

    it("/change-password - update password", async () => {
      const response = await fragment.callRoute("POST", "/change-password", {
        headers: authHeaders(credentialToken),
        body: { newPassword: "newpassword123" },
      });

      assert(response.type === "json");
      expect(response.data).toMatchObject({ success: true });

      const oldPasswordResponse = await fragment.callRoute("POST", "/sign-in", {
        body: { email: "test@test.com", password: "password" },
      });
      assert(oldPasswordResponse.type === "error");
      assert(oldPasswordResponse.error.code === "invalid_credentials");

      const newPasswordResponse = await fragment.callRoute("POST", "/sign-in", {
        body: { email: "test@test.com", password: "newpassword123" },
      });
      assert(newPasswordResponse.type === "json");
      const data = newPasswordResponse.data as {
        auth: { token: string };
        userId: string;
        email: string;
      };
      credentialToken = data.auth.token;
      userId = data.userId;
    });

    it("/users/:userId/role - non-admin denied", async () => {
      const response = await fragment.callRoute("PATCH", "/users/:userId/role", {
        pathParams: { userId },
        headers: authHeaders(credentialToken),
        body: { role: "admin" },
      });

      assert(response.type === "error");
      assert(response.error.code === "permission_denied");
    });

    it("/users/:userId/role - admin update", async () => {
      const response = await fragment.callRoute("PATCH", "/users/:userId/role", {
        pathParams: { userId },
        headers: authHeaders(adminCredentialToken),
        body: { role: "admin" },
      });

      assert(response.type === "json");
      expect(response.data).toMatchObject({ success: true });

      const meResponse = await fragment.callRoute("GET", "/me", {
        headers: authHeaders(credentialToken),
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
    it("buildAuthCookie - sets cookie name and value", () => {
      const cookie = fragment.services.buildAuthCookie("session-123");
      expect(cookie).toContain("fragno_auth=session-123");
      expect(cookie).toContain("Path=/");
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
          .withServiceCalls(() => [fragment.services.setUserRole(user.id, "admin")])
          .execute();
      });

      const updated = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [fragment.services.getUserByEmail(email)])
          .transform(({ serviceResult: [result] }) => result)
          .execute();
      });

      assert(updated?.role === "admin");
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
          .withServiceCalls(() => [fragment.services.issueCredential(outsider.id)])
          .execute();
      });
      if (!outsiderSession.ok) {
        throw new Error(`Failed to issue credential: ${outsiderSession.code}`);
      }

      const [setResult] = await test.inContext(function () {
        return this.handlerTx()
          .withServiceCalls(() => [
            fragment.services.setActiveOrganizationForCredential({
              credentialToken: outsiderSession.credential.id,
              organizationId: orgResult.organization.id,
            }),
          ])
          .execute();
      });

      assert(!setResult.ok);
      if (!setResult.ok) {
        assert(setResult.code === "membership_not_found");
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
          .withServiceCalls(() => [fragment.services.issueCredential(user.id)])
          .execute();
      });
      if (!session.ok) {
        throw new Error(`Failed to issue credential: ${session.code}`);
      }
      const createdCredentialToken = session.credential?.id;
      if (!createdCredentialToken) {
        throw new Error("Expected credential id for hook test");
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
      assert(userHooks.some((hook) => hook.hookName === "onUserCreated"));
      assert(
        hooks.some(
          (hook) =>
            hook.hookName === "onCredentialIssued" &&
            (hook.payload as { credential?: { id?: string } }).credential?.id ===
              createdCredentialToken,
        ),
      );

      const orgHooks = hooks.filter(
        (hook) =>
          (hook.payload as { organization?: { id?: string } }).organization?.id ===
          organizationResult.organization.id,
      );
      assert(orgHooks.some((hook) => hook.hookName === "onOrganizationCreated"));
      assert(
        orgHooks.some(
          (hook) =>
            hook.hookName === "onMemberAdded" &&
            (hook.payload as { member?: { id?: string } }).member?.id ===
              organizationResult.member.id,
        ),
      );
      assert(
        orgHooks.some(
          (hook) =>
            hook.hookName === "onInvitationCreated" &&
            (hook.payload as { invitation?: { id?: string } }).invitation?.id ===
              invitationResult.invitation.id,
        ),
      );
    });
  });
});
