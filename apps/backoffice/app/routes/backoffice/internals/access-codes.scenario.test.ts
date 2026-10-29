import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {},
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
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

import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
import { OtpObject } from "../../../../workers/otp-object";
import { loader as redemptionsLoader } from "./access-code-redemptions";
import { action, loader } from "./access-codes";

const scenarioObjects = {
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  OTP: (input) => new OtpObject(input),
} satisfies LocalBackofficeObjects;

const origin = "https://backoffice.example";
const pagePath = "/backoffice/internals/system/system/access-codes";

function routeArgs(
  ctx: BackofficeScenarioContext,
  request: Request,
  params: Record<string, string> = {},
) {
  return {
    request,
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
    url: new URL(request.url),
    params,
  } as never;
}

async function submitPageForm(ctx: BackofficeScenarioContext, form: Record<string, string>) {
  return await action(
    routeArgs(
      ctx,
      new Request(`${origin}${pagePath}`, {
        method: "POST",
        headers: { origin },
        body: new URLSearchParams(form),
      }),
    ),
  );
}

async function openPage(ctx: BackofficeScenarioContext, query = "") {
  return await loader(routeArgs(ctx, new Request(`${origin}${pagePath}${query}`)));
}

test("administrators create, share, follow, and revoke access codes on the internals page", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "access codes managed from the internals page",
      env: { SIGN_UP_ACCESS_CODES_REQUIRED: "true" },
      vars: () => ({ signUpUrl: "" }),
      steps: ({ then }) => [
        then.assert("the form creates a code and shows its sign-up link", async (ctx) => {
          const created = await submitPageForm(ctx, {
            intent: "create",
            label: "Design partners",
            expiresInDays: "7",
          });
          assert(created.state === "created", JSON.stringify(created));
          assert.equal(created.label, "Design partners");
          const url = new URL(created.url);
          assert.equal(`${url.origin}${url.pathname}`, `${origin}/backoffice/sign-up`);
          assert(url.searchParams.get("code"));
          ctx.vars.signUpUrl = created.url;
        }),
        then.assert("the page lists the code, so its link can be copied again", async (ctx) => {
          const page = await openPage(ctx);
          const code = new URL(ctx.vars.signUpUrl).searchParams.get("code");
          expect(page.accessCodes).toEqual([
            expect.objectContaining({
              code,
              label: "Design partners",
              status: "active",
            }),
          ]);
          assert(page.accessCodes[0]?.expiresAt);
          assert.equal(page.signUpOrigin, origin);
        }),
        then.assert("the code's page lists the accounts it admitted", async (ctx) => {
          const code = new URL(ctx.vars.signUpUrl).searchParams.get("code");
          assert(code);
          const signUp = await ctx.runtime.objects.auth.singleton().http.fetch(
            new Request(`${origin}/api/auth/sign-up/email`, {
              method: "POST",
              headers: { "content-type": "application/json", origin },
              body: JSON.stringify({
                name: "Partner",
                email: "partner@example.com",
                password: "password123",
                accessCode: code,
              }),
            }),
          );
          assert(signUp.ok, await signUp.text());
          const request = new Request(`${origin}${pagePath}/${code}`);
          const page = await redemptionsLoader(routeArgs(ctx, request, { code }));
          assert.equal(page.accessCode.redemptionCount, 1);
          expect(page.page.redemptions).toEqual([
            expect.objectContaining({ email: "partner@example.com" }),
          ]);
          assert.equal(page.signUpUrl, ctx.vars.signUpUrl);
          expect((await openPage(ctx)).accessCodes).toEqual([
            expect.objectContaining({ code, redemptionCount: 1 }),
          ]);
        }),
        then.assert("the revoke button revokes the code", async (ctx) => {
          const page = await openPage(ctx);
          const accessCodeId = page.accessCodes[0]?.id;
          assert(accessCodeId);
          expect(await submitPageForm(ctx, { intent: "revoke", accessCodeId })).toEqual({
            state: "revoked",
            label: "Design partners",
          });
          expect((await openPage(ctx)).accessCodes).toEqual([
            expect.objectContaining({ id: accessCodeId, status: "revoked" }),
          ]);
        }),
        then.assert("By label makes the code from the label, once", async (ctx) => {
          const byLabel = { intent: "create", label: "Beta testers", codeSource: "label" };
          const created = await submitPageForm(ctx, { ...byLabel, expiresInDays: "" });
          assert(created.state === "created", JSON.stringify(created));
          assert.equal(new URL(created.url).searchParams.get("code"), "BETA-TESTERS");
          expect(await submitPageForm(ctx, { ...byLabel, expiresInDays: "" })).toEqual({
            state: "error",
            message: "The code BETA-TESTERS already exists. Give this one another label.",
          });
        }),
        then.assert("a code without a label is refused", async (ctx) => {
          expect(
            await submitPageForm(ctx, {
              intent: "create",
              label: " ",
              expiresInDays: "",
            }),
          ).toEqual({
            state: "error",
            message: "Give the code a label, and use whole days for its expiry.",
          });
        }),
        then.assert("a forged cursor is a bad request", async (ctx) => {
          const response = await openPage(ctx, "?cursor=forged").catch((error: unknown) => error);
          assert(response instanceof Response);
          assert.equal(response.status, 400);
        }),
      ],
    }),
  );
});
