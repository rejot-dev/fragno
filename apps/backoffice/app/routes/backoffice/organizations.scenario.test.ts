import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { z } from "zod";

import {
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import {
  createCodemodeRouteBackedRuntimeContext,
  createRouteBackedRuntimeContext,
} from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { InMemoryAppsObject } from "../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../workers/forms.do";
import { InMemoryOtpObject } from "../../../workers/otp.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import { action, loader } from "./organizations";

const scenarioObjects = {
  APPS: (input) => new InMemoryAppsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const origin = "https://backoffice.example";

async function openOrganizationsPage(ctx: BackofficeScenarioContext, cookie: string) {
  const request = new Request(`${origin}/backoffice/organizations`, { headers: { cookie } });
  return await loader({
    request,
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
    params: {},
  } as never);
}

/** Runs a command in the signed-in user's own terminal, in their personal scope. */
async function runInUserTerminal(ctx: BackofficeScenarioContext, cookie: string, command: string) {
  const session = await ctx.runtime.objects.auth
    .singleton()
    .http.fetch(new Request(`${origin}/api/auth/get-session`, { headers: { cookie } }));
  const userId = z.object({ user: z.object({ id: z.string() }) }).parse(await session.json())
    .user.id;
  const context = createRouteBackedRuntimeContext({
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeUserExecution({ scope: { kind: "user", userId }, userId }),
    billingOrganizationId: null,
  });
  assert(context.stateBackend);
  const { bash } = await createInteractiveBashHost({
    context: { ...context, stateBackend: context.stateBackend },
  });
  return await bash.exec(command);
}

async function createOrganizationFromPage(
  ctx: BackofficeScenarioContext,
  cookie: string,
  name: string,
) {
  const request = new Request(`${origin}/backoffice/organizations`, {
    method: "POST",
    headers: { cookie, origin },
    body: new URLSearchParams({ name }),
  });
  const response = await action({
    request,
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
    url: new URL(request.url),
    params: {},
  } as never);
  assert(response instanceof Response);
  const location = new URL(response.headers.get("location") ?? "", origin);
  return { returnTo: location.searchParams.get("returnTo") };
}

async function runInSystemTerminal(ctx: BackofficeScenarioContext, command: string) {
  const { bash } = await createInteractiveBashHost({
    context: createCodemodeRouteBackedRuntimeContext({
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      execution: createBackofficeSystemExecution({ kind: "system" }),
      billingOrganizationId: null,
    }),
  });
  return await bash.exec(command);
}

test("an unverified invitee sees their invitations, on the page and in their terminal, once an administrator verifies their email", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "organizations page before and after administrator email verification",
      // As in local development: accounts sign in without ever verifying their email.
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_INVITATIONS_ENABLED: "false" },
      vars: () => ({ ownerCookie: "", inviteeCookie: "", organizationId: "", invitationId: "" }),
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "owner@example.test", captureSessionCookieAs: "ownerCookie" }),
        when.auth.createOrganization({
          cookie: ({ vars }) => vars.ownerCookie,
          name: "Acme",
          slug: "acme",
          captureOrganizationIdAs: "organizationId",
        }),
        when.auth.inviteMember({
          cookie: ({ vars }) => vars.ownerCookie,
          organizationId: ({ vars }) => vars.organizationId,
          email: "invitee@example.test",
          captureInvitationIdAs: "invitationId",
        }),
        when.auth.signUp({
          email: "invitee@example.test",
          captureSessionCookieAs: "inviteeCookie",
        }),
        then.assert(
          "invitations stay hidden until the invitee's email is verified",
          async (ctx) => {
            expect(await openOrganizationsPage(ctx, ctx.vars.inviteeCookie)).toEqual({
              status: "email-unverified",
            });
            const listed = await runInUserTerminal(
              ctx,
              ctx.vars.inviteeCookie,
              "account.invitations.list",
            );
            assert.notEqual(listed.exitCode, 0);
            assert.include(
              listed.stderr,
              "Verify your email address to see invitations sent to it.",
            );
          },
        ),
        then.assert("an administrator verifies the invitee's email", async (ctx) => {
          const verified = await runInSystemTerminal(
            ctx,
            "admin.users.verify-email --email invitee@example.test",
          );
          assert.equal(verified.exitCode, 0, verified.stderr);
          assert.equal(verified.stdout, "Verified invitee@example.test.\n");
          const repeated = await runInSystemTerminal(
            ctx,
            "admin.users.verify-email --email invitee@example.test",
          );
          assert.equal(repeated.exitCode, 0, repeated.stderr);
          assert.equal(repeated.stdout, "invitee@example.test was already verified.\n");
        }),
        then.assert("the page and the terminal list the invitation", async (ctx) => {
          const listed = await runInUserTerminal(
            ctx,
            ctx.vars.inviteeCookie,
            "account.invitations.list --format json",
          );
          assert.equal(listed.exitCode, 0, listed.stderr);
          expect(JSON.parse(listed.stdout)).toEqual({
            invitations: [expect.objectContaining({ invitationId: ctx.vars.invitationId })],
          });

          const page = await openOrganizationsPage(ctx, ctx.vars.inviteeCookie);
          assert(page.status === "listed");
          expect(page.invitations).toEqual([
            expect.objectContaining({
              invitation: expect.objectContaining({ id: ctx.vars.invitationId }),
              organization: expect.objectContaining({ name: "Acme" }),
            }),
          ]);
        }),
      ],
    }),
  );
});

test("users name their organizations, and Auth gives each a free slug", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "organization creation from the organizations page",
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_INVITATIONS_ENABLED: "false" },
      vars: () => ({ firstCookie: "", secondCookie: "" }),
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "first@example.test", captureSessionCookieAs: "firstCookie" }),
        when.auth.signUp({ email: "second@example.test", captureSessionCookieAs: "secondCookie" }),
        then.assert("both users create an organization with the same name", async (ctx) => {
          expect(
            await createOrganizationFromPage(ctx, ctx.vars.firstCookie, "  my COOL org "),
          ).toEqual({ returnTo: "/backoffice/dashboard/org/my-cool-org" });
          expect(
            await createOrganizationFromPage(ctx, ctx.vars.secondCookie, "my COOL org"),
          ).toEqual({ returnTo: "/backoffice/dashboard/org/my-cool-org-2" });
          const organizations = await ctx.runtime.objects.auth
            .singleton()
            .commands.getAllOrganizations();
          expect(organizations.map(({ name, slug }) => ({ name, slug }))).toEqual(
            expect.arrayContaining([
              { name: "my COOL org", slug: "my-cool-org" },
              { name: "my COOL org", slug: "my-cool-org-2" },
            ]),
          );
        }),
      ],
    }),
  );
});
