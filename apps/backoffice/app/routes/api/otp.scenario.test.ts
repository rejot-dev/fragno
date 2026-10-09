import { assert, describe, expect, test, vi } from "vitest";

import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AutomationExternalEntityRef } from "@fragno-dev/backoffice-api/v0/automation";
import { automationEventListResultSchema } from "@fragno-dev/backoffice-api/v0/events";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import Database from "better-sqlite3";

import {
  createBackofficeRequestExecution,
  createBackofficeSystemExecution,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { requireBackofficeMe } from "@/fragno/auth/auth-server";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
  type BackofficeScenarioDefinitionInput,
} from "@/fragno/automation/scenario";
import {
  EMAIL_VERIFICATION_TYPE,
  IDENTITY_LINK_TYPE,
  SIGN_UP_INVITATION_TYPE,
  buildIdentityClaimCompletionUrl,
} from "@/fragno/otp";
import {
  loader as previewIdentityClaim,
  action as completeIdentityClaim,
} from "@/routes/backoffice/automations/claims-complete";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { action } from "./otp";

type OtpEntryPoint = "public" | "object";
type OtpOperation = "issue" | "confirm" | "invalidate";

const identity = {
  scope: "external",
  source: "telegram",
  type: "chat",
  id: "attacker-chat",
} as const satisfies AutomationExternalEntityRef;

function externalClaimExecution(orgId: string) {
  return {
    kind: "deferred" as const,
    scopeRestriction: null,
    scope: { kind: "org" as const, orgId },
    actors: {
      initiator: { ...identity, role: "initiator" as const },
      principal: null,
      delegation: [],
    },
  };
}

async function runOtpScenario(
  buildScenario: (directory: string) => BackofficeScenarioDefinitionInput,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-otp-security-"));
  try {
    const scenario = buildScenario(directory);
    await runBackofficeScenario(
      defineBackofficeScenario({
        ...scenario,
        options: { ...scenario.options, sqliteDataDirectory: directory },
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createOtpRouterContext(ctx: BackofficeScenarioContext, request: Request) {
  return createBackofficeRouterContextProvider(request, {
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
}

async function authenticateOtpMember(ctx: BackofficeScenarioContext) {
  const sessionCookie = ctx.vars.session;
  assert(typeof sessionCookie === "string");
  const exchange = await ctx.runtime.objects.auth.singleton().http.fetch(
    new Request("https://backoffice.example/api/auth/backoffice-token", {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: "https://backoffice.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ selection: "preferred", organizationId: null }),
    }),
  );
  assert(exchange.ok, await exchange.clone().text());
  const accessCookie = exchange.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
  assert(accessCookie);
  const request = new Request("https://backoffice.example/api/backoffice/me", {
    headers: { cookie: accessCookie },
  });
  const me = await requireBackofficeMe(request, createOtpRouterContext(ctx, request));
  const organization = me.organizations[0].organization;
  ctx.rememberOrg(organization.id);
  return { accessCookie, organization, userId: me.user.id };
}

async function callOtpEndpoint(
  ctx: BackofficeScenarioContext,
  input: {
    entryPoint: OtpEntryPoint;
    organization: { id: string; slug: string };
    accessCookie: string;
    operation: OtpOperation;
    body: Record<string, unknown>;
  },
) {
  const pathname =
    input.entryPoint === "public"
      ? `/api/otp/${input.organization.slug}/otp/${input.operation}`
      : `/api/otp/otp/${input.operation}`;
  const url = new URL(pathname, "https://backoffice.example");
  const request = new Request(url, {
    method: "POST",
    headers: {
      cookie: input.accessCookie,
      origin: url.origin,
      "content-type": "application/json",
    },
    body: JSON.stringify(input.body),
  });
  if (input.entryPoint === "object") {
    return await ctx.runtime.objects.otp.forOrg(input.organization.id).http.fetch(request);
  }
  return await action({
    request,
    url,
    pattern: "/api/otp/:orgSlug/*",
    context: createOtpRouterContext(ctx, request),
    params: { orgSlug: input.organization.slug, "*": `otp/${input.operation}` },
  });
}

async function assertNoIdentityClaimEffects(
  ctx: BackofficeScenarioContext,
  orgIds: string[],
  actor: AutomationExternalEntityRef,
) {
  for (const orgId of orgIds) {
    const scope = { kind: "org" as const, orgId };
    const automations = ctx.runtime.objects.automations.for(scope);
    expect(
      await automations.commands.resolveExternalIdentity(
        { identity: actor },
        { execution: createBackofficeSystemExecution(scope) },
      ),
    ).toBeNull();
    const response = await automations.http.fetch(
      new Request("https://backoffice.example/api/automations/events?limit=500"),
    );
    assert(response.ok);
    const result = automationEventListResultSchema.parse(await response.json());
    expect(result.events.filter((event) => event.source === "otp")).toEqual([]);
  }
}

describe("OTP public boundary security scenarios", () => {
  test("an authenticated member cannot forge identity claims across organizations", async () => {
    await runOtpScenario(() => ({
      name: "public OTP operations cannot acquire trusted identity authority",
      setup: ({ given }) => [
        given.auth.user({ id: "victim", email: "victim@example.test" }),
        given.auth.organization({ id: "victim-org", ownerUserId: "victim" }),
      ],
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "attacker@example.test", captureSessionCookieAs: "session" }),
        then.assert("all reserved operations reject attacker-selected identities", async (ctx) => {
          const member = await authenticateOtpMember(ctx);
          for (const entryPoint of ["public", "object"] as const) {
            for (const type of [
              IDENTITY_LINK_TYPE,
              EMAIL_VERIFICATION_TYPE,
              SIGN_UP_INVITATION_TYPE,
            ]) {
              for (const operation of ["issue", "confirm", "invalidate"] as const) {
                const response = await callOtpEndpoint(ctx, {
                  ...member,
                  entryPoint,
                  operation,
                  body: {
                    externalId: identity.id,
                    type,
                    code: "ATTACKER-CODE",
                    payload: { orgId: "victim-org", actor: identity },
                    confirmationPayload: { subjectUserId: "victim" },
                  },
                });
                assert.equal(response.status, 403);
                expect(await response.json()).toMatchObject({ code: "OTP_TYPE_RESERVED" });
              }
            }
          }
          await ctx.runtime.drain();
          const queue = await ctx.runtime.objects.otp
            .forOrg(member.organization.id)
            .commands.getDurableHookQueue();
          expect(queue.items).toEqual([]);
          await assertNoIdentityClaimEffects(ctx, [member.organization.id, "victim-org"], identity);
        }),
      ],
    }));
  });

  test("public calls cannot supersede, consume, invalidate, or recover a trusted identity claim", async () => {
    await runOtpScenario(() => ({
      name: "trusted identity claims retain their authenticated confirming user",
      setup: ({ given }) => [
        given.auth.user({ id: "victim", email: "victim@example.test" }),
        given.auth.organization({ id: "victim-org", ownerUserId: "victim" }),
      ],
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "member@example.test", captureSessionCookieAs: "session" }),
        then.assert("only the trusted completion flow consumes the claim", async (ctx) => {
          const member = await authenticateOtpMember(ctx);
          const otp = ctx.runtime.objects.otp.forOrg(member.organization.id);
          const claim = await otp.commands.issueIdentityClaim(
            { expiresInMinutes: null },
            externalClaimExecution(member.organization.id),
          );
          for (const entryPoint of ["public", "object"] as const) {
            for (const operation of ["issue", "confirm", "invalidate"] as const) {
              const response = await callOtpEndpoint(ctx, {
                ...member,
                entryPoint,
                operation,
                body: {
                  externalId: claim.externalId,
                  type: IDENTITY_LINK_TYPE,
                  requestId: claim.otpId,
                  code: claim.code,
                  payload: { orgId: "victim-org", actor: identity },
                  confirmationPayload: { subjectUserId: "victim" },
                },
              });
              assert.equal(response.status, 403);
              expect(await response.json()).toMatchObject({ code: "OTP_TYPE_RESERVED" });
            }
          }
          await ctx.runtime.drain();
          await assertNoIdentityClaimEffects(ctx, [member.organization.id, "victim-org"], identity);
          const issuedQueue = await otp.commands.getDurableHookQueue();
          const issuedHooks = issuedQueue.items.filter((hook) => hook.hookName === "onOtpIssued");
          expect(issuedHooks).toHaveLength(1);
          expect(issuedHooks[0]).toMatchObject({
            hookName: "onOtpIssued",
            payload: { payload: { orgId: member.organization.id, actor: identity } },
          });

          const url = new URL(
            buildIdentityClaimCompletionUrl(
              "https://backoffice.example",
              member.organization.slug,
              claim.externalId,
              claim.code,
            ),
          );
          url.searchParams.set("subjectUserId", "victim");
          url.searchParams.set("orgId", "victim-org");
          const request = new Request(url, { headers: { cookie: member.accessCookie } });
          const preview = await previewIdentityClaim({
            request,
            url,
            pattern: "/backoffice/automations/:orgSlug/claims/complete",
            context: createOtpRouterContext(ctx, request),
            params: { orgSlug: member.organization.slug },
          });
          expect(preview.claim).toEqual({ actor: identity });
          await ctx.runtime.drain();
          await assertNoIdentityClaimEffects(ctx, [member.organization.id, "victim-org"], identity);
          const form = new URLSearchParams({
            externalId: claim.externalId,
            code: claim.code,
            confirm: "link",
            subjectUserId: "victim",
          });
          const crossSiteRequest = new Request(url, {
            method: "POST",
            headers: { cookie: member.accessCookie, origin: "https://attacker.example" },
            body: form,
          });
          await expect(
            completeIdentityClaim({
              request: crossSiteRequest,
              url,
              pattern: "/backoffice/automations/:orgSlug/claims/complete",
              context: createOtpRouterContext(ctx, crossSiteRequest),
              params: { orgSlug: member.organization.slug },
            }),
          ).rejects.toMatchObject({ status: 403 });
          const post = new Request(url, {
            method: "POST",
            headers: { cookie: member.accessCookie, origin: url.origin },
            body: form,
          });
          const result = await completeIdentityClaim({
            request: post,
            url,
            pattern: "/backoffice/automations/:orgSlug/claims/complete",
            context: createOtpRouterContext(ctx, post),
            params: { orgSlug: member.organization.slug },
          });
          assert(result.ok);
          await ctx.runtime.drain();
          const scope = { kind: "org" as const, orgId: member.organization.id };
          const automations = ctx.runtime.objects.automations.for(scope);
          expect(
            await automations.commands.resolveExternalIdentity(
              { identity },
              { execution: createBackofficeSystemExecution(scope) },
            ),
          ).toEqual({ userId: member.userId });
          const response = await automations.http.fetch(
            new Request("https://backoffice.example/api/automations/events?limit=500"),
          );
          assert(response.ok);
          const events = automationEventListResultSchema.parse(await response.json()).events;
          expect(events.filter((event) => event.source === "otp")).toMatchObject([
            {
              scopeRestriction: null,
              scope,
              eventType: "identity.claim.completed",
              actors: { initiator: identity },
              subject: { userId: member.userId },
            },
          ]);
          await assertNoIdentityClaimEffects(ctx, ["victim-org"], identity);
        }),
      ],
    }));
  });

  test("nonreserved OTP types retain issuance, confirmation, and invalidation behavior", async () => {
    await runOtpScenario(() => ({
      name: "generic public OTP operations cannot produce identity claim effects",
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "custom-otp@example.test", captureSessionCookieAs: "session" }),
        then.assert("generic OTPs work through both HTTP entry points", async (ctx) => {
          const member = await authenticateOtpMember(ctx);
          for (const entryPoint of ["public", "object"] as const) {
            const body = {
              externalId: `${identity.id}-${entryPoint}`,
              type: "custom-challenge",
              payload: { orgId: member.organization.id, actor: identity },
              confirmationPayload: { subjectUserId: member.userId },
            };
            const issued = await callOtpEndpoint(ctx, {
              ...member,
              entryPoint,
              operation: "issue",
              body,
            });
            assert(issued.ok);
            const { code } = (await issued.json()) as { code: string };
            const confirmed = await callOtpEndpoint(ctx, {
              ...member,
              entryPoint,
              operation: "confirm",
              body: { ...body, code },
            });
            assert(confirmed.ok);
            expect(await confirmed.json()).toMatchObject({ confirmed: true });
            const reissued = await callOtpEndpoint(ctx, {
              ...member,
              entryPoint,
              operation: "issue",
              body,
            });
            assert(reissued.ok);
            const next = (await reissued.json()) as { code: string };
            const invalidated = await callOtpEndpoint(ctx, {
              ...member,
              entryPoint,
              operation: "invalidate",
              body,
            });
            assert(invalidated.ok);
            expect(await invalidated.json()).toEqual({ invalidatedCount: 1 });
            const rejected = await callOtpEndpoint(ctx, {
              ...member,
              entryPoint,
              operation: "confirm",
              body: { ...body, code: next.code },
            });
            assert.equal(rejected.status, 401);
            expect(await rejected.json()).toMatchObject({ code: "OTP_INVALID" });
          }
          await ctx.runtime.drain();
          await assertNoIdentityClaimEffects(ctx, [member.organization.id], identity);
        }),
      ],
    }));
  });

  test("singleton OTP objects cannot issue or confirm organization identity claims", async () => {
    await runOtpScenario(() => ({
      name: "identity claims require an organization-owned OTP object",
      steps: ({ then }) => [
        then.assert("singleton commands cannot acquire identity authority", async (ctx) => {
          const otp = ctx.runtime.objects.otp.singleton();
          await expect(
            otp.commands.issueIdentityClaim(
              { expiresInMinutes: null },
              externalClaimExecution("owner-org"),
            ),
          ).rejects.toThrow("Identity claims require an organization-scoped OTP object.");
          await expect(
            otp.commands.confirmIdentityClaim(
              {
                externalId: identity.id,
                code: "CODE",
              },
              createBackofficeRequestExecution({
                scope: { kind: "org", orgId: "victim-org" },
                userId: "victim",
                verifiedRequestAuthority: {
                  role: "user",
                  organizationId: "victim-org",
                  expiresAt: new Date(Date.now() + 60_000),
                  scopeRestriction: null,
                },
              }),
            ),
          ).rejects.toThrow("Identity claims require an organization-scoped OTP object.");
          expect((await otp.commands.getDurableHookQueue()).items).toEqual([]);
        }),
        then.assert(
          "organization ownership cannot be supplied to trusted issuance",
          async (ctx) => {
            const otp = ctx.runtime.objects.otp.forOrg("owner-org");
            const forgedInput = {
              expiresInMinutes: null,
              actor: identity,
              scope: { kind: "org", orgId: "victim-org" },
            };
            await expect(
              otp.commands.issueIdentityClaim(forgedInput, externalClaimExecution("owner-org")),
            ).rejects.toThrow();
            expect((await otp.commands.getDurableHookQueue()).items).toEqual([]);
          },
        ),
      ],
    }));
  });

  test("a persisted claim cannot redirect its owning object's service authority", async () => {
    await runOtpScenario((directory) => ({
      name: "legacy identity claim organization mismatch is permanently rejected",
      setup: ({ given }) => [
        given.auth.user({ id: "owner", email: "owner@example.test" }),
        given.auth.organization({ id: "owner-org", ownerUserId: "owner" }),
        given.auth.user({ id: "victim", email: "victim@example.test" }),
        given.auth.organization({ id: "victim-org", ownerUserId: "victim" }),
      ],
      steps: ({ then }) => [
        then.assert(
          "durable confirmation ignores a legacy cross-organization claim",
          async (ctx) => {
            const otp = ctx.runtime.objects.otp.forOrg("owner-org");
            const claim = await otp.commands.issueIdentityClaim(
              { expiresInMinutes: null },
              externalClaimExecution("owner-org"),
            );
            const files = (await readdir(directory)).filter(
              (file) => file.startsWith("otp-") && file.endsWith(".sqlite"),
            );
            assert.equal(files.length, 1);
            const database = new Database(path.join(directory, files[0]));
            try {
              // Recreate the poisoned record a public caller could persist before this restriction.
              const update = database
                .prepare("UPDATE otp_otp SET payload = ? WHERE id = ?")
                .run(JSON.stringify({ orgId: "victim-org", actor: identity }), claim.otpId);
              assert.equal(update.changes, 1);
            } finally {
              database.close();
            }
            expect(
              await otp.commands.confirmIdentityClaim(
                {
                  externalId: claim.externalId,
                  code: claim.code,
                },
                createBackofficeRequestExecution({
                  scope: { kind: "org", orgId: "owner-org" },
                  userId: "owner",
                  verifiedRequestAuthority: {
                    role: "user",
                    organizationId: "owner-org",
                    expiresAt: new Date(Date.now() + 60_000),
                    scopeRestriction: null,
                  },
                }),
              ),
            ).toEqual({ ok: true, externalId: claim.externalId });
            await ctx.runtime.drain();
            await assertNoIdentityClaimEffects(ctx, ["owner-org", "victim-org"], identity);
            const queue = await otp.commands.getDurableHookQueue();
            const confirmation = queue.items.find((hook) => hook.hookName === "onOtpConfirmed");
            assert(confirmation);
            assert.equal(confirmation.status, "completed");
            assert.equal(confirmation.attempts, 0);
          },
        ),
      ],
    }));
  });
});
