import { assert, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { decodeJwt } from "jose";

import type { InMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { verifyBackofficeJwt } from "@/fragno/auth/token-lifecycle";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

type AuthObject = ReturnType<InMemoryBackofficeRuntime["objects"]["auth"]["singleton"]>;

function requestOAuth(
  auth: AuthObject,
  url: string,
  body: URLSearchParams | { userCode: string } | null,
  cookie: string | null,
): Promise<Response> {
  return auth.http.fetch(
    new Request(url, {
      method: body === null ? "GET" : "POST",
      headers: {
        origin: new URL(url).origin,
        ...(cookie === null ? {} : { cookie }),
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

for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173"]) {
  test(`device authorization and token exchange preserve the selected origin ${origin}`, async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: `local OAuth device login through ${origin}`,
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false" },
        vars: () => ({ cookie: "" }),
        steps: ({ when, then }) => [
          when.auth.signUp({ email: "local-oauth@example.com", captureSessionCookieAs: "cookie" }),
          then.assert(
            "approved local device token exchanges without weakening audience verification",
            async ({ runtime, vars }) => {
              const auth = runtime.objects.auth.singleton();
              const config = await auth.commands.getBackofficeCliOAuthConfig({
                requestUrl: `${origin}/api/backoffice/cli-config`,
              });
              assert.equal(new URL(config.tokenEndpoint).origin, origin);
              const requested = await requestOAuth(
                auth,
                config.deviceAuthorizationEndpoint,
                new URLSearchParams({
                  client_id: config.clientId,
                  scope: config.scope,
                  resource: origin,
                }),
                null,
              );
              assert.equal(requested.status, 200, await requested.clone().text());
              const device = await requested.json<{
                device_code: string;
                user_code: string;
                verification_uri_complete: string;
              }>();
              assert.equal(new URL(device.verification_uri_complete).origin, origin);

              const claimUrl = new URL("/api/auth/device", device.verification_uri_complete);
              claimUrl.searchParams.set("user_code", device.user_code);
              const claimed = await requestOAuth(auth, claimUrl.toString(), null, vars.cookie);
              assert.equal(claimed.status, 200, await claimed.clone().text());
              const approved = await requestOAuth(
                auth,
                `${origin}/api/auth/device/approve`,
                { userCode: device.user_code },
                vars.cookie,
              );
              assert.equal(approved.status, 200, await approved.clone().text());
              const granted = await requestOAuth(
                auth,
                config.tokenEndpoint,
                new URLSearchParams({
                  grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                  device_code: device.device_code,
                  client_id: config.clientId,
                  resource: origin,
                }),
                null,
              );
              assert.equal(granted.status, 200, await granted.clone().text());
              const oauth = await granted.json<{ access_token: string }>();
              const claims = decodeJwt(oauth.access_token);
              assert.equal(claims.iss, origin);
              expect([claims.aud].flat()).toContain(origin);

              const token = await auth.commands.exchangeBackofficeExecutionToken({
                requestUrl: `${origin}/api/backoffice/execution-token`,
                oauthAccessToken: oauth.access_token,
                scope: null,
              });
              assert.equal(token.scope.kind, "org");
              const verified = await verifyBackofficeJwt(token.accessToken, origin, auth.http);
              assert(verified.ok);
              assert.equal(verified.payload.email, "local-oauth@example.com");

              const otherOrigin = origin.includes("localhost")
                ? "http://127.0.0.1:5173"
                : "http://localhost:5173";
              await expect(
                auth.commands.exchangeBackofficeExecutionToken({
                  requestUrl: `${otherOrigin}/api/backoffice/execution-token`,
                  oauthAccessToken: oauth.access_token,
                  scope: null,
                }),
              ).rejects.toMatchObject({ name: "BackofficeExecutionTokenAuthenticationError" });
            },
          ),
        ],
      }),
    );
  });
}
