import { assert, expect, test, vi } from "vitest";

import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { oauthConsentPageSchema } from "@fragno-dev/backoffice-api/v0/account";
import { decodeJwt } from "jose";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { z } from "zod";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { backofficeExecutionTokenResultSchema } from "@/fragno/auth/execution-token";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { action as executionTokenAction } from "../api/backoffice-execution-token";
import AuthorizedApplications, {
  loader as applicationsLoader,
  action as revokeAction,
} from "./authorized-applications";
import DeviceScreen, { loader as deviceLoader, action as deviceAction } from "./device";
import { action as loginAction, loader as loginLoader } from "./login";
import ConsentScreen, { loader, action } from "./oauth-consent";

const origin = "https://backoffice.example";

function routeArgs(ctx: BackofficeScenarioContext, request: Request) {
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
  };
}

function authRequest(
  ctx: BackofficeScenarioContext,
  pathname: string,
  cookie: string,
  body: Record<string, unknown> | URLSearchParams | null = null,
  requestOrigin = origin,
) {
  return ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${requestOrigin}/api/auth${pathname}`, {
      method: body === null ? "GET" : "POST",
      headers: {
        cookie,
        origin: requestOrigin,
        accept: "text/html",
        ...(body === null
          ? {}
          : {
              "content-type":
                body instanceof URLSearchParams
                  ? "application/x-www-form-urlencoded"
                  : "application/json",
            }),
      },
      body:
        body === null ? undefined : body instanceof URLSearchParams ? body : JSON.stringify(body),
    }),
  );
}

async function createClient(ctx: BackofficeScenarioContext) {
  assert(typeof ctx.vars.session === "string");
  const session = await authRequest(ctx, "/get-session", ctx.vars.session);
  const user = z.object({ user: z.object({ id: z.string() }) }).parse(await session.json()).user;
  await ctx.runtime.objects.auth
    .singleton()
    .commands.grantBackofficeAdminByEmail({ email: "consent-owner@example.test" });
  return await ctx.runtime.objects.auth.singleton().commands.createAdminOAuthClient({
    name: "Consent Scenario Client",
    applicationType: "native",
    clientType: "public",
    redirectUris: ["http://127.0.0.1:8789/callback"],
    scopes: ["openid", "profile", "email", "offline_access"],
    administratorUserId: user.id,
  });
}

async function consentRequest(
  ctx: BackofficeScenarioContext,
  clientId: string,
  cookie: string,
  scope = "openid profile email offline_access",
  claimsRequest: string | null = null,
  requestOrigin = origin,
) {
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:8789/callback",
    response_type: "code",
    scope,
    state: "scenario-browser-state",
    nonce: "scenario-login-nonce",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    prompt: "consent",
  });
  if (claimsRequest !== null) {
    query.set("claims", claimsRequest);
  }
  const authorization = await authRequest(
    ctx,
    `/oauth2/authorize?${query}`,
    cookie,
    null,
    requestOrigin,
  );
  assert.equal(authorization.status, 302, await authorization.clone().text());
  const location = authorization.headers.get("location");
  assert(location);
  return { url: new URL(location, requestOrigin), verifier };
}

async function approveConsent(ctx: BackofficeScenarioContext, url: URL, cookie: string) {
  const approved = await action(
    routeArgs(
      ctx,
      new Request(url, {
        method: "POST",
        headers: { cookie, origin: url.origin },
        body: new URLSearchParams({ intent: "approve" }),
      }),
    ),
  );
  assert(approved instanceof Response, JSON.stringify(approved));
  assert.equal(approved.status, 302);
  const callback = approved.headers.get("location");
  assert(callback);
  const code = new URL(callback).searchParams.get("code");
  assert(code);
  return code;
}

async function exchangeCode(
  ctx: BackofficeScenarioContext,
  clientId: string,
  code: string,
  verifier: string,
  requestOrigin = origin,
) {
  return await authRequest(
    ctx,
    "/oauth2/token",
    "",
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: "http://127.0.0.1:8789/callback",
    }),
    requestOrigin,
  );
}

async function runConsentScenario(check: (ctx: BackofficeScenarioContext) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-consent-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "OAuth consent lifecycle",
        options: { sqliteDataDirectory: directory },
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_INVITATIONS_ENABLED: "false" },
        vars: () => ({ session: "", otherSession: "" }),
        steps: ({ when, then }) => [
          when.auth.signUp({
            email: "consent-owner@example.test",
            captureSessionCookieAs: "session",
          }),
          when.auth.signUp({
            email: "other-user@example.test",
            captureSessionCookieAs: "otherSession",
          }),
          then.assert("consent state reflects real approval and revocation", check),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function sessionCookies(response: Response) {
  return response.headers
    .getSetCookie()
    .filter((cookie) => !cookie.includes("Max-Age=0"))
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

function renderConsentScreen(consent: Parameters<typeof ConsentScreen>[0]["loaderData"]) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: <ConsentScreen loaderData={consent} actionData={undefined} />,
    },
  ]);
  try {
    return renderToStaticMarkup(<RouterProvider router={router} />);
  } finally {
    router.dispose();
  }
}

function renderApplications(page: Parameters<typeof AuthorizedApplications>[0]["loaderData"]) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: <AuthorizedApplications loaderData={page} actionData={undefined} />,
    },
  ]);
  try {
    return renderToStaticMarkup(<RouterProvider router={router} />);
  } finally {
    router.dispose();
  }
}

test("native consent review, approval, owned listing, opaque/refresh revocation and reauthorization use the real routes", async () => {
  await runConsentScenario(async (ctx) => {
    const client = await createClient(ctx);
    const cookie = String(ctx.vars.otherSession);
    const login = await consentRequest(ctx, client.clientId, cookie);
    const review = await loader(routeArgs(ctx, new Request(login.url, { headers: { cookie } })));
    expect(review.data).toMatchObject({
      clientId: client.clientId,
      clientName: "Consent Scenario Client",
      userEmail: "other-user@example.test",
      scopes: ["openid", "profile", "email", "offline_access"],
    });
    const html = renderConsentScreen(review.data);
    expect(html).toContain("Approve");
    expect(html).toContain("Deny");
    expect(html).toContain("does not install an app");
    const code = await approveConsent(ctx, login.url, cookie);
    const exchanged = await exchangeCode(ctx, client.clientId, code, login.verifier);
    assert(exchanged.ok, await exchanged.clone().text());
    const tokens = z
      .object({ access_token: z.string(), refresh_token: z.string() })
      .parse(await exchanged.json());
    const appsUrl = `${origin}/backoffice/settings/authorized-applications`;
    const listed = await applicationsLoader(
      routeArgs(ctx, new Request(appsUrl, { headers: { cookie } })),
    );
    expect(listed.data.consents).toHaveLength(1);
    expect(listed.data.consents[0]).toMatchObject({
      clientId: client.clientId,
      clientName: "Consent Scenario Client",
    });
    expect(renderApplications(listed.data)).toContain("Revoke access");
    const serialized = JSON.stringify(listed.data);
    expect(serialized).not.toContain(tokens.access_token);
    expect(serialized).not.toContain(tokens.refresh_token);
    const owner = await applicationsLoader(
      routeArgs(ctx, new Request(appsUrl, { headers: { cookie: String(ctx.vars.session) } })),
    );
    expect(owner.data.consents).toEqual([]);
    // The publisher cannot revoke a different user's authorization to its own client.
    await revokeAction(
      routeArgs(
        ctx,
        new Request(appsUrl, {
          method: "POST",
          headers: { cookie: String(ctx.vars.session), origin },
          body: new URLSearchParams({ clientId: client.clientId }),
        }),
      ),
    );
    const retained = await applicationsLoader(
      routeArgs(ctx, new Request(appsUrl, { headers: { cookie } })),
    );
    expect(retained.data.consents).toHaveLength(1);
    const revoked = await revokeAction(
      routeArgs(
        ctx,
        new Request(appsUrl, {
          method: "POST",
          headers: { cookie, origin },
          body: new URLSearchParams({ clientId: client.clientId }),
        }),
      ),
    );
    assert(revoked instanceof Response);
    assert.equal(revoked.status, 302);
    const empty = await applicationsLoader(
      routeArgs(ctx, new Request(appsUrl, { headers: { cookie } })),
    );
    expect(empty.data.consents).toEqual([]);
    expect(renderApplications(empty.data)).toContain("no authorized applications");
    const refresh = await authRequest(
      ctx,
      "/oauth2/token",
      "",
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: tokens.refresh_token,
      }),
    );
    assert.equal(refresh.ok, false);
    const userinfo = await ctx.runtime.objects.auth.singleton().http.fetch(
      new Request(`${origin}/api/auth/oauth2/userinfo`, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      }),
    );
    assert.equal(userinfo.ok, false);
    const pendingLogin = await consentRequest(
      ctx,
      client.clientId,
      cookie,
      "profile email offline_access",
    );
    const pendingCode = await approveConsent(ctx, pendingLogin.url, cookie);
    const cancelled = await authRequest(ctx, "/backoffice/oauth/revoke-consent", cookie, {
      clientId: client.clientId,
    });
    assert(cancelled.ok);
    const lateExchange = await exchangeCode(
      ctx,
      client.clientId,
      pendingCode,
      pendingLogin.verifier,
    );
    assert.equal(lateExchange.ok, false);
    const anotherLogin = await consentRequest(ctx, client.clientId, cookie);
    const newCode = await approveConsent(ctx, anotherLogin.url, cookie);
    const resumed = await exchangeCode(ctx, client.clientId, newCode, anotherLogin.verifier);
    assert(resumed.ok, await resumed.clone().text());
  });
});

test("additional OIDC claims are disclosed, listed and constrained by the current consent", async () => {
  await runConsentScenario(async (ctx) => {
    const client = await createClient(ctx);
    const cookie = String(ctx.vars.otherSession);
    const claimsRequest = JSON.stringify({ userinfo: { email: null } });
    const login = await consentRequest(ctx, client.clientId, cookie, "openid", claimsRequest);
    const review = await loader(routeArgs(ctx, new Request(login.url, { headers: { cookie } })));
    assert.equal(review.data.claimsRequest, claimsRequest);
    expect(renderConsentScreen(review.data)).toContain("Additional OIDC claims request");
    const code = await approveConsent(ctx, login.url, cookie);
    const exchanged = await exchangeCode(ctx, client.clientId, code, login.verifier);
    assert(exchanged.ok, await exchanged.clone().text());
    const token = z.object({ access_token: z.string() }).parse(await exchanged.json()).access_token;
    function readAuthorizedUserInfo() {
      return ctx.runtime.objects.auth.singleton().http.fetch(
        new Request(`${origin}/api/auth/oauth2/userinfo`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
    }
    const userinfo = await readAuthorizedUserInfo();
    assert(userinfo.ok, await userinfo.clone().text());
    const identity = z.object({ email: z.email() }).parse(await userinfo.json());
    assert.equal(identity.email, "other-user@example.test");
    const listed = await applicationsLoader(
      routeArgs(
        ctx,
        new Request(`${origin}/backoffice/settings/authorized-applications`, {
          headers: { cookie },
        }),
      ),
    );
    expect(listed.data.consents[0].requestedUserInfoClaims).toEqual(["email"]);
    expect(renderApplications(listed.data)).toContain("Additional userinfo claims");
    const reduced = await consentRequest(ctx, client.clientId, cookie, "openid");
    await approveConsent(ctx, reduced.url, cookie);
    // Scopes are unchanged, but an old token cannot disclose a claim no longer consented to.
    const withheld = await readAuthorizedUserInfo();
    assert.equal(withheld.ok, false);
  });
});

test("denial returns access_denied without creating consent; altered signed queries and cross-origin approval are rejected", async () => {
  await runConsentScenario(async (ctx) => {
    const client = await createClient(ctx);
    const cookie = String(ctx.vars.otherSession);
    const login = await consentRequest(ctx, client.clientId, cookie);
    for (const [key, value] of [
      ["scope", "openid backoffice"],
      ["redirect_uri", "https://attacker.example/callback"],
      ["client_id", "forged-client"],
      ["sig", "forged-signature"],
      ["exp", "1"],
    ]) {
      const invalid = new URL(login.url);
      invalid.searchParams.set(key, value);
      await expect(
        loader(routeArgs(ctx, new Request(invalid, { headers: { cookie } }))),
      ).rejects.toMatchObject({ status: 400 });
    }
    const crossOrigin = await action(
      routeArgs(
        ctx,
        new Request(login.url, {
          method: "POST",
          headers: { cookie, origin: "https://attacker.example" },
          body: new URLSearchParams({ intent: "approve" }),
        }),
      ),
    );
    assert(!(crossOrigin instanceof Response));
    assert.equal(crossOrigin.init?.status, 403);
    const denied = await action(
      routeArgs(
        ctx,
        new Request(login.url, {
          method: "POST",
          headers: { cookie, origin },
          body: new URLSearchParams({ intent: "deny" }),
        }),
      ),
    );
    assert(denied instanceof Response);
    const location = denied.headers.get("location");
    assert(location);
    assert.equal(new URL(location).searchParams.get("error"), "access_denied");
    const list = await authRequest(ctx, "/backoffice/oauth/consents", cookie);
    expect(oauthConsentPageSchema.parse(await list.json()).consents).toEqual([]);
  });
});

test("signed-out OAuth login resumes the original request through password login and presents consent", async () => {
  await runConsentScenario(async (ctx) => {
    const client = await createClient(ctx);
    const started = await consentRequest(ctx, client.clientId, "");
    assert.equal(started.url.pathname, "/backoffice/login");
    const request = new Request(started.url);
    const page = await loginLoader(routeArgs(ctx, request));
    assert(!(page instanceof Response));
    expect(page.oauthQuery).not.toBeNull();
    const signedIn = await loginAction(
      routeArgs(
        ctx,
        new Request(started.url, {
          method: "POST",
          headers: { origin },
          body: new URLSearchParams({
            intent: "sign_in",
            email: "other-user@example.test",
            password: "password123",
          }),
        }),
      ),
    );
    assert(signedIn instanceof Response, JSON.stringify(signedIn));
    const location = signedIn.headers.get("location");
    assert(location);
    const consentUrl = new URL(location, origin);
    assert.equal(consentUrl.pathname, "/backoffice/oauth/consent");
    const cookie = sessionCookies(signedIn);
    const consent = await loader(routeArgs(ctx, new Request(consentUrl, { headers: { cookie } })));
    assert.equal(consent.data.clientId, client.clientId);
    const code = await approveConsent(ctx, consentUrl, cookie);
    assert((await exchangeCode(ctx, client.clientId, code, started.verifier)).ok);
  });
});

test.each(["http://localhost:5173", "http://127.0.0.1:5173"])(
  "device and native login preserve %s throughout approval, issuance, refresh and execution",
  async (requestOrigin) => {
    await runConsentScenario(async (ctx) => {
      const cookie = String(ctx.vars.session);
      const auth = ctx.runtime.objects.auth.singleton();
      const config = await auth.commands.getBackofficeCliOAuthConfig({ requestUrl: requestOrigin });
      const requested = await authRequest(
        ctx,
        "/device/code",
        "",
        new URLSearchParams({
          client_id: config.clientId,
          scope: config.scope,
          resource: requestOrigin,
        }),
        requestOrigin,
      );
      assert(requested.ok, await requested.clone().text());
      const device = z
        .object({
          device_code: z.string(),
          user_code: z.string(),
          verification_uri_complete: z.string(),
        })
        .parse(await requested.json());
      const deviceUrl = new URL(device.verification_uri_complete);
      assert.equal(deviceUrl.origin, requestOrigin);
      const review = await deviceLoader(
        routeArgs(ctx, new Request(deviceUrl, { headers: { cookie } })),
      );
      const approved = await deviceAction(
        routeArgs(
          ctx,
          new Request(deviceUrl, {
            method: "POST",
            headers: { cookie, origin: requestOrigin },
            body: new URLSearchParams({ intent: "approve" }),
          }),
        ),
      );
      expect(approved).toMatchObject({ status: "approved" });
      const router = createMemoryRouter([{ id: "device", path: "/", element: <DeviceScreen /> }], {
        hydrationData: { loaderData: { device: review }, actionData: { device: approved } },
      });
      try {
        const html = renderToStaticMarkup(<RouterProvider router={router} />);
        expect(html).toContain('href="/backoffice"');
        expect(html).toContain("Go to dashboard");
        expect(html).toContain('href="/backoffice/settings/authorized-applications"');
      } finally {
        router.dispose();
      }
      const issued = await authRequest(
        ctx,
        "/oauth2/token",
        "",
        new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code,
          client_id: config.clientId,
          resource: requestOrigin,
        }),
        requestOrigin,
      );
      assert(issued.ok, await issued.clone().text());
      const tokens = z
        .object({ access_token: z.string(), refresh_token: z.string() })
        .parse(await issued.json());
      assert.equal(decodeJwt(tokens.access_token).iss, requestOrigin);
      const audience = decodeJwt(tokens.access_token).aud;
      assert(
        Array.isArray(audience) ? audience.includes(requestOrigin) : audience === requestOrigin,
      );
      async function exchangeExecution(accessToken: string) {
        return await executionTokenAction(
          routeArgs(
            ctx,
            new Request(`${requestOrigin}/api/backoffice/execution-token`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${accessToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ scope: null }),
            }),
          ),
        );
      }
      const execution = await exchangeExecution(tokens.access_token);
      assert.equal(execution.status, 200, await execution.clone().text());
      const grant = backofficeExecutionTokenResultSchema.parse(await execution.json());
      assert.equal(grant.scope.kind, "org");
      const refreshed = await authRequest(
        ctx,
        "/oauth2/token",
        "",
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: config.clientId,
          refresh_token: tokens.refresh_token,
          resource: requestOrigin,
        }),
        requestOrigin,
      );
      assert(refreshed.ok, await refreshed.clone().text());
      const refreshedToken = z
        .object({ access_token: z.string() })
        .parse(await refreshed.json()).access_token;
      assert.equal(decodeJwt(refreshedToken).iss, requestOrigin);
      const refreshedExecution = await exchangeExecution(refreshedToken);
      assert.equal(refreshedExecution.status, 200, await refreshedExecution.clone().text());
      const client = await createClient(ctx);
      const login = await consentRequest(
        ctx,
        client.clientId,
        cookie,
        "openid profile email",
        null,
        requestOrigin,
      );
      const nativeReview = await loader(
        routeArgs(ctx, new Request(login.url, { headers: { cookie } })),
      );
      expect(renderConsentScreen(nativeReview.data)).toContain(
        'href="/backoffice/settings/authorized-applications"',
      );
      const rejected = await action(
        routeArgs(
          ctx,
          new Request(login.url, {
            method: "POST",
            headers: {
              cookie,
              origin:
                requestOrigin === "http://localhost:5173"
                  ? "http://127.0.0.1:5173"
                  : "http://localhost:5173",
            },
            body: new URLSearchParams({ intent: "approve" }),
          }),
        ),
      );
      expect(rejected).toMatchObject({
        data: { message: "OAuth approval and revocation require a same-origin request." },
        init: { status: 403 },
      });
      const code = await approveConsent(ctx, login.url, cookie);
      const nativeTokens = await exchangeCode(
        ctx,
        client.clientId,
        code,
        login.verifier,
        requestOrigin,
      );
      assert(nativeTokens.ok, await nativeTokens.clone().text());
      const idToken = z.object({ id_token: z.string() }).parse(await nativeTokens.json()).id_token;
      assert.equal(decodeJwt(idToken).iss, requestOrigin);
      const revoked = await authRequest(
        ctx,
        "/backoffice/oauth/revoke-consent",
        cookie,
        { clientId: config.clientId },
        requestOrigin,
      );
      assert(revoked.ok, await revoked.clone().text());
      const forbidden = await exchangeExecution(refreshedToken);
      assert.equal(forbidden.status, 401);
      assert.equal(
        z.object({ message: z.string() }).parse(await forbidden.json()).message,
        "Backoffice execution OAuth consent is missing or has been revoked.",
      );
    });
  },
);

test("device consent is listed and revocation prevents refresh, pending redemption and new execution tokens", async () => {
  await runConsentScenario(async (ctx) => {
    const cookie = String(ctx.vars.session);
    const auth = ctx.runtime.objects.auth.singleton();
    const config = await auth.commands.getBackofficeCliOAuthConfig({ requestUrl: origin });
    const requested = await authRequest(
      ctx,
      "/device/code",
      "",
      new URLSearchParams({ client_id: config.clientId, scope: config.scope, resource: origin }),
    );
    const device = z
      .object({ device_code: z.string(), user_code: z.string() })
      .parse(await requested.json());
    const url = new URL(`/backoffice/device?user_code=${device.user_code}`, origin);
    const review = await deviceLoader(routeArgs(ctx, new Request(url, { headers: { cookie } })));
    assert.equal(review.clientName, "Fragno Backoffice Codemode");
    const approved = await deviceAction(
      routeArgs(
        ctx,
        new Request(url, {
          method: "POST",
          headers: { cookie, origin },
          body: new URLSearchParams({ intent: "approve" }),
        }),
      ),
    );
    expect(approved).toMatchObject({ status: "approved" });
    const issued = await authRequest(
      ctx,
      "/oauth2/token",
      "",
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: config.clientId,
        resource: origin,
      }),
    );
    assert(issued.ok, await issued.clone().text());
    const tokens = z
      .object({ access_token: z.string(), refresh_token: z.string() })
      .parse(await issued.json());
    const execution = await auth.commands.exchangeBackofficeExecutionToken({
      requestUrl: origin,
      oauthAccessToken: tokens.access_token,
      scope: null,
    });
    expect(execution.accessToken).toBeTruthy();
    const list = await authRequest(ctx, "/backoffice/oauth/consents", cookie);
    const consent = oauthConsentPageSchema.parse(await list.json()).consents;
    expect(consent).toHaveLength(1);
    expect(consent[0]).toMatchObject({
      clientId: config.clientId,
      clientName: "Fragno Backoffice Codemode",
    });
    const pending = z.object({ device_code: z.string(), user_code: z.string() }).parse(
      await (
        await authRequest(
          ctx,
          "/device/code",
          "",
          new URLSearchParams({
            client_id: config.clientId,
            scope: config.scope,
            resource: origin,
          }),
        )
      ).json(),
    );
    const pendingUrl = new URL(`/backoffice/device?user_code=${pending.user_code}`, origin);
    await deviceLoader(routeArgs(ctx, new Request(pendingUrl, { headers: { cookie } })));
    await deviceAction(
      routeArgs(
        ctx,
        new Request(pendingUrl, {
          method: "POST",
          headers: { cookie, origin },
          body: new URLSearchParams({ intent: "approve" }),
        }),
      ),
    );
    const revoked = await authRequest(ctx, "/backoffice/oauth/revoke-consent", cookie, {
      clientId: config.clientId,
    });
    assert(revoked.ok);
    await expect(
      auth.commands.exchangeBackofficeExecutionToken({
        requestUrl: origin,
        oauthAccessToken: tokens.access_token,
        scope: null,
      }),
    ).rejects.toMatchObject({ name: "BackofficeExecutionTokenAuthenticationError" });
    assert(
      !(
        await authRequest(
          ctx,
          "/oauth2/token",
          "",
          new URLSearchParams({
            grant_type: "refresh_token",
            client_id: config.clientId,
            refresh_token: tokens.refresh_token,
          }),
        )
      ).ok,
    );
    assert(
      !(
        await authRequest(
          ctx,
          "/oauth2/token",
          "",
          new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: config.clientId,
            device_code: pending.device_code,
          }),
        )
      ).ok,
    );
  });
});

test("consent paging is user-bound, rejects forged ownership and survives Auth restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-consent-page-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "persisted OAuth consents",
        options: { sqliteDataDirectory: directory },
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_INVITATIONS_ENABLED: "false" },
        vars: () => ({ session: "", otherSession: "", cursor: "" }),
        steps: ({ when, then, runner }) => [
          when.auth.signUp({
            email: "consent-owner@example.test",
            captureSessionCookieAs: "session",
          }),
          when.auth.signUp({
            email: "other-user@example.test",
            captureSessionCookieAs: "otherSession",
          }),
          then.assert("approve two clients and capture bounded page", async (ctx) => {
            const cookie = ctx.vars.otherSession;
            for (let i = 0; i < 2; i++) {
              const client = await createClient(ctx);
              const login = await consentRequest(ctx, client.clientId, cookie);
              await approveConsent(ctx, login.url, cookie);
            }
            const first = await authRequest(ctx, "/backoffice/oauth/consents?pageSize=1", cookie);
            const page = oauthConsentPageSchema.parse(await first.json());
            expect(page.consents).toHaveLength(1);
            assert(page.nextCursor);
            ctx.vars.cursor = page.nextCursor;
            for (const [path, owner] of [
              [
                `/backoffice/oauth/consents?pageSize=2&cursor=${encodeURIComponent(page.nextCursor)}`,
                cookie,
              ],
              [
                `/backoffice/oauth/consents?pageSize=1&cursor=${encodeURIComponent(page.nextCursor)}`,
                ctx.vars.session,
              ],
              ["/backoffice/oauth/consents?cursor=invalid", cookie],
            ]) {
              assert((await authRequest(ctx, path, owner)).status === 400);
            }
            const forged = await authRequest(ctx, "/backoffice/oauth/revoke-consent", cookie, {
              clientId: page.consents[0].clientId,
              userId: "forged-owner",
            });
            assert(forged.status === 400);
            assert((await authRequest(ctx, "/backoffice/oauth/consents", "")).status === 401);
          }),
          runner.restartObject({ binding: "AUTH", scope: { kind: "singleton" } }),
          then.assert("remaining page persists", async (ctx) => {
            const response = await authRequest(
              ctx,
              `/backoffice/oauth/consents?pageSize=1&cursor=${encodeURIComponent(ctx.vars.cursor)}`,
              ctx.vars.otherSession,
            );
            const page = oauthConsentPageSchema.parse(await response.json());
            expect(page.consents).toHaveLength(1);
            expect(page.nextCursor).toBeNull();
          }),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
