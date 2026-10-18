import { assert, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { z } from "zod";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
  type BackofficeScenarioStep,
} from "@/fragno/automation/scenario";
import { action as installAction, loader as installLoader } from "@/routes/backoffice/app-install";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { InMemoryApiObject } from "../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../workers/apps.do";
import { InMemoryAuthObject } from "../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../workers/automations.do";
import { InMemoryFormsObject } from "../../workers/forms.do";
import { InMemoryOtpObject } from "../../workers/otp.do";
import { InMemoryUploadObject } from "../../workers/upload.do";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const origin = "https://backoffice.example";
const redirectUri = "https://bookkeeping.example/api/auth/oauth2/callback/backoffice";
const emit = BACKOFFICE_PERMISSION.events.emit;
const everyProvisioningPermission = [
  "users.provision",
  "organizations.provision",
  "projects.provision",
  "organizations.members.sync",
] as const;

type Vars = {
  existingCookie: string;
  existingUserId: string;
  existingOrgId: string;
  clientId: string;
  clientSecret: string;
  appId: string;
  token: string;
  ownerId: string;
  memberId: string;
  orgId: string;
  projectId: string;
};
type Ctx = BackofficeScenarioContext<Vars>;

function routerContext(ctx: Ctx, request: Request) {
  return createBackofficeRouterContextProvider(request, {
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
}

async function requestClientCredentialsToken(ctx: Ctx): Promise<string> {
  const response = await ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`${ctx.vars.clientId}:${ctx.vars.clientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "backoffice",
        resource: origin,
      }),
    }),
  );
  assert.equal(response.status, 200, await response.clone().text());
  return z.object({ access_token: z.string() }).parse(await response.json()).access_token;
}

async function sessionUserId(ctx: Ctx, cookie: string) {
  const response = await ctx.runtime.objects.auth
    .singleton()
    .http.fetch(new Request(`${origin}/api/auth/get-session`, { headers: { cookie, origin } }));
  return z.object({ user: z.object({ id: z.string() }) }).parse(await response.json()).user.id;
}

async function runFirstPartyScenario(
  name: string,
  steps: (
    then: (label: string, assertion: (ctx: Ctx) => Promise<void>) => BackofficeScenarioStep,
  ) => BackofficeScenarioStep[],
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-first-party-app-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario<Vars>({
        name,
        objects: scenarioObjects,
        options: { sqliteDataDirectory: directory },
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_INVITATIONS_ENABLED: "false" },
        vars: () => ({
          existingCookie: "",
          existingUserId: "",
          existingOrgId: "",
          clientId: "",
          clientSecret: "",
          appId: "",
          token: "",
          ownerId: "",
          memberId: "",
          orgId: "",
          projectId: "",
        }),
        setup: ({ given }) => [given.auth.user({ id: "platform-admin", role: "admin" })],
        steps: ({ when, then }) => [
          when.auth.signUp({
            email: "existing@backoffice.test",
            captureSessionCookieAs: "existingCookie",
          }),
          when.auth.createOrganization({
            cookie: ({ vars }) => vars.existingCookie,
            name: "Existing Workspace",
            slug: "existing-workspace",
            captureOrganizationIdAs: "existingOrgId",
          }),
          then.assert(
            "an administrator registers Bookkeeping as a first-party app",
            async (ctx) => {
              ctx.vars.existingUserId = await sessionUserId(ctx, ctx.vars.existingCookie);
              const client = await ctx.runtime.objects.auth
                .singleton()
                .commands.createAdminOAuthClient({
                  administratorUserId: "platform-admin",
                  name: "Bookkeeping",
                  redirectUris: [redirectUri],
                  scopes: ["openid", "profile", "email", "offline_access", "backoffice"],
                  clientType: "confidential",
                  applicationType: "web",
                  clientCredentials: true,
                });
              assert(client.clientType === "confidential");
              ctx.vars.clientId = client.clientId;
              ctx.vars.clientSecret = client.clientSecret;
              const registered = await ctx.runtime.objects.apps.singleton().commands.registerApp({
                slug: "bookkeeping",
                oauthClientId: client.clientId,
                requestedPermissions: [emit],
                actions: { kind: "none" },
                trust: {
                  kind: "first-party",
                  provisioningPermissions: [...everyProvisioningPermission],
                },
              });
              assert(registered.ok);
              ctx.vars.appId = registered.value.appId;
              ctx.vars.token = await requestClientCredentialsToken(ctx);
            },
          ),
          ...steps((label, assertion) => then.assert(label, assertion)),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("an owner links an existing organization to a first-party app without reviewing its permissions", async () => {
  await runFirstPartyScenario("first-party install page", (then) => [
    then(
      "the install page offers only where to install, and grants what the app asks for",
      async (ctx) => {
        const url = new URL(`${origin}/backoffice/apps/install`);
        url.search = new URLSearchParams({
          client_id: ctx.vars.clientId,
          redirect_uri: "https://bookkeeping.example/dashboard/backoffice/callback",
          state: "bookkeeping-link-state",
        }).toString();
        const cookie = ctx.vars.existingCookie;
        const page = new Request(url, { headers: { cookie } });
        const loaded = await installLoader({
          request: page,
          context: routerContext(ctx, page),
          params: {},
          url,
          pattern: "/backoffice/apps/install",
        });
        expect(loaded.data).toMatchObject({ firstParty: true });

        const decision = new Request(url, {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams([
            ["intent", "install"],
            ["owner", `org:${ctx.vars.existingOrgId}`],
            ["resources", "owner"],
            ["actionsRevision", "1"],
          ]),
        });
        const installed = await installAction({
          request: decision,
          context: routerContext(ctx, decision),
          params: {},
          url,
          pattern: "/backoffice/apps/install",
        });
        assert(installed instanceof Response, JSON.stringify(installed));
        assert(new URL(installed.headers.get("location") ?? "").searchParams.has("code"));
        expect(
          await ctx.runtime.objects.appInstallations
            .forOrg(ctx.vars.existingOrgId)
            .commands.getInstallation({ appId: ctx.vars.appId }),
        ).toMatchObject({
          status: "active",
          grantedPermissions: [emit],
          resourceScope: { kind: "owner" },
        });
      },
    ),
  ]);
});
