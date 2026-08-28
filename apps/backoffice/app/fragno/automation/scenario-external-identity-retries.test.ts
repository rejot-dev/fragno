import { assert, describe, expect, test, vi } from "vitest";

import type { HookContext } from "@fragno-dev/db";
import type { OtpConfirmedHookPayload } from "@fragno-dev/otp-fragment";

import { eq, queryOnce } from "@tanstack/react-db";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { BackofficeScenarioStep } from "@/fragno/automation/scenario";
import { IDENTITY_LINK_TYPE } from "@/fragno/otp";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  class MockRpcTarget {}
  class MockWorkerEntrypoint {}

  return {
    DurableObject: MockDurableObject,
    RpcTarget: MockRpcTarget,
    WorkerEntrypoint: MockWorkerEntrypoint,
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { handleIdentityClaimConfirmed } from "../../../workers/otp.do";
import { defineBackofficeScenario, runBackofficeScenario } from "./scenario";

const orgId = "org-1";
const userId = "user-1";
const scope = { kind: "org" as const, orgId };
const identity = {
  scope: "external" as const,
  source: "telegram",
  type: "chat",
  id: "1001",
};

const whenIdentityIsBound = (claimId: string): BackofficeScenarioStep => ({
  kind: "when",
  type: "identity.bind",
  label: `bind Telegram chat with ${claimId}`,
  drain: true,
  run: async (ctx) => {
    ctx.rememberOrg(orgId);
    await ctx.runtime.objects.automations.for(scope).commands.bindExternalIdentity(
      {
        identity,
        userId,
        verifiedByClaimId: claimId,
      },
      { execution: createBackofficeSystemExecution(scope) },
    );
  },
});

const whenIdentityIsRevoked = (label: string, expectedVersion = 0): BackofficeScenarioStep => ({
  kind: "when",
  type: "identity.revoke",
  label,
  drain: true,
  run: async (ctx) => {
    ctx.rememberOrg(orgId);
    await ctx.runtime.objects.automations.for(scope).commands.revokeExternalIdentity(
      {
        identity,
        expectedUserId: userId,
        expectedVersion,
      },
      { execution: createBackofficeSystemExecution(scope) },
    );
  },
});

const thenStaleRevocationIsRejected = (expectedVersion: number): BackofficeScenarioStep => ({
  kind: "then",
  type: "identity.revoke.conflict",
  label: "the stale revocation is rejected",
  run: async (ctx) => {
    await expect(
      ctx.runtime.objects.automations.for(scope).commands.revokeExternalIdentity(
        {
          identity,
          expectedUserId: userId,
          expectedVersion,
        },
        { execution: createBackofficeSystemExecution(scope) },
      ),
    ).rejects.toMatchObject({ reason: "binding-version-changed" });
  },
});

const whenConfirmedClaimHookRetries = (
  claimId: string,
  eventId: string,
): BackofficeScenarioStep => ({
  kind: "when",
  type: "otp.identityClaimConfirmed.retry",
  label: `retry confirmed identity claim ${claimId}`,
  drain: true,
  run: async (ctx) => {
    ctx.rememberOrg(orgId);
    const payload = {
      id: claimId,
      externalId: identity.id,
      type: IDENTITY_LINK_TYPE,
      code: "ABC12345",
      confirmedAt: new Date("2026-07-31T10:00:00.000Z"),
      payload: {
        orgId,
        actor: identity,
      },
      confirmationPayload: { subjectUserId: userId },
    } satisfies OtpConfirmedHookPayload;
    const hookContext = {
      hookId: { toString: () => eventId },
      capturePropagationContext: () => ({ traceId: `${eventId}-trace` }),
    } as unknown as HookContext;

    await handleIdentityClaimConfirmed(
      ctx.runtime as unknown as BackofficeRuntimeServices,
      payload,
      hookContext,
    );
  },
});

describe("external identity retry regressions", () => {
  test("an accepted same-user claim cannot reactivate a later-revoked binding", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "accepted identity claims remain consumed after revocation",
        setup: ({ given }) => [
          given.auth.user({
            id: "owner-1",
            email: "owner@example.com",
          }),
          given.auth.user({
            id: userId,
            email: "linked-user@example.com",
          }),
          given.auth.organization({
            id: orgId,
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({
            orgId,
            userId,
            roles: ["member"],
          }),
        ],
        steps: ({ then }) => [
          then.auth.authority({
            userId,
            orgId,
            expected: {
              active: true,
              role: "user",
              organizationMember: true,
            },
          }),
          then.auth.member({
            orgId,
            userId,
            roles: ["member"],
          }),
          then.auth.permissions({
            userId,
            scope,
            include: [BACKOFFICE_PERMISSION.store.modify, BACKOFFICE_PERMISSION.telegram.send],
            exclude: [BACKOFFICE_PERMISSION.identity.bind],
          }),
          whenIdentityIsBound("claim-1"),
          whenIdentityIsBound("claim-2"),
          whenIdentityIsRevoked("revoke the binding after claim-2 was accepted"),
          whenIdentityIsBound("claim-2"),
          then.identity.unresolved({
            scope,
            identity,
          }),
        ],
      }),
    );
  });

  test("a retried revocation cannot revoke a newer activation for the same user", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "stale revocation cannot cross identity binding generations",
        setup: ({ given }) => [
          given.auth.user({
            id: "owner-1",
            email: "owner@example.com",
          }),
          given.auth.user({
            id: userId,
            email: "linked-user@example.com",
          }),
          given.auth.organization({
            id: orgId,
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({
            orgId,
            userId,
            roles: ["member"],
          }),
        ],
        steps: ({ then }) => [
          then.auth.authority({
            userId,
            orgId,
            expected: {
              active: true,
              role: "user",
              organizationMember: true,
            },
          }),
          then.auth.member({
            orgId,
            userId,
            roles: ["member"],
          }),
          then.auth.permissions({
            userId,
            scope,
            include: [BACKOFFICE_PERMISSION.store.modify, BACKOFFICE_PERMISSION.telegram.send],
            exclude: [BACKOFFICE_PERMISSION.identity.bind],
          }),
          whenIdentityIsBound("claim-1"),
          whenIdentityIsRevoked("revoke the claim-1 binding, but lose the response"),
          whenIdentityIsBound("claim-2"),
          thenStaleRevocationIsRejected(0),
          then.identity.resolves({
            scope,
            identity,
            userId,
          }),
        ],
      }),
    );
  });

  test("a retried confirmed claim does not announce a revoked binding", async () => {
    const completionEventId = "revoked-claim-retry";

    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "revoked identity claim retries do not emit completion events",
        setup: ({ given }) => [
          given.auth.user({
            id: "owner-1",
            email: "owner@example.com",
          }),
          given.auth.user({
            id: userId,
            email: "linked-user@example.com",
          }),
          given.auth.organization({
            id: orgId,
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({
            orgId,
            userId,
            roles: ["member"],
          }),
        ],
        steps: ({ then }) => [
          then.auth.authority({
            userId,
            orgId,
            expected: {
              active: true,
              role: "user",
              organizationMember: true,
            },
          }),
          then.auth.member({
            orgId,
            userId,
            roles: ["member"],
          }),
          then.auth.permissions({
            userId,
            scope,
            include: [BACKOFFICE_PERMISSION.store.modify, BACKOFFICE_PERMISSION.telegram.send],
            exclude: [BACKOFFICE_PERMISSION.identity.bind],
          }),
          whenIdentityIsBound("claim-1"),
          whenIdentityIsRevoked("revoke the binding before the confirmed hook retries"),
          whenConfirmedClaimHookRetries("claim-1", completionEventId),
          then.assert("the revoked claim completion event was not emitted", async (ctx) => {
            const database = ctx.tanstack.automations.forOrg(orgId);
            await database.drain();
            const completionEvent = await queryOnce((query) =>
              query
                .from({ event: database.collections.events })
                .where(({ event }) => eq(event.id, completionEventId))
                .findOne(),
            );

            assert.equal(completionEvent, undefined);
          }),
          then.identity.unresolved({
            scope,
            identity,
          }),
        ],
      }),
    );
  });
});
