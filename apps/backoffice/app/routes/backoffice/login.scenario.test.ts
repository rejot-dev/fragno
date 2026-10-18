import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { issueBackofficeTokenResultSchema } from "@/fragno/auth/contracts";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { establishBackofficeAuthenticatedRequest } from "@/layouts/backoffice-authenticated-request.server";
import {
  establishBackofficeShellRequest,
  getBackofficeShellRequest,
} from "@/layouts/backoffice-shell-request.server";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { InMemoryAuthObject } from "../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../workers/automations.do";
import { InMemoryOtpObject } from "../../../workers/otp.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import { buildBackofficeLoginPath } from "./auth-navigation";
import { action, loader } from "./login";

const scenarioObjects = {
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const origin = "https://backoffice.example";

function loginScenarioRouterContext(ctx: BackofficeScenarioContext, request: Request) {
  return createBackofficeRouterContextProvider(request, {
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
}

function setCookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .filter((value) => !value.includes("Max-Age=0"))
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

/** Opens a workspace page through both Backoffice middlewares and returns its shell. */
async function openWorkspace(
  ctx: BackofficeScenarioContext,
  path: string,
  cookie: string,
  orgSlug: string,
) {
  const request = new Request(new URL(path, origin), { headers: { cookie } });
  const context = loginScenarioRouterContext(ctx, request);
  const args = {
    request,
    context,
    url: new URL(request.url),
    params: { scopeKind: "org", scopeId: orgSlug },
  };
  await establishBackofficeAuthenticatedRequest(args, () =>
    establishBackofficeShellRequest(args, async () => new Response()),
  );
  return getBackofficeShellRequest(context);
}

test.each([
  "dashboard/org/{slug}?selection=route&selected=route-1",
  "integrations/org/{slug}/mcp?oauth=success&server=agensi",
])(
  "password login after clearing browser data returns to the slug-backed %s page",
  async (destination) => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: `password login preserves the organization slug for ${destination}`,
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_INVITATIONS_ENABLED: "false" },
        vars: () => ({ session: "" }),
        steps: ({ when, then }) => [
          when.auth.signUp({
            email: "login-navigation@example.test",
            captureSessionCookieAs: "session",
          }),
          when.auth.createOrganization({
            cookie: ({ vars }) => vars.session,
            name: "Login Navigation",
            slug: "login-navigation",
          }),
          then.assert(
            "fresh login opens the original workspace with valid credentials",
            async (ctx) => {
              const exchange = await ctx.runtime.objects.auth.singleton().http.fetch(
                new Request(`${origin}/api/auth/backoffice-token`, {
                  method: "POST",
                  headers: { cookie: ctx.vars.session, origin, "content-type": "application/json" },
                  body: JSON.stringify({ selection: "preferred" }),
                }),
              );
              assert(exchange.ok, await exchange.clone().text());
              const { organization } = issueBackofficeTokenResultSchema.parse(
                await exchange.json(),
              );
              assert(organization);
              assert.notEqual(organization.id, organization.slug);
              const returnTo = `/backoffice/${destination.replace("{slug}", organization.slug)}`;
              const loginUrl = new URL(buildBackofficeLoginPath(returnTo), origin);

              // Browser data has been cleared: neither the session nor the access JWT is sent.
              const loginRequest = new Request(loginUrl);
              const loginPage = await loader({
                request: loginRequest,
                context: loginScenarioRouterContext(ctx, loginRequest),
                params: {},
                pattern: "/backoffice/login",
                url: loginUrl,
              });
              assert(!(loginPage instanceof Response));
              expect(loginPage).toMatchObject({ returnTo });

              const signInRequest = new Request(loginUrl, {
                method: "POST",
                headers: { origin },
                body: new URLSearchParams({
                  intent: "sign_in",
                  email: "login-navigation@example.test",
                  password: "password123",
                }),
              });
              const response = await action({
                request: signInRequest,
                context: loginScenarioRouterContext(ctx, signInRequest),
                params: {},
                pattern: "/backoffice/login",
                url: loginUrl,
              });
              assert(response instanceof Response, JSON.stringify(response));
              assert.equal(response.status, 302);
              assert.equal(response.headers.get("location"), returnTo);

              // The destination mints its access token from the session, then reopens itself.
              let cookie = setCookies(response);
              const minted = await openWorkspace(ctx, returnTo, cookie, organization.slug).catch(
                (error: unknown) => error,
              );
              assert(minted instanceof Response, String(minted));
              assert.equal(minted.headers.get("location"), returnTo);
              cookie = `${cookie}; ${setCookies(minted)}`;

              const opened = await openWorkspace(ctx, returnTo, cookie, organization.slug);
              expect(opened.route).toMatchObject({
                status: "resolved",
                execution: { scope: { kind: "org", orgId: organization.id } },
              });
              expect(opened.resolvedScope).toMatchObject({ kind: "org", organization });
            },
          ),
        ],
      }),
    );
  },
);
