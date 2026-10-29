import { assert, describe, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {},
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import type {
  AdminAccessCodePage,
  AdminAccessCodeRedemptions,
} from "@/fragno/runtime-tools/families/admin";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { AppsObject } from "../../../workers/apps-object";
import { AuthObject } from "../../../workers/auth-object";
import { AutomationsObject } from "../../../workers/automations-object";
import { FormsObject } from "../../../workers/forms-object";
import { OtpObject } from "../../../workers/otp-object";
import { UploadObject } from "../../../workers/upload-object";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
  type BackofficeScenarioStep,
} from "./scenario";

const scenarioObjects = {
  APPS: (input) => new AppsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  FORMS: (input) => new FormsObject(input),
  OTP: (input) => new OtpObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

type AccessCodeScenarioVars = {
  signUpUrl: string;
  accessCodeId: string;
};

const vars = (): AccessCodeScenarioVars => ({ signUpUrl: "", accessCodeId: "" });

const PASSWORD = "password123";
const ORIGIN = "https://backoffice.example";

async function execAdminCommand(ctx: BackofficeScenarioContext, command: string) {
  const execution = createBackofficeSystemExecution({ kind: "system" });
  const { bash } = await createInteractiveBashHost({
    context: createCodemodeRouteBackedRuntimeContext({
      emitter: { kind: "caller" },
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      execution,
    }),
  });
  return await bash.exec(command);
}

async function runAdminCommand(ctx: BackofficeScenarioContext, command: string) {
  const result = await execAdminCommand(ctx, command);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

function createAccessCode(options: string): BackofficeScenarioStep {
  return {
    kind: "when",
    type: "admin.accessCodes.create",
    label: `create an access code with ${options}`,
    async run(ctx: BackofficeScenarioContext<AccessCodeScenarioVars>) {
      const created = JSON.parse(
        await runAdminCommand(ctx, `admin.access-codes.create ${options} --format json`),
      ) as { id: string; url: string };
      ctx.vars.signUpUrl = created.url;
      ctx.vars.accessCodeId = created.id;
    },
  };
}

function revokeAccessCode(): BackofficeScenarioStep {
  return {
    kind: "when",
    type: "admin.accessCodes.revoke",
    label: "revoke the access code",
    async run(ctx: BackofficeScenarioContext<AccessCodeScenarioVars>) {
      await runAdminCommand(ctx, `admin.access-codes.revoke --id ${ctx.vars.accessCodeId}`);
    },
  };
}

async function listAccessCodes(ctx: BackofficeScenarioContext): Promise<AdminAccessCodePage> {
  return JSON.parse(await runAdminCommand(ctx, "admin.access-codes.list --format json"));
}

async function listRedemptions(
  ctx: BackofficeScenarioContext,
  code: string,
): Promise<AdminAccessCodeRedemptions> {
  return JSON.parse(
    await runAdminCommand(ctx, `admin.access-codes.redemptions --code ${code} --format json`),
  );
}

function linkAccessCode(ctx: BackofficeScenarioContext<AccessCodeScenarioVars>): string {
  const code = new URL(ctx.vars.signUpUrl).searchParams.get("code");
  assert(code, "Expected the sign-up link to carry its access code.");
  return code;
}

function requestPasswordSignUp(
  ctx: BackofficeScenarioContext,
  input: { email: string; accessCode: string | null },
) {
  return ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        name: input.email.split("@", 1)[0] || input.email,
        email: input.email,
        password: PASSWORD,
        ...(input.accessCode === null ? {} : { accessCode: input.accessCode }),
      }),
    }),
  );
}

async function assertSignUpRejected(response: Response, code: string) {
  assert.equal(response.status, 403);
  const body = (await response.json()) as { code?: string };
  assert.equal(body.code, code);
}

function requestPasswordSignIn(ctx: BackofficeScenarioContext, email: string) {
  return ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
}

/** Signs in through GitHub, which answers as a GitHub account with this address. */
async function signInWithGitHub(
  ctx: BackofficeScenarioContext,
  input: { email: string; accessCode: string | null },
): Promise<Response> {
  const auth = ctx.runtime.objects.auth.singleton();
  const githubFetch = vi.fn(async (request: string | URL | Request) => {
    const url =
      typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "github-access-token", token_type: "bearer" });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ id: 4242, login: "octo", name: "Octo", email: input.email });
    }
    if (url === "https://api.github.com/user/emails") {
      return Response.json([{ email: input.email, primary: true, verified: true }]);
    }
    throw new Error(`Unexpected GitHub request '${url}'.`);
  });
  vi.stubGlobal("fetch", githubFetch);
  try {
    const start = await auth.http.fetch(
      new Request(`${ORIGIN}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          provider: "github",
          callbackURL: `${ORIGIN}/backoffice`,
          ...(input.accessCode === null
            ? {}
            : { additionalData: { accessCode: input.accessCode } }),
        }),
      }),
    );
    assert(start.ok, await start.clone().text());
    const state = new URL(((await start.json()) as { url: string }).url).searchParams.get("state");
    assert(state);
    const cookie = start.headers
      .getSetCookie()
      .map((setCookie) => setCookie.split(";", 1)[0])
      .join("; ");
    return await auth.http.fetch(
      new Request(
        `${ORIGIN}/api/auth/callback/github?code=github-code&state=${encodeURIComponent(state)}`,
        { headers: { cookie }, redirect: "manual" },
      ),
    );
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("Auth access code scenarios", () => {
  test("a sign-up link records every account it admits", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "An access code admits password accounts and records each of them",
        env: { SIGN_UP_ACCESS_CODES_REQUIRED: "true" },
        vars,
        steps: ({ then }) => [
          then.assert("password sign-up without an access code is rejected", async (ctx) => {
            await assertSignUpRejected(
              await requestPasswordSignUp(ctx, { email: "nobody@example.com", accessCode: null }),
              "access_code_required",
            );
          }),
          createAccessCode('--label "Design partners"'),
          then.assert("the link's code creates accounts that can sign in", async (ctx) => {
            for (const email of ["partner@example.com", "second@example.com"]) {
              const signUp = await requestPasswordSignUp(ctx, {
                email,
                accessCode: linkAccessCode(ctx),
              });
              assert(signUp.ok, await signUp.text());
            }
            const signIn = await requestPasswordSignIn(ctx, "partner@example.com");
            assert(signIn.ok, await signIn.text());
          }),
          then.assert("administrators see which accounts the code admitted", async (ctx) => {
            const redemptions = await listRedemptions(ctx, linkAccessCode(ctx));
            assert.equal(redemptions.accessCode.url, ctx.vars.signUpUrl);
            assert.equal(redemptions.accessCode.redemptionCount, 2);
            const [listed] = (await listAccessCodes(ctx)).accessCodes;
            assert.equal(listed?.redemptionCount, 2);
            assert.deepEqual(
              redemptions.redemptions.map(({ email }) => email),
              ["second@example.com", "partner@example.com"],
            );
          }),
          then.assert("each admitted account is reported once", (ctx) => {
            assert.deepEqual(
              ctx.telemetry
                .filter((signal) => signal.kind === "access-code-redeemed")
                .map(({ accessCodeId, accessCodeLabel }) => ({ accessCodeId, accessCodeLabel })),
              [
                { accessCodeId: ctx.vars.accessCodeId, accessCodeLabel: "Design partners" },
                { accessCodeId: ctx.vars.accessCodeId, accessCodeLabel: "Design partners" },
              ],
            );
          }),
        ],
      }),
    );
  });

  test("a code made from its label admits whoever types the label", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "An access code made from a label works however it is typed",
        env: { SIGN_UP_ACCESS_CODES_REQUIRED: "true" },
        vars,
        steps: ({ then }) => [
          createAccessCode('--label "Launch 2026" --code-source label'),
          then.assert("the label becomes the code in the link", (ctx) => {
            assert.equal(linkAccessCode(ctx), "LAUNCH-2026");
          }),
          then.assert(
            "the label typed in another case and spacing creates an account",
            async (ctx) => {
              const signUp = await requestPasswordSignUp(ctx, {
                email: "launch@example.com",
                accessCode: "  launch   2026 ",
              });
              assert(signUp.ok, await signUp.text());
            },
          ),
          then.assert("another code cannot take the same label", async (ctx) => {
            const result = await execAdminCommand(
              ctx,
              'admin.access-codes.create --label "launch 2026" --code-source label',
            );
            assert.notEqual(result.exitCode, 0);
            assert.include(result.stderr, "An access code LAUNCH-2026 already exists");
          }),
        ],
      }),
    );
  });

  test("expired and revoked codes admit no one", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Access codes stop admitting accounts once they expire or are revoked",
        env: { SIGN_UP_ACCESS_CODES_REQUIRED: "true" },
        vars,
        steps: ({ when, then }) => [
          createAccessCode('--label "Launch week" --expires-in-days 1'),
          when.time.advance("25h"),
          then.assert("the expired code is rejected", async (ctx) => {
            await assertSignUpRejected(
              await requestPasswordSignUp(ctx, {
                email: "late@example.com",
                accessCode: linkAccessCode(ctx),
              }),
              "access_code_expired",
            );
          }),
          createAccessCode('--label "Leaked"'),
          revokeAccessCode(),
          then.assert("the revoked code is rejected", async (ctx) => {
            await assertSignUpRejected(
              await requestPasswordSignUp(ctx, {
                email: "leaked@example.com",
                accessCode: linkAccessCode(ctx),
              }),
              "access_code_invalid",
            );
          }),
          then.assert("administrators see why each code stopped", async (ctx) => {
            const page = await listAccessCodes(ctx);
            assert.deepEqual(
              page.accessCodes.map(({ label, status }) => ({ label, status })),
              [
                { label: "Leaked", status: "revoked" },
                { label: "Launch week", status: "expired" },
              ],
            );
          }),
        ],
      }),
    );
  });

  test("with email verification, password sign-up still says why a code is rejected", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Rejected access codes are reported where sign-up hides which addresses exist",
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "true", SIGN_UP_ACCESS_CODES_REQUIRED: "true" },
        fakes: ({ fake }) => ({ resend: fake.resend() }),
        vars,
        steps: ({ then }) => [
          // Better Auth allows three sign-up requests per window, so this asks no more.
          then.assert("sign-up with an unknown code is rejected as such", async (ctx) => {
            await assertSignUpRejected(
              await requestPasswordSignUp(ctx, {
                email: "guess@example.com",
                accessCode: "NOTAREALCODE2345",
              }),
              "access_code_invalid",
            );
          }),
          createAccessCode('--label "Verified team"'),
          then.assert("the code creates an account that waits for verification", async (ctx) => {
            const signUp = await requestPasswordSignUp(ctx, {
              email: "verified@example.com",
              accessCode: linkAccessCode(ctx),
            });
            assert(signUp.ok, await signUp.clone().text());
            const signIn = await requestPasswordSignIn(ctx, "verified@example.com");
            assert.equal(signIn.status, 403, await signIn.clone().text());
          }),
          revokeAccessCode(),
          then.assert("the revoked code is rejected as such", async (ctx) => {
            await assertSignUpRejected(
              await requestPasswordSignUp(ctx, {
                email: "second@example.com",
                accessCode: linkAccessCode(ctx),
              }),
              "access_code_invalid",
            );
          }),
        ],
      }),
    );
  });

  test("GitHub signs up a new person only with an access code", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "An access code carried through GitHub admits a GitHub account",
        env: { SIGN_UP_ACCESS_CODES_REQUIRED: "true" },
        vars,
        steps: ({ then }) => [
          then.assert("GitHub sign-up without an access code is rejected", async (ctx) => {
            const callback = await signInWithGitHub(ctx, {
              email: "octo@example.com",
              accessCode: null,
            });
            assert.equal(callback.status, 302);
            const location = new URL(callback.headers.get("location") ?? "");
            assert.equal(location.pathname, "/backoffice/login");
            assert.equal(location.searchParams.get("error"), "access_code_required");
          }),
          createAccessCode('--label "GitHub friends"'),
          then.assert("GitHub sign-up with the code creates the account", async (ctx) => {
            const callback = await signInWithGitHub(ctx, {
              email: "octo@example.com",
              accessCode: linkAccessCode(ctx),
            });
            assert.equal(callback.status, 302);
            assert.equal(callback.headers.get("location"), `${ORIGIN}/backoffice`);
          }),
          then.assert("the account signs in through GitHub again without a code", async (ctx) => {
            const callback = await signInWithGitHub(ctx, {
              email: "octo@example.com",
              accessCode: null,
            });
            assert.equal(callback.headers.get("location"), `${ORIGIN}/backoffice`);
            const redemptions = await listRedemptions(ctx, linkAccessCode(ctx));
            assert.deepEqual(
              redemptions.redemptions.map(({ email }) => email),
              ["octo@example.com"],
            );
          }),
        ],
      }),
    );
  });

  test("without email verification, new accounts count as verified", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Accounts created without email verification see invitations sent to them",
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_ACCESS_CODES_REQUIRED: "true" },
        vars,
        steps: ({ then }) => [
          createAccessCode('--label "Team"'),
          then.assert("the new account lists the invitations sent to its email", async (ctx) => {
            const signUp = await requestPasswordSignUp(ctx, {
              email: "teammate@example.com",
              accessCode: linkAccessCode(ctx),
            });
            assert(signUp.ok, await signUp.clone().text());
            const { user } = (await signUp.json()) as {
              user: { id: string; emailVerified: boolean };
            };
            assert.equal(user.emailVerified, true);
            const invitations = await ctx.runtime.objects.auth
              .singleton()
              .commands.listAccountInvitations({ userId: user.id });
            assert.equal(invitations.status, "listed");
          }),
        ],
      }),
    );
  });

  test("allows direct account creation when access codes are not required", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Backoffice account creation is open when access codes are not required",
        env: { SIGN_UP_ACCESS_CODES_REQUIRED: "false" },
        steps: ({ then }) => [
          then.assert("password sign-up succeeds without an access code", async (ctx) => {
            const signUp = await requestPasswordSignUp(ctx, {
              email: "local-user@example.com",
              accessCode: null,
            });
            assert(signUp.ok, await signUp.text());
            const signIn = await requestPasswordSignIn(ctx, "local-user@example.com");
            assert(signIn.ok, await signIn.text());
          }),
        ],
      }),
    );
  });
});
