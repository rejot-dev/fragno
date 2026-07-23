import { afterAll, assert, describe, expect, it } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { getInternalFragment } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { authFragmentDefinition } from "./index";
import { authSchema } from "./schema";
import { emailVerificationRoutesFactory } from "./user/email-verification-routes";
import { userActionsRoutesFactory } from "./user/user-actions";

const emailVerificationHookName = "onUserEmailVerificationRequested";
let databaseNow = new Date("2026-07-22T12:00:00.000Z");
const databaseClock = { now: () => new Date(databaseNow) };
const advanceDatabaseTime = (milliseconds: number) => {
  databaseNow = new Date(databaseNow.getTime() + milliseconds);
};

describe("auth email verification requests", async () => {
  const deliveredRequests: Array<{ email: string; reason: string }> = [];
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "in-memory", options: { clock: databaseClock } })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          organizations: false,
          emailVerification: {
            requestCooldownSeconds: 60,
            isExempt: ({ user }) => user.role === "admin",
          },
          hooks: {
            onUserEmailVerificationRequested(payload) {
              deliveredRequests.push({ email: payload.user.email, reason: payload.reason });
            },
          },
          beforeCreateUser: ({ email }) =>
            email === "admin@example.com" ? { role: "admin" } : undefined,
        })
        .withRoutes([userActionsRoutesFactory, emailVerificationRoutesFactory]),
    )
    .build();

  afterAll(async () => {
    await test.cleanup();
  });

  const getVerificationRequestHooks = async () => {
    const internalFragment = getInternalFragment(test.adapter);
    return await internalFragment.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(
          () => [internalFragment.services.hookService.getHooksByNamespace("auth")] as const,
        )
        .transform(({ serviceResult: [hooks] }) =>
          hooks.filter((hook) => hook.hookName === emailVerificationHookName),
        )
        .execute();
    });
  };

  const updateUserByEmail = async (
    email: string,
    values: { emailVerificationRequestedAt?: Date | null; bannedAt?: Date | null },
  ) => {
    await test.inContext(function () {
      return this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(authSchema).findFirst("user", (b) =>
            b.whereIndex("idx_user_email", (eb) => eb("email", "=", email)),
          ),
        )
        .mutate(({ forSchema, retrieveResult: [user] }) => {
          assert(user);
          forSchema(authSchema).update("user", user.id, (b) => b.set(values).check());
        })
        .execute();
    });
  };

  it("requests verification on signup and suppresses requests during cooldown", async () => {
    const signUp = await fragments.auth.callRoute("POST", "/sign-up", {
      body: { email: "cooldown@example.com", password: "password123" },
    });
    assert(signUp.type === "json");
    assert(signUp.data.status === "email_verification_required");

    const resend = await fragments.auth.callRoute("POST", "/email-verification/resend", {
      body: { email: "COOLDOWN@EXAMPLE.COM" },
    });
    assert(resend.type === "json");
    assert(resend.status === 202);
    expect(resend.data).toEqual({ accepted: true });

    const [createdUser] = await test.inContext(function () {
      return this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(authSchema).findFirst("user", (builder) =>
            builder.whereIndex("idx_user_email", (expression) =>
              expression("email", "=", "cooldown@example.com"),
            ),
          ),
        )
        .execute();
    });
    expect(createdUser?.emailVerificationRequestedAt).toEqual(databaseNow);

    const hooks = await getVerificationRequestHooks();
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.payload).toMatchObject({
      user: { email: "cooldown@example.com" },
      reason: "sign_up",
    });
  });

  it("creates one request under concurrent resend after the database cooldown elapses", async () => {
    advanceDatabaseTime(61_000);

    const responses = await Promise.all([
      fragments.auth.callRoute("POST", "/email-verification/resend", {
        body: { email: "cooldown@example.com" },
      }),
      fragments.auth.callRoute("POST", "/email-verification/resend", {
        body: { email: "cooldown@example.com" },
      }),
    ]);
    for (const response of responses) {
      assert(response.type === "json");
      assert(response.status === 202);
      expect(response.data).toEqual({ accepted: true });
    }

    const hooks = await getVerificationRequestHooks();
    expect(hooks).toHaveLength(2);
    expect(hooks[1]?.payload).toMatchObject({ reason: "resend" });
  });

  it("schedules a request after valid credentials are blocked", async () => {
    advanceDatabaseTime(61_000);

    const signIn = await fragments.auth.callRoute("POST", "/sign-in", {
      body: { email: "cooldown@example.com", password: "password123" },
    });
    assert(signIn.type === "error");
    expect(signIn).toMatchObject({
      status: 403,
      error: { code: "email_verification_required" },
    });

    const hooks = await getVerificationRequestHooks();
    expect(hooks.at(-1)?.payload).toMatchObject({ reason: "sign_in" });
  });

  it("returns the same accepted response without requesting for ineligible accounts", async () => {
    const adminSignUp = await fragments.auth.callRoute("POST", "/sign-up", {
      body: { email: "admin@example.com", password: "password123" },
    });
    assert(adminSignUp.type === "json");
    assert(adminSignUp.data.status === "authenticated");

    const verifiedAt = new Date(databaseNow);
    const [verifiedUser] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragments.auth.services.createUserUnvalidated(
            "verified@example.com",
            "not-used-in-this-test",
          ),
        ])
        .execute();
    });
    await fragments.auth.fragment.callServices(() =>
      fragments.auth.services.verifyUserEmail({
        userId: verifiedUser.id,
        expectedEmail: verifiedUser.email,
        verifiedAt,
      }),
    );

    const [bannedUser] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragments.auth.services.createUserUnvalidated("banned@example.com", "not-used"),
        ])
        .execute();
    });
    assert(bannedUser.id);
    await updateUserByEmail("banned@example.com", { bannedAt: verifiedAt });

    const before = (await getVerificationRequestHooks()).length;
    for (const email of [
      "missing@example.com",
      "admin@example.com",
      "verified@example.com",
      "banned@example.com",
    ]) {
      const response = await fragments.auth.callRoute("POST", "/email-verification/resend", {
        body: { email },
      });
      assert(response.type === "json");
      assert(response.status === 202);
      expect(response.data).toEqual({ accepted: true });
    }
    expect(await getVerificationRequestHooks()).toHaveLength(before);
  });
});

describe("auth email verification configuration", () => {
  it("requires a delivery hook when verification is enabled", async () => {
    await expect(
      buildDatabaseFragmentsTest()
        .withTestAdapter({ type: "kysely-sqlite" })
        .withFragment(
          "auth",
          instantiate(authFragmentDefinition).withConfig({ emailVerification: {} }).withRoutes([]),
        )
        .build(),
    ).rejects.toThrow("emailVerification requires hooks.onUserEmailVerificationRequested");
  });

  it("rejects invalid cooldowns during setup", async () => {
    await expect(
      buildDatabaseFragmentsTest()
        .withTestAdapter({ type: "kysely-sqlite" })
        .withFragment(
          "auth",
          instantiate(authFragmentDefinition)
            .withConfig({
              emailVerification: { requestCooldownSeconds: -1 },
              hooks: { onUserEmailVerificationRequested() {} },
            })
            .withRoutes([]),
        )
        .build(),
    ).rejects.toThrow("requestCooldownSeconds must be a non-negative integer");
  });
});
