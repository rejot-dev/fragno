import { assert, expect, test, vi } from "vitest";

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
} from "@/fragno/automation/scenario";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { InMemoryApiObject } from "../../../workers/api.do";
import { InMemoryAuthObject } from "../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../workers/forms.do";
import { InMemoryOtpObject } from "../../../workers/otp.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import { action } from "./organizations";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const origin = "https://backoffice.example";

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
    params: {},
  } as never);
  assert(response instanceof Response);
  const location = new URL(response.headers.get("location") ?? "", origin);
  return { returnTo: location.searchParams.get("returnTo") };
}

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
