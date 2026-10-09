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

test.each(["dashboard?tab=runs", "mcp?oauth=success&server=agensi"])(
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
          then.assert(
            "fresh login opens the original workspace with valid credentials",
            async (ctx) => {
              const exchange = await ctx.runtime.objects.auth.singleton().http.fetch(
                new Request(`${origin}/api/auth/backoffice-token`, {
                  method: "POST",
                  headers: { cookie: ctx.vars.session, origin, "content-type": "application/json" },
                  body: JSON.stringify({ selection: "preferred", organizationId: null }),
                }),
              );
              assert(exchange.ok, await exchange.clone().text());
              const { organization } = issueBackofficeTokenResultSchema.parse(
                await exchange.json(),
              );
              assert(organization);
              assert.notEqual(organization.id, organization.slug);
              const returnTo = `/backoffice/automations/org/${organization.slug}/${destination}`;
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
              expect(loginPage).toMatchObject({ authenticated: false, returnTo });

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

              const cookie = response.headers
                .getSetCookie()
                .filter((value) => !value.includes("Max-Age=0"))
                .map((value) => value.split(";", 1)[0])
                .join("; ");
              const destinationRequest = new Request(new URL(returnTo, origin), {
                headers: { cookie },
              });
              const context = loginScenarioRouterContext(ctx, destinationRequest);
              const opened = await establishBackofficeAuthenticatedRequest(
                { request: destinationRequest, context },
                () =>
                  establishBackofficeShellRequest(
                    {
                      request: destinationRequest,
                      context,
                      params: { scopeKind: "org", scopeId: organization.slug },
                    },
                    async () => {
                      const shell = getBackofficeShellRequest(context);
                      expect(shell.runtimeScope).toEqual({ kind: "org", orgId: organization.id });
                      expect(shell.resolvedScope).toMatchObject({ kind: "org", organization });
                      return new Response("Workspace opened");
                    },
                  ),
              );
              assert.equal(opened.status, 200);
            },
          ),
        ],
      }),
    );
  },
);
