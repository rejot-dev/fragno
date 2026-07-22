import { afterAll, assert, describe, expect, it } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { getInternalFragment, type DurableHookRecord } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { authFragmentDefinition } from "..";
import type {
  DurableUserCreatedHookPayload,
  DurableUserEmailVerifiedHookPayload,
  UserCreatedHookPayload,
  UserEmailVerifiedHookPayload,
} from "../hooks";
import { authSchema } from "../schema";
import { hashPassword } from "./password";

const readDurableUserCreatedHookPayload = (
  hook: DurableHookRecord,
): DurableUserCreatedHookPayload => hook.payload as DurableUserCreatedHookPayload;

const readDurableUserEmailVerifiedHookPayload = (
  hook: DurableHookRecord,
): DurableUserEmailVerifiedHookPayload => hook.payload as DurableUserEmailVerifiedHookPayload;

describe("auth user email verification", async () => {
  const deliveredUserCreatedPayloads: UserCreatedHookPayload[] = [];
  const deliveredUserEmailVerifiedPayloads: UserEmailVerifiedHookPayload[] = [];
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition)
        .withConfig({
          hooks: {
            onUserCreated(payload) {
              deliveredUserCreatedPayloads.push(payload);
            },
            onUserEmailVerified(payload) {
              deliveredUserEmailVerifiedPayloads.push(payload);
            },
          },
        })
        .withRoutes([]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  const getUserById = (userId: string) =>
    test.inContext(function () {
      return this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(authSchema).findFirst("user", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", userId)),
          ),
        )
        .transformRetrieve(([user]) => user)
        .execute();
    });

  const getAuthHooks = () => {
    const internalFragment = getInternalFragment(test.adapter);
    return internalFragment.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(
          () => [internalFragment.services.hookService.getHooksByNamespace("auth")] as const,
        )
        .transform(({ serviceResult: [hooks] }) => hooks)
        .execute();
    });
  };

  it("creates email/password users with an unverified email", async () => {
    const passwordHash = await hashPassword("password-123");
    const [result] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.signUp("unverified-user@test.com", passwordHash),
        ])
        .execute();
    });

    assert(result.ok);
    assert(result.status === "authenticated");
    const user = await getUserById(result.credential.user.id);
    assert(user);
    expect(user.emailVerifiedAt).toBeNull();

    const createdPayload = (await getAuthHooks())
      .filter((hook) => hook.hookName === "onUserCreated")
      .map(readDurableUserCreatedHookPayload)
      .find((payload) => payload.user.id === user.id.valueOf());
    assert(createdPayload);
    expect(createdPayload.emailVerifiedAt).toBeNull();

    await drainDurableHooks(fragment.fragment);
    const deliveredPayload = deliveredUserCreatedPayloads.find(
      (payload) => payload.user.id === user.id.valueOf(),
    );
    assert(deliveredPayload);
    expect(deliveredPayload.emailVerifiedAt).toBeNull();
  });

  it("verifies the current email once and emits one transition hook", async () => {
    const passwordHash = await hashPassword("password-456");
    const [user] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.createUserUnvalidated("verify-user@test.com", passwordHash),
        ])
        .execute();
    });

    const verifiedAt = new Date("2026-07-17T12:00:00.000Z");
    const [mismatch] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.verifyUserEmail({
            userId: user.id,
            expectedEmail: "other-email@test.com",
            verifiedAt,
          }),
        ])
        .execute();
    });
    expect(mismatch).toEqual({ ok: false, code: "email_changed" });

    const [verified] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.verifyUserEmail({
            userId: user.id,
            expectedEmail: "verify-user@test.com",
            verifiedAt,
          }),
        ])
        .execute();
    });
    assert(verified.ok);
    assert.equal(verified.status, "verified");

    const [repeated] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.verifyUserEmail({
            userId: user.id,
            expectedEmail: "verify-user@test.com",
            verifiedAt: new Date("2026-07-17T13:00:00.000Z"),
          }),
        ])
        .execute();
    });
    assert(repeated.ok);
    expect(repeated).toEqual({
      ok: true,
      status: "already_verified",
      emailVerifiedAt: verified.emailVerifiedAt,
    });

    const storedUser = await getUserById(user.id);
    assert(storedUser);
    expect(storedUser.emailVerifiedAt).toEqual(verified.emailVerifiedAt);

    const verifiedPayloads = (await getAuthHooks())
      .filter((hook) => hook.hookName === "onUserEmailVerified")
      .map(readDurableUserEmailVerifiedHookPayload)
      .filter((payload) => payload.user.id === user.id);
    assert.equal(verifiedPayloads.length, 1);
    expect(verifiedPayloads[0]!.emailVerifiedAt).toBe(verified.emailVerifiedAt.toISOString());

    await drainDurableHooks(fragment.fragment);
    const deliveredPayload = deliveredUserEmailVerifiedPayloads.find(
      (payload) => payload.user.id === user.id,
    );
    assert(deliveredPayload);
    expect(deliveredPayload.emailVerifiedAt).toBeInstanceOf(Date);
    expect(deliveredPayload.emailVerifiedAt).toEqual(verified.emailVerifiedAt);
  });

  it("returns a typed result when the user does not exist", async () => {
    const [result] = await test.inContext(function () {
      return this.handlerTx()
        .withServiceCalls(() => [
          fragment.services.verifyUserEmail({
            userId: "missing-user",
            expectedEmail: "missing@test.com",
            verifiedAt: new Date("2026-07-17T12:00:00.000Z"),
          }),
        ])
        .execute();
    });

    expect(result).toEqual({ ok: false, code: "user_not_found" });
  });
});
