import { assert, expect, test, vi } from "vitest";

import { createHash, randomBytes } from "node:crypto";

import type { AppBranding } from "@fragno-dev/backoffice-api/v0/apps";
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
} from "@/fragno/automation/scenario";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { AppsObject } from "../../../workers/apps-object";
import { AuthObject } from "../../../workers/auth-object";
import { AutomationsObject } from "../../../workers/automations-object";
import { OtpObject } from "../../../workers/otp-object";
import { ResendObject } from "../../../workers/resend-object";
import { UploadObject } from "../../../workers/upload-object";
import { action as loginAction, loader as loginLoader } from "./login";
import { loader as consentLoader } from "./oauth-consent";

const scenarioObjects = {
  APPS: (input) => new AppsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  OTP: (input) => new OtpObject(input),
  RESEND: (input) => new ResendObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const origin = "https://backoffice.example";
const redirectUri = "https://bookkeeping.example/api/auth/oauth2/callback/backoffice";
const branding: AppBranding = {
  displayName: "Bookkeeping",
  logoUrl: "https://bookkeeping.example/logo.svg",
  accentColor: "#c2560a",
  homeUrl: "https://bookkeeping.example",
  supportUrl: "https://bookkeeping.example/help",
};

type Ctx = BackofficeScenarioContext;

function routeArgs(ctx: Ctx, request: Request) {
  return {
    request,
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
    url: new URL(request.url),
    params: {},
    pattern: new URL(request.url).pathname,
  } as never;
}

async function registerApp(ctx: Ctx, slug: string, trust: "first-party" | "third-party") {
  const client = await ctx.runtime.objects.auth.singleton().commands.createAdminOAuthClient({
    administratorUserId: "platform-admin",
    name: slug,
    redirectUris: [redirectUri],
    scopes: ["openid", "profile", "email", "offline_access", "backoffice"],
    clientType: "confidential",
    applicationType: "web",
    clientCredentials: false,
  });
  const registered = await ctx.runtime.objects.apps.singleton().commands.registerApp({
    slug,
    oauthClientId: client.clientId,
    requestedPermissions: [],
    actions: { kind: "none" },
    trust:
      trust === "first-party"
        ? { kind: "first-party", provisioningPermissions: [], branding }
        : { kind: "third-party" },
  });
  assert(registered.ok);
  return client.clientId;
}

/** The app's "Get started": an authorization request from a browser without a session. */
async function openSignIn(ctx: Ctx, clientId: string) {
  const authorization = await ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(
      `${origin}/api/auth/oauth2/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid profile email offline_access backoffice",
        state: "bookkeeping-state",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(randomBytes(32).toString("base64url"))
          .digest("base64url"),
        login_hint: "ada@example.test",
      })}`,
      { headers: { accept: "text/html" } },
    ),
  );
  assert.equal(authorization.status, 302, await authorization.clone().text());
  const url = new URL(authorization.headers.get("location") ?? "", origin);
  assert.equal(url.pathname, "/backoffice/login");
  return url;
}

/** Submits the sign-in page from a browser at `ip`, as Cloudflare reports it. */
async function submit(ctx: Ctx, url: URL, fields: Record<string, string>, ip = "203.0.113.10") {
  return await loginAction(
    routeArgs(
      ctx,
      new Request(url, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": ip,
        },
        body: new URLSearchParams(fields),
      }),
    ),
  );
}

function sentCodes(ctx: Ctx, to: string) {
  return (ctx.fakes.resend?.queueEmailCalls ?? [])
    .filter(({ input }) => input.to === to && input.subject?.startsWith("Your Bookkeeping code"))
    .map(({ input }) =>
      z
        .string()
        .regex(/^\d{6}$/u)
        .parse(input.subject?.split(": ")[1]),
    );
}

/** Follows Backoffice's redirects, as the browser does with the new session, back to the app. */
async function followToApp(ctx: Ctx, signedIn: Response) {
  const cookie = signedIn.headers
    .getSetCookie()
    .filter((value) => !value.includes("Max-Age=0"))
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  let location = new URL(signedIn.headers.get("location") ?? "", origin);
  while (location.origin === origin) {
    assert.equal(location.pathname, "/backoffice/oauth/consent");
    const approved = await consentLoader(
      routeArgs(ctx, new Request(location, { headers: { cookie } })),
    );
    assert(approved instanceof Response, "First-party apps are approved without a review.");
    location = new URL(approved.headers.get("location") ?? "", origin);
  }
  return { location, cookie };
}

async function sessionUser(ctx: Ctx, cookie: string) {
  const response = await ctx.runtime.objects.auth
    .singleton()
    .http.fetch(new Request(`${origin}/api/auth/get-session`, { headers: { cookie, origin } }));
  return z
    .object({ user: z.object({ id: z.string(), email: z.string(), emailVerified: z.boolean() }) })
    .parse(await response.json()).user;
}

test("people an app sends to Backoffice sign up with a code in the app's name, even where sign-up needs an invitation", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "sign in to a first-party app with an email code",
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "true", SIGN_UP_ACCESS_CODES_REQUIRED: "true" },
      fakes: ({ fake }) => ({ resend: fake.resend() }),
      setup: ({ given }) => [given.auth.user({ id: "platform-admin", role: "admin" })],
      steps: ({ then }) => [
        then.assert("a new address signs up and returns to the app", async (ctx) => {
          const signIn = await openSignIn(
            ctx,
            await registerApp(ctx, "bookkeeping", "first-party"),
          );
          expect(await loginLoader(routeArgs(ctx, new Request(signIn)))).toEqual({
            kind: "app",
            branding,
            loginHint: "ada@example.test",
            oauthQuery: signIn.search.slice(1),
          });

          const sent = await submit(ctx, signIn, {
            intent: "send_code",
            email: "ada@example.test",
          });
          expect(sent).toEqual({
            step: "code",
            email: "ada@example.test",
            outcome: { kind: "sent" },
          });
          const [code] = sentCodes(ctx, "ada@example.test");
          assert(code);

          const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
          expect(
            await submit(ctx, signIn, {
              intent: "verify_code",
              email: "ada@example.test",
              code: wrong,
            }),
          ).toMatchObject({
            step: "code",
            outcome: {
              kind: "rejected",
              error: "That code isn't right. Check the email and try again.",
            },
          });

          const signedIn = await submit(ctx, signIn, {
            intent: "verify_code",
            email: "ada@example.test",
            code: `${code.slice(0, 3)} ${code.slice(3)}`,
          });
          assert(signedIn instanceof Response, JSON.stringify(signedIn));
          const { location, cookie } = await followToApp(ctx, signedIn);
          assert.equal(location.origin + location.pathname, redirectUri);
          assert(location.searchParams.get("code"));
          assert.equal(location.searchParams.get("state"), "bookkeeping-state");

          expect(await sessionUser(ctx, cookie)).toMatchObject({
            email: "ada@example.test",
            emailVerified: true,
          });
          // The code proved the address, so no verification email follows.
          await ctx.runtime.drain();
          // In the app's name, from Backoffice's sending address.
          expect(
            ctx.fakes.resend?.queueEmailCalls.map(({ input, options }) => [
              input.subject,
              options.senderName,
            ]),
          ).toEqual([[`Your Bookkeeping code: ${code}`, "Bookkeeping"]]);
        }),
        then.assert("an existing account signs in with a code as itself", async (ctx) => {
          const auth = ctx.runtime.objects.auth.singleton();
          const existing = await auth.commands.verifyAdminUserEmail({ email: "ada@example.test" });
          const signIn = await openSignIn(ctx, await registerApp(ctx, "ledger", "first-party"));
          await submit(ctx, signIn, { intent: "send_code", email: "ada@example.test" });
          const code = sentCodes(ctx, "ada@example.test").at(-1);
          assert(code);
          const signedIn = await submit(ctx, signIn, {
            intent: "verify_code",
            email: "ada@example.test",
            code,
          });
          assert(signedIn instanceof Response);
          const { cookie } = await followToApp(ctx, signedIn);
          assert.equal((await sessionUser(ctx, cookie)).id, existing.userId);
        }),
        then.assert("an expired or altered request explains itself", async (ctx) => {
          const signIn = await openSignIn(ctx, await registerApp(ctx, "altered", "first-party"));
          const altered = new URL(signIn);
          altered.searchParams.set("state", "someone-else");
          expect(
            await submit(ctx, altered, { intent: "send_code", email: "grace@example.test" }),
          ).toEqual({
            step: "method",
            email: "grace@example.test",
            error: "This sign-in page has expired. Go back to Bookkeeping and try again.",
          });
          expect(sentCodes(ctx, "grace@example.test")).toEqual([]);
        }),
      ],
    }),
  );
});

test("without email verification, a code sign-in keeps the account's password and sessions", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "code sign-in to a password account where email goes unverified",
      // As in local development, where every address counts as verified.
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_ACCESS_CODES_REQUIRED: "false" },
      fakes: ({ fake }) => ({ resend: fake.resend() }),
      vars: () => ({ passwordCookie: "" }),
      setup: ({ given }) => [given.auth.user({ id: "platform-admin", role: "admin" })],
      steps: ({ when, then }) => [
        when.auth.signUp({
          email: "ada@example.test",
          password: "password123",
          captureSessionCookieAs: "passwordCookie",
        }),
        then.assert("the code signs in the same account", async (ctx) => {
          const existing = await sessionUser(ctx, ctx.vars.passwordCookie);
          assert.isTrue(existing.emailVerified);
          const signIn = await openSignIn(
            ctx,
            await registerApp(ctx, "bookkeeping", "first-party"),
          );
          await submit(ctx, signIn, { intent: "send_code", email: "ada@example.test" });
          const [code] = sentCodes(ctx, "ada@example.test");
          assert(code);
          const signedIn = await submit(ctx, signIn, {
            intent: "verify_code",
            email: "ada@example.test",
            code,
          });
          assert(signedIn instanceof Response, JSON.stringify(signedIn));
          const { cookie } = await followToApp(ctx, signedIn);
          expect(await sessionUser(ctx, cookie)).toEqual({
            id: existing.id,
            email: "ada@example.test",
            emailVerified: true,
          });
        }),
        then.assert("the password and the earlier session still work", async (ctx) => {
          assert.equal((await sessionUser(ctx, ctx.vars.passwordCookie)).email, "ada@example.test");
          const passwordSignIn = await ctx.runtime.objects.auth.singleton().http.fetch(
            new Request(`${origin}/api/auth/sign-in/email`, {
              method: "POST",
              headers: { origin, "content-type": "application/json" },
              body: JSON.stringify({ email: "ada@example.test", password: "password123" }),
            }),
          );
          assert.equal(passwordSignIn.status, 200, await passwordSignIn.clone().text());
        }),
      ],
    }),
  );
});

test("after their email, everyone an app sends here may use a code or a password, and the page never tells which addresses have an account", async () => {
  const withPassword = "ada@example.test";
  const withoutPassword = "grace@example.test";
  const unknown = "nobody@example.test";
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "choose a code or a password on a first-party app's sign-in",
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_ACCESS_CODES_REQUIRED: "false" },
      fakes: ({ fake }) => ({ resend: fake.resend() }),
      vars: () => ({ signIn: "" }),
      setup: ({ given }) => [
        given.auth.user({ id: "platform-admin", role: "admin" }),
        given.auth.user({ id: "passwordless", email: withoutPassword }),
      ],
      steps: ({ when, then }) => [
        when.auth.signUp({ email: withPassword, password: "password123" }),
        then.assert("each address gets the same choice, and no email", async (ctx) => {
          const signIn = await openSignIn(
            ctx,
            await registerApp(ctx, "bookkeeping", "first-party"),
          );
          ctx.vars.signIn = signIn.href;
          for (const email of [withPassword, withoutPassword, unknown]) {
            expect(await submit(ctx, signIn, { intent: "choose_method", email })).toEqual({
              step: "method",
              email,
              error: null,
            });
          }
          await ctx.runtime.drain();
          expect(ctx.fakes.resend?.queueEmailCalls).toEqual([]);
        }),
        then.assert("a password that does not sign in reads the same for each", async (ctx) => {
          const signIn = new URL(ctx.vars.signIn);
          for (const email of [withPassword, withoutPassword, unknown]) {
            expect(
              await submit(ctx, signIn, {
                intent: "sign_in_password",
                email,
                password: "not-the-password",
              }),
            ).toEqual({
              step: "method",
              email,
              error: "That password isn't right. Try again, or sign in with a code instead.",
            });
          }
        }),
        then.assert("the right password returns to the app as that account", async (ctx) => {
          // Another visitor: the wrong passwords above used up the first one's sign-in attempts.
          const signedIn = await submit(
            ctx,
            new URL(ctx.vars.signIn),
            { intent: "sign_in_password", email: withPassword, password: "password123" },
            "198.51.100.7",
          );
          assert(signedIn instanceof Response, JSON.stringify(signedIn));
          const { location, cookie } = await followToApp(ctx, signedIn);
          assert.equal(location.origin + location.pathname, redirectUri);
          assert.equal(location.searchParams.get("state"), "bookkeeping-state");
          expect(await sessionUser(ctx, cookie)).toMatchObject({ email: withPassword });
        }),
      ],
    }),
  );
});

test("only a first-party app's request can ask for a sign-in code", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "email codes outside a first-party app",
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "true", SIGN_UP_ACCESS_CODES_REQUIRED: "true" },
      fakes: ({ fake }) => ({ resend: fake.resend() }),
      setup: ({ given }) => [given.auth.user({ id: "platform-admin", role: "admin" })],
      steps: ({ then }) => [
        then.assert("codes are only for first-party apps' requests", async (ctx) => {
          const signIn = await openSignIn(ctx, await registerApp(ctx, "outsider", "third-party"));
          const page = await loginLoader(routeArgs(ctx, new Request(signIn)));
          assert(!(page instanceof Response) && page.kind === "backoffice");

          const requestCode = async (body: Record<string, string>) =>
            await ctx.runtime.objects.auth.singleton().http.fetch(
              new Request(`${origin}/api/auth/email-otp/send-verification-otp`, {
                method: "POST",
                headers: { origin, "content-type": "application/json" },
                body: JSON.stringify({ email: "grace@example.test", type: "sign-in", ...body }),
              }),
            );
          assert.equal((await requestCode({ oauth_query: signIn.search.slice(1) })).status, 403);
          assert.equal((await requestCode({})).status, 403);
          expect(sentCodes(ctx, "grace@example.test")).toEqual([]);
        }),
      ],
    }),
  );
});

test("each visitor has their own limit on sign-in codes", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "sign-in code limits per visitor",
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "true", SIGN_UP_ACCESS_CODES_REQUIRED: "true" },
      fakes: ({ fake }) => ({ resend: fake.resend() }),
      setup: ({ given }) => [given.auth.user({ id: "platform-admin", role: "admin" })],
      steps: ({ then }) => [
        then.assert("one busy visitor waits, and others still get codes", async (ctx) => {
          const signIn = await openSignIn(
            ctx,
            await registerApp(ctx, "bookkeeping", "first-party"),
          );
          const busy = "203.0.113.20";
          for (const email of ["a@example.test", "b@example.test", "c@example.test"]) {
            expect(await submit(ctx, signIn, { intent: "send_code", email }, busy)).toMatchObject({
              step: "code",
              outcome: { kind: "sent" },
            });
          }
          expect(
            await submit(ctx, signIn, { intent: "send_code", email: "d@example.test" }, busy),
          ).toEqual({
            step: "method",
            email: "d@example.test",
            error: "Please wait a minute before trying again.",
          });
          expect(
            await submit(
              ctx,
              signIn,
              { intent: "send_code", email: "d@example.test" },
              "198.51.100.7",
            ),
          ).toMatchObject({ step: "code", outcome: { kind: "sent" } });
        }),
      ],
    }),
  );
});
