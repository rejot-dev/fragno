import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { z } from "zod";

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { AppsObject } from "../../../workers/apps-object";
import { AuthObject } from "../../../workers/auth-object";
import { AutomationsObject } from "../../../workers/automations-object";
import { FormsObject } from "../../../workers/forms-object";
import { OtpObject } from "../../../workers/otp-object";
import { UploadObject } from "../../../workers/upload-object";
import { action, loader } from "./organizations";

const scenarioObjects = {
  APPS: (input) => new AppsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  FORMS: (input) => new FormsObject(input),
  OTP: (input) => new OtpObject(input),
  UPLOAD: (input) => new UploadObject(input),
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
    emitter: { kind: "caller" },
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeUserExecution({
      scope: { kind: "user", userId, jurisdiction: null },
      userId,
    }),
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
  return { opens: response.headers.get("location") };
}

test("without email verification, an invitee sees their invitations on the page and in their terminal as soon as they sign up", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "organizations page for an invitee where email goes unverified",
      // As in local development, where every address counts as verified.
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_ACCESS_CODES_REQUIRED: "false" },
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
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_ACCESS_CODES_REQUIRED: "false" },
      vars: () => ({ firstCookie: "", secondCookie: "" }),
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "first@example.test", captureSessionCookieAs: "firstCookie" }),
        when.auth.signUp({ email: "second@example.test", captureSessionCookieAs: "secondCookie" }),
        then.assert("both users create an organization with the same name", async (ctx) => {
          expect(
            await createOrganizationFromPage(ctx, ctx.vars.firstCookie, "  my COOL org "),
          ).toEqual({ opens: "/backoffice/dashboard/org/my-cool-org" });
          expect(
            await createOrganizationFromPage(ctx, ctx.vars.secondCookie, "my COOL org"),
          ).toEqual({ opens: "/backoffice/dashboard/org/my-cool-org-2" });
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
        then.assert(
          "slugs keep numbering, apart from names that only share their beginning",
          async (ctx) => {
            expect(
              await createOrganizationFromPage(ctx, ctx.vars.firstCookie, "My Cool Org Corp"),
            ).toEqual({ opens: "/backoffice/dashboard/org/my-cool-org-corp" });
            const opened = [];
            for (let created = 0; created < 20; created += 1) {
              opened.push(
                await createOrganizationFromPage(ctx, ctx.vars.firstCookie, "my cool org"),
              );
            }
            expect(opened.at(-1)).toEqual({ opens: "/backoffice/dashboard/org/my-cool-org-22" });
          },
        ),
        then.assert(
          "names without Latin letters or digits number from organization",
          async (ctx) => {
            expect(
              await createOrganizationFromPage(ctx, ctx.vars.secondCookie, "株式会社"),
            ).toEqual({
              opens: "/backoffice/dashboard/org/organization",
            });
            expect(await createOrganizationFromPage(ctx, ctx.vars.secondCookie, "Ωμέγα")).toEqual({
              opens: "/backoffice/dashboard/org/organization-2",
            });
          },
        ),
      ],
    }),
  );
});

test("owners rename their organization, but cannot change its slug or delete it through Better Auth", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "organization slugs and deletion",
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_ACCESS_CODES_REQUIRED: "false" },
      vars: () => ({ cookie: "" }),
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "owner@example.test", captureSessionCookieAs: "cookie" }),
        then.assert("only the name changes, and the organization stays", async (ctx) => {
          await createOrganizationFromPage(ctx, ctx.vars.cookie, "Acme");
          const auth = ctx.runtime.objects.auth.singleton();
          const organization = await auth.commands.getOrganizationBySlug("acme");
          assert(organization);
          const callOrganizationEndpoint = async (path: string, body: unknown) =>
            await auth.http.fetch(
              new Request(`${origin}/api/auth/organization/${path}`, {
                method: "POST",
                headers: { cookie: ctx.vars.cookie, origin, "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
            );

          const renamed = await callOrganizationEndpoint("update", {
            organizationId: organization.id,
            data: { name: "Acme Inc." },
          });
          assert.equal(renamed.status, 200, await renamed.clone().text());
          const reslugged = await callOrganizationEndpoint("update", {
            organizationId: organization.id,
            data: { slug: "acme-inc" },
          });
          assert.equal(reslugged.status, 400, await reslugged.clone().text());
          const deleted = await callOrganizationEndpoint("delete", {
            organizationId: organization.id,
          });
          assert.equal(deleted.status, 404, await deleted.clone().text());

          const [stored] = await auth.commands.getAllOrganizations();
          expect(stored).toMatchObject({ id: organization.id, name: "Acme Inc.", slug: "acme" });
        }),
      ],
    }),
  );
});
