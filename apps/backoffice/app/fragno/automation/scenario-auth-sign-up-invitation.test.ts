import { assert, describe, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {},
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { SIGN_UP_INVITATION_TYPE } from "@/fragno/otp";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { sha256Hex } from "@/lib/crypto";

import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
  type BackofficeScenarioStep,
} from "./scenario";

type SignUpInvitationScenarioVars = {
  invitationUrl: string;
  firstInvitationUrl: string;
  secondInvitationUrl: string;
};

type CreateSignUpInvitationStepInput = {
  email: string;
  captureUrlAs: keyof SignUpInvitationScenarioVars;
};

const PASSWORD = "password123";

type PasswordSignUpRequest = {
  email: string;
  invitation:
    | { kind: "none" }
    | {
        kind: "link";
        url: string;
      };
};

function requestPasswordSignUp(ctx: BackofficeScenarioContext, input: PasswordSignUpRequest) {
  const invitationUrl = input.invitation.kind === "link" ? new URL(input.invitation.url) : null;
  return ctx.runtime.objects.auth.singleton().http.fetch(
    new Request("https://backoffice.example/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://backoffice.example",
      },
      body: JSON.stringify({
        name: input.email.split("@", 1)[0] || input.email,
        email: input.email,
        password: PASSWORD,
        ...(invitationUrl
          ? {
              invitationId: invitationUrl.searchParams.get("invitationId"),
              invitationCode: invitationUrl.searchParams.get("code"),
            }
          : {}),
      }),
    }),
  );
}

async function assertSignUpInvitationRequired(response: Response) {
  assert.equal(response.status, 403);
  const body = (await response.json()) as { code?: string };
  assert.equal(body.code, "SIGN_UP_INVITATION_REQUIRED");
}

function requestPasswordSignIn(ctx: BackofficeScenarioContext, email: string) {
  return ctx.runtime.objects.auth.singleton().http.fetch(
    new Request("https://backoffice.example/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://backoffice.example",
      },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
}

function createSignUpInvitation(input: CreateSignUpInvitationStepInput): BackofficeScenarioStep {
  return {
    kind: "when",
    type: "admin.createSignUpInvitation",
    label: `create a sign-up invitation for ${input.email} through the system admin command`,
    async run(ctx: BackofficeScenarioContext<SignUpInvitationScenarioVars>) {
      const execution = createBackofficeSystemExecution({ kind: "system" });
      const kernel = new BackofficeKernel(ctx.runtime.services);
      const { bash } = createInteractiveBashHost({
        fs: ctx.files.forOrg(),
        context: createRouteBackedRuntimeContext({
          runtime: ctx.runtime.services,
          kernel,
          execution,
        }),
      });
      const result = await bash.exec(
        `admin.signup-invitations.create --email ${input.email} --ttl-days 3 --print url`,
      );

      assert.equal(result.exitCode, 0, result.stderr);
      const invitationUrl = result.stdout.trim();
      const parsedInvitationUrl = new URL(invitationUrl);
      assert(parsedInvitationUrl.searchParams.get("invitationId"));
      assert(parsedInvitationUrl.searchParams.get("code"));
      ctx.vars[input.captureUrlAs] = invitationUrl;
    },
  };
}

describe("Auth sign-up invitation scenarios", () => {
  test("only the invited email can create a Backoffice account", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "Backoffice account creation requires an email-bound admin invitation",
        env: { SIGN_UP_INVITATIONS_ENABLED: "true" },
        vars: (): SignUpInvitationScenarioVars => ({
          invitationUrl: "",
          firstInvitationUrl: "",
          secondInvitationUrl: "",
        }),
        steps: ({ then }) => [
          then.assert("direct password sign-up without an invitation is rejected", async (ctx) => {
            const response = await requestPasswordSignUp(ctx, {
              email: "uninvited@example.com",
              invitation: { kind: "none" },
            });
            await assertSignUpInvitationRequired(response);
          }),
          createSignUpInvitation({
            email: "invited@example.com",
            captureUrlAs: "invitationUrl",
          }),
          then.assert("the invitation cannot create an account for another email", async (ctx) => {
            const response = await requestPasswordSignUp(ctx, {
              email: "attacker@example.com",
              invitation: { kind: "link", url: ctx.vars.invitationUrl },
            });
            await assertSignUpInvitationRequired(response);
          }),
          then.assert("the invited email creates an account and can sign in", async (ctx) => {
            const signUpResponse = await requestPasswordSignUp(ctx, {
              email: "invited@example.com",
              invitation: { kind: "link", url: ctx.vars.invitationUrl },
            });
            assert(signUpResponse.ok, await signUpResponse.text());

            const signInResponse = await requestPasswordSignIn(ctx, "invited@example.com");
            assert(signInResponse.ok, await signInResponse.text());
          }),
        ],
      }),
    );
  });

  test("reissuing an invitation rotates the code for the hashed email id", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "Reissuing a sign-up invitation supersedes the previous email-bound link",
        env: { SIGN_UP_INVITATIONS_ENABLED: "true" },
        vars: (): SignUpInvitationScenarioVars => ({
          invitationUrl: "",
          firstInvitationUrl: "",
          secondInvitationUrl: "",
        }),
        steps: ({ then }) => [
          createSignUpInvitation({
            email: "rotated@example.com",
            captureUrlAs: "firstInvitationUrl",
          }),
          createSignUpInvitation({
            email: "rotated@example.com",
            captureUrlAs: "secondInvitationUrl",
          }),
          then.assert("both issuances use the hashed email id and different codes", async (ctx) => {
            const firstInvitation = new URL(ctx.vars.firstInvitationUrl);
            const secondInvitation = new URL(ctx.vars.secondInvitationUrl);
            const expectedInvitationId = await sha256Hex(
              new TextEncoder().encode(`${SIGN_UP_INVITATION_TYPE}:rotated@example.com`),
            );

            assert.equal(firstInvitation.searchParams.get("invitationId"), expectedInvitationId);
            assert.equal(secondInvitation.searchParams.get("invitationId"), expectedInvitationId);
            assert.notEqual(
              firstInvitation.searchParams.get("code"),
              secondInvitation.searchParams.get("code"),
            );
          }),
          then.assert("the previous invitation no longer authorizes sign-up", async (ctx) => {
            const response = await requestPasswordSignUp(ctx, {
              email: "rotated@example.com",
              invitation: { kind: "link", url: ctx.vars.firstInvitationUrl },
            });
            await assertSignUpInvitationRequired(response);
          }),
          then.assert("the replacement invitation authorizes sign-up", async (ctx) => {
            const response = await requestPasswordSignUp(ctx, {
              email: "rotated@example.com",
              invitation: { kind: "link", url: ctx.vars.secondInvitationUrl },
            });
            assert(response.ok, await response.text());
          }),
        ],
      }),
    );
  });

  test("allows direct account creation when sign-up invitations are disabled", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "Backoffice account creation is open when sign-up invitations are disabled",
        env: { SIGN_UP_INVITATIONS_ENABLED: "false" },
        steps: ({ then }) => [
          then.assert("password sign-up succeeds without an invitation", async (ctx) => {
            const signUpResponse = await requestPasswordSignUp(ctx, {
              email: "local-user@example.com",
              invitation: { kind: "none" },
            });
            assert(signUpResponse.ok, await signUpResponse.text());

            const signInResponse = await requestPasswordSignIn(ctx, "local-user@example.com");
            assert(signInResponse.ok, await signInResponse.text());
          }),
        ],
      }),
    );
  });
});
