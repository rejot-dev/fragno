import { afterAll, assert, describe, expect, it } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { authFragmentDefinition } from "./index";
import { organizationRoutesFactory } from "./organization/routes";
import { authSchema } from "./schema";
import { sessionRoutesFactory } from "./session/session";
import { hashPassword } from "./user/password";
import { userActionsRoutesFactory } from "./user/user-actions";

const authHeaders = (token: string) => ({ Cookie: `fragno_auth=${token}` });

describe("auth email verification policy", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          emailVerification: {
            isExempt: ({ user }) => user.role === "admin",
          },
          hooks: {
            onUserEmailVerificationRequested() {},
          },
          beforeCreateUser: ({ email }) =>
            email === "admin@test.com" ? { role: "admin" } : undefined,
        })
        .withRoutes([userActionsRoutesFactory, sessionRoutesFactory, organizationRoutesFactory]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  it("creates an unverified user without issuing a credential", async () => {
    const signUp = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "verify-first@test.com", password: "password123" },
    });

    assert(signUp.type === "json");
    expect(signUp.data).toEqual({
      status: "email_verification_required",
      userId: expect.any(String),
      email: "verify-first@test.com",
      role: "user",
    });
    expect(signUp.headers.get("Set-Cookie")).toBeNull();

    const signInBeforeVerification = await fragment.callRoute("POST", "/sign-in", {
      body: { email: "verify-first@test.com", password: "password123" },
    });
    assert(signInBeforeVerification.type === "error");
    expect(signInBeforeVerification).toMatchObject({
      status: 403,
      error: { code: "email_verification_required" },
    });

    const [verified] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.verifyUserEmail({
            userId: signUp.data.userId,
            expectedEmail: signUp.data.email,
            verifiedAt: new Date("2026-07-22T12:00:00.000Z"),
          }),
        ])
        .execute();
    });
    assert(verified.ok);

    const signInAfterVerification = await fragment.callRoute("POST", "/sign-in", {
      body: { email: "verify-first@test.com", password: "password123" },
    });
    assert(signInAfterVerification.type === "json");
    expect(signInAfterVerification.data.auth.token).toEqual(expect.any(String));
  });

  it("issues a fresh credential for each successful call", async () => {
    const passwordHash = await hashPassword("password123");
    const [user] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated("repeated-login@test.com", passwordHash),
        ])
        .execute();
    });
    const [verified] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.verifyUserEmail({
            userId: user.id,
            expectedEmail: user.email,
            verifiedAt: new Date("2026-07-22T12:00:00.000Z"),
          }),
        ])
        .execute();
    });
    assert(verified.ok);

    const [first] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.issueCredential(user.id)])
        .execute();
    });
    const [repeated] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.issueCredential(user.id)])
        .execute();
    });

    assert(first.ok);
    assert(repeated.ok);
    expect(repeated.credential).toMatchObject({
      userId: first.credential.userId,
      activeOrganizationId: first.credential.activeOrganizationId,
    });
    expect(repeated.credential.id).not.toBe(first.credential.id);
  });

  it("allows exempt admins to authenticate before verification", async () => {
    const signUp = await fragment.callRoute("POST", "/sign-up", {
      body: { email: "admin@test.com", password: "password123" },
    });

    assert(signUp.type === "json");
    assert(signUp.data.status === "authenticated");
    expect(signUp.data).toMatchObject({
      role: "admin",
      auth: { token: expect.any(String) },
    });
  });

  it("re-evaluates the policy when validating an existing credential", async () => {
    const passwordHash = await hashPassword("password123");
    const [admin] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated(
            "downgraded-admin@test.com",
            passwordHash,
            "admin",
          ),
        ])
        .execute();
    });
    const [issued] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.issueCredential(admin.id)])
        .execute();
    });
    assert(issued.ok);

    await test.inContext(function () {
      return this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(authSchema).update("user", admin.id, (builder) =>
            builder.set({ role: "user" }),
          );
        })
        .execute();
    });

    const [organizations, invitations, organizationIds] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.getCredentialOrganizations(issued.credential.id),
          fragment.services.getCredentialInvitations(issued.credential.id),
          fragment.services.getCredentialOrganizationIds(issued.credential.id),
        ])
        .execute();
    });
    expect(organizations).toEqual({ organizations: [], activeOrganizationId: null });
    expect(invitations).toEqual([]);
    expect(organizationIds).toEqual([]);

    const headers = authHeaders(issued.credential.id);
    const me = await fragment.callRoute("GET", "/me", { headers });
    assert(me.type === "error");
    assert(me.error.code === "credential_invalid");

    const createOrganization = await fragment.callRoute("POST", "/organizations", {
      headers,
      body: { name: "Blocked Organization", slug: "blocked-organization" },
    });
    assert(createOrganization.type === "error");
    assert(createOrganization.error.code === "credential_invalid");

    const changePassword = await fragment.callRoute("POST", "/change-password", {
      headers,
      body: { newPassword: "new-password123" },
    });
    assert(changePassword.type === "error");
    assert(changePassword.error.code === "credential_invalid");
  });

  it("rejects direct credential issuance for an unverified non-exempt user", async () => {
    const passwordHash = await hashPassword("password123");
    const [user] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated("service-user@test.com", passwordHash),
        ])
        .execute();
    });

    const [issued] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [fragment.services.issueCredential(user.id)])
        .execute();
    });

    expect(issued).toEqual({ ok: false, code: "email_verification_required" });
  });
});
