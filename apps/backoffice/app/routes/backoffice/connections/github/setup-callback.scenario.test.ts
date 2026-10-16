import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { z } from "zod";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { behindBackofficeLayout } from "@/layouts/backoffice-layout.test-support";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { InMemoryApiObject } from "../../../../../workers/api.do";
import { InMemoryAuthObject } from "../../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../../../workers/forms.do";
import { InMemoryGitHubWebhookRouterObject } from "../../../../../workers/github-webhook-router.do";
import { InMemoryOtpObject } from "../../../../../workers/otp.do";
import { InMemoryTelegramObject } from "../../../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../../../workers/upload.do";
import { loader as setupCallbackLoader } from "./setup-callback";

const loader = behindBackofficeLayout(setupCallbackLoader);

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new InMemoryGitHubWebhookRouterObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const orgId = "org-github";
const orgSlug = "github-org";

/** Signs the captured session into the organization and returns its browser cookie and user. */
async function signInToOrganization(ctx: BackofficeScenarioContext) {
  const auth = ctx.runtime.objects.auth.singleton();
  const sessionCookie = ctx.vars.session;
  assert(typeof sessionCookie === "string");
  const session = await auth.http.fetch(
    new Request("https://example.com/api/auth/get-session", {
      headers: { cookie: sessionCookie },
    }),
  );
  assert(session.ok);
  const userId = z.object({ user: z.object({ id: z.string() }) }).parse(await session.json())
    .user.id;
  await auth.commands.applyScenarioFixture({
    members: [{ organizationId: orgId, userId, roles: ["owner"] }],
  });
  const exchange = await auth.http.fetch(
    new Request("https://example.com/api/auth/backoffice-token", {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: "https://example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ selection: "preferred", organizationId: orgId }),
    }),
  );
  assert(exchange.ok, await exchange.clone().text());
  const cookie = exchange.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  return { cookie, userId };
}

/** GitHub sends the browser to the app's setup URL; returns where Backoffice sends it next. */
async function returnFromGitHub(ctx: BackofficeScenarioContext, cookie: string, query: string) {
  const url = new URL(
    `/backoffice/connections/github/setup-callback?${query}`,
    "https://example.com",
  );
  const request = new Request(url, { headers: { cookie } });
  const response = await loader({
    request,
    url,
    pattern: "/backoffice/connections/github/setup-callback",
    params: {},
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
  });
  assert(response.status === 302);
  const location = response.headers.get("location");
  assert(location);
  return new URL(location, url);
}

test("GitHub's install return lands on the organization's GitHub page or reports why it cannot", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "GitHub App setup callback landings",
      setup: ({ given }) => [
        given.organization.exists({ id: orgId, slug: orgSlug, name: "GitHub Org" }),
      ],
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "installer@example.test", captureSessionCookieAs: "session" }),
        then.assert(
          "a return with the user's install state continues on the GitHub configuration page",
          async (ctx) => {
            const { cookie, userId } = await signInToOrganization(ctx);
            const install = await ctx.runtime.objects.githubWebhookRouter
              .singleton()
              .commands.createInstallStatefulUrl(userId, orgId);
            assert(install.ok);
            const state = new URL(install.installUrl).searchParams.get("state");
            assert(state);

            const landing = await returnFromGitHub(
              ctx,
              cookie,
              `installation_id=42&setup_action=install&state=${encodeURIComponent(state)}`,
            );
            expect(landing.pathname).toBe(
              `/backoffice/integrations/org/${orgSlug}/github/configuration`,
            );
            // The configuration page completes the install from GitHub's parameters.
            assert(landing.searchParams.get("installation_id") === "42");
            expect(landing.searchParams.get("state")).toBe(state);
          },
        ),
        then.assert(
          "returns without usable state report the reason on the organization's table",
          async (ctx) => {
            const { cookie } = await signInToOrganization(ctx);
            for (const query of ["installation_id=42", "installation_id=42&state=unknown"]) {
              const landing = await returnFromGitHub(ctx, cookie, query);
              expect(landing.pathname).toBe(`/backoffice/integrations/org/${orgSlug}`);
              assert(landing.searchParams.get("oauth") === "error");
              expect(landing.searchParams.get("message")).toEqual(expect.any(String));
            }
          },
        ),
      ],
    }),
  );
});
