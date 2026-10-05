import { assert, describe, expect, test, vi } from "vitest";

import { z } from "zod";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadOrganizationMembers,
  loadOrganizationInvitations,
  loadUserInvitations,
  loadSystemUsers,
} from "@/fragno/auth/auth-directory.server";
import { requireBackofficeMe } from "@/fragno/auth/auth-server";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { loader as loadInvitationPreview } from "@/routes/backoffice/invitation-accept";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { BackofficeKernel } from "./kernel";

const origin = "https://backoffice.example";

function routerContext(ctx: BackofficeScenarioContext, request: Request) {
  return createBackofficeRouterContextProvider(request, {
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
}

async function exchangeBrowserSession(ctx: BackofficeScenarioContext) {
  const cookie = ctx.vars.session;
  assert(typeof cookie === "string");
  const response = await ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${origin}/api/auth/backoffice-token`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ selection: "preferred", organizationId: null }),
    }),
  );
  assert(response.ok, await response.clone().text());
  const accessCookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const request = new Request(`${origin}/api/backoffice/me`, { headers: { cookie: accessCookie } });
  const me = await requireBackofficeMe(request, routerContext(ctx, request));
  return { accessCookie, me };
}

async function runHttpAuthorityScenario(check: (ctx: BackofficeScenarioContext) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-http-authority-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "fragment HTTP authority",
        options: { sqliteDataDirectory: directory },
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_INVITATIONS_ENABLED: "false" },
        steps: ({ when, then }) => [
          when.auth.signUp({
            email: "http-authority@example.test",
            captureSessionCookieAs: "session",
          }),
          then.assert("real HTTP routes enforce operation authority", async (ctx) => {
            try {
              await check(ctx);
            } catch (error) {
              if (error instanceof Response) {
                throw new Error(`Unexpected HTTP ${error.status}: ${await error.text()}`);
              }
              throw error;
            }
          }),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("fragment HTTP authority scenarios", () => {
  test("auth directory loaders use real sessions and keep invitation preview read-only", async () => {
    await runHttpAuthorityScenario(async (ctx) => {
      const { accessCookie, me } = await exchangeBrowserSession(ctx);
      const organization = me.organizations[0].organization;
      const session = ctx.vars.session;
      assert(typeof session === "string");
      const request = new Request(
        `${origin}/backoffice/organizations/${organization.slug}/members`,
        { headers: { cookie: `${session}; ${accessCookie}` } },
      );
      const input = { request, context: routerContext(ctx, request) };
      const auth = ctx.runtime.objects.auth.singleton();
      await auth.commands.applyScenarioFixture({
        users: [{ id: me.user.id, email: me.user.email, role: "user", status: "active" }],
      });
      expect((await loadOrganizationMembers(input, organization.slug)).members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: me.user.id,
            user: expect.objectContaining({ email: me.user.email }),
          }),
        ]),
      );
      expect((await loadOrganizationInvitations(input, organization.slug)).invitations).toEqual([]);
      expect((await loadUserInvitations(input)).invitations).toEqual([]);
      await expect(loadSystemUsers(input)).rejects.toMatchObject({ status: 403 });
      const invitationResponse = await auth.http.fetch(
        new Request(`${origin}/api/auth/organization/invite-member`, {
          method: "POST",
          headers: { cookie: session, origin, "content-type": "application/json" },
          body: JSON.stringify({
            organizationId: organization.id,
            email: "invited@example.test",
            role: "member",
          }),
        }),
      );
      assert(invitationResponse.ok, await invitationResponse.clone().text());
      const invitation = z.object({ id: z.string() }).parse(await invitationResponse.json());
      const signup = await auth.http.fetch(
        new Request(`${origin}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            name: "Invited",
            email: "invited@example.test",
            password: "secure-password-123",
          }),
        }),
      );
      assert(signup.ok, await signup.clone().text());
      const invitedUser = z
        .object({ user: z.object({ id: z.string() }) })
        .parse(await signup.json()).user;
      await auth.commands.applyScenarioFixture({
        users: [
          { id: invitedUser.id, email: "invited@example.test", role: "user", status: "active" },
        ],
      });
      const invitedCookie = signup.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      const previewRequest = new Request(`${origin}/backoffice/invitations/${invitation.id}`, {
        headers: { cookie: invitedCookie },
      });
      const preview = await loadInvitationPreview({
        request: previewRequest,
        context: routerContext(ctx, previewRequest),
        params: { invitationId: invitation.id },
      } as never);
      expect(preview.organization).toEqual({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
      });
      const listed = await loadUserInvitations({
        request: previewRequest,
        context: routerContext(ctx, previewRequest),
      });
      expect(listed.invitations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            invitation: expect.objectContaining({ id: invitation.id, status: "pending" }),
          }),
        ]),
      );
      assert((await loadOrganizationMembers(input, organization.slug)).total === 1);
    });
  });
});
