import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

const oauthTestScopes = "openid profile email";
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  id_token: z.string().min(1),
  token_type: z.string().regex(/^Bearer$/i),
  expires_in: z.number().int().positive(),
  scope: z.string(),
});
const identitySchema = z.object({
  sub: z.string().min(1),
  name: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
});

async function readOAuthTestJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    // Provider responses can contain credentials; report status, not the response body.
    throw new Error(
      `OAuth test request to ${new URL(url).pathname} failed (HTTP ${response.status}).`,
    );
  }
  return await response.json();
}

function sendOAuthTestPage(response, status, title, details) {
  const escapedDetails = details.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>Backoffice OAuth test</title></head><body><h1>${title}</h1><pre>${escapedDetails}</pre><a href="/login">Start OAuth login</a></body></html>`,
  );
}

async function runOAuthClientTestServer() {
  const { values } = parseArgs({
    args: process.argv.slice(process.argv[2] === "--" ? 3 : 2),
    options: {
      "client-id": { type: "string" },
      "backoffice-url": { type: "string", default: "http://localhost:5173" },
      port: { type: "string", default: "8789" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node scripts/test-oauth-client.mjs --client-id <id> [--backoffice-url <origin>] [--port <port>]\n\nCallback: http://127.0.0.1:8789/callback (default port).\nUse a native authorization-code client with PKCE and openid/profile/email scopes.\nPublic clients need no secret. For client_secret_basic, set OAUTH_CLIENT_SECRET in the environment.",
    );
    return;
  }
  const config = z
    .object({
      clientId: z.string().min(1),
      backofficeUrl: z
        .url()
        .transform((value) => new URL(value))
        .refine(
          (url) =>
            url.pathname === "/" &&
            !url.search &&
            !url.hash &&
            !url.username &&
            !url.password &&
            (url.protocol === "https:" ||
              (url.protocol === "http:" &&
                (url.hostname === "localhost" ||
                  url.hostname.endsWith(".localhost") ||
                  url.hostname === "127.0.0.1" ||
                  url.hostname === "[::1]"))),
          "Use an HTTPS Backoffice origin or HTTP loopback development origin.",
        ),
      port: z.coerce.number().int().min(1).max(65535),
      clientSecret: z.string().min(1).nullable(),
    })
    .parse({
      clientId: values["client-id"],
      backofficeUrl: values["backoffice-url"],
      port: values.port,
      clientSecret: process.env.OAUTH_CLIENT_SECRET ?? null,
    });
  // Backoffice's JWT plugin uses the origin as issuer; root discovery is not mounted yet.
  const issuer = config.backofficeUrl.origin;
  const authApiBase = new URL("/api/auth/", config.backofficeUrl);
  const jwks = createRemoteJWKSet(new URL("jwks", authApiBase));
  const origin = `http://127.0.0.1:${config.port}`;
  const redirectUri = `${origin}/callback`;
  const cookieName = `backoffice_oauth_test_${config.port}`;
  const pendingLogins = new Map();
  const server = createServer(function dispatchOAuthTestRequest(request, response) {
    void handleOAuthTestRequest(request, response);
  });
  async function handleOAuthTestRequest(request, response) {
    try {
      if (request.headers.host !== new URL(origin).host) {
        sendOAuthTestPage(response, 421, "Unexpected host", `Open ${origin} instead.`);
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET" });
        response.end();
        return;
      }
      const url = new URL(request.url, origin);
      if (url.pathname === "/") {
        sendOAuthTestPage(
          response,
          200,
          "Backoffice OAuth client test",
          `Backoffice: ${config.backofficeUrl.origin}\nClient ID: ${config.clientId}\nRedirect URI: ${redirectUri}\nScopes: ${oauthTestScopes}\nClient authentication: ${config.clientSecret === null ? "none (public)" : "client_secret_basic"}\n\nUse the same Backoffice origin as your browser session.\nBackoffice will ask you to sign in and review the requested scopes. Approve only if you started this login.`,
        );
        return;
      }
      if (url.pathname === "/login") {
        for (const [state, pending] of pendingLogins) {
          if (pending.expiresAt <= Date.now()) {
            pendingLogins.delete(state);
          }
        }
        const state = randomBytes(32).toString("base64url");
        const nonce = randomBytes(32).toString("base64url");
        const codeVerifier = randomBytes(32).toString("base64url");
        pendingLogins.set(state, { nonce, codeVerifier, expiresAt: Date.now() + 10 * 60_000 });
        const authorize = new URL("oauth2/authorize", authApiBase);
        authorize.search = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: oauthTestScopes,
          state,
          nonce,
          code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
          code_challenge_method: "S256",
          prompt: "consent",
        }).toString();
        response.writeHead(302, {
          location: authorize.toString(),
          "cache-control": "no-store",
          "set-cookie": `${cookieName}=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
        });
        response.end();
        return;
      }
      if (url.pathname !== "/callback") {
        response.writeHead(404);
        response.end();
        return;
      }
      const state = url.searchParams.get("state");
      const pending = pendingLogins.get(state);
      const browserState = (request.headers.cookie ?? "")
        .split(";")
        .map((cookie) => cookie.trim())
        .find((cookie) => cookie.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1);
      if (!pending || pending.expiresAt <= Date.now() || browserState !== state) {
        throw new Error(
          "OAuth test callback state is missing, expired, or does not match this browser.",
        );
      }
      pendingLogins.delete(state);
      response.setHeader("set-cookie", `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
      if (url.searchParams.has("error")) {
        throw new Error("OAuth test authorization was denied or failed.");
      }
      const code = z.string().min(1).parse(url.searchParams.get("code"));
      if (url.searchParams.get("iss") !== issuer) {
        throw new Error("OAuth test callback issuer does not match Backoffice.");
      }
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        redirect_uri: redirectUri,
        code,
        code_verifier: pending.codeVerifier,
      });
      const headers = { "content-type": "application/x-www-form-urlencoded" };
      if (config.clientSecret !== null) {
        const encodedId = new URLSearchParams({ id: config.clientId }).toString().slice(3);
        const encodedSecret = new URLSearchParams({ secret: config.clientSecret })
          .toString()
          .slice(7);
        headers.authorization = `Basic ${Buffer.from(`${encodedId}:${encodedSecret}`).toString("base64")}`;
      }
      const tokens = tokenResponseSchema.parse(
        await readOAuthTestJson(new URL("oauth2/token", authApiBase), {
          method: "POST",
          headers,
          body,
        }),
      );
      const { payload } = await jwtVerify(tokens.id_token, jwks, {
        issuer,
        audience: config.clientId,
        requiredClaims: ["sub", "exp", "iat", "nonce"],
      });
      const claims = z
        .object({ sub: z.string().min(1), nonce: z.string(), aud: z.literal(config.clientId) })
        .parse(payload);
      if (claims.nonce !== pending.nonce) {
        throw new Error("OAuth test ID token nonce does not match the login attempt.");
      }
      const identity = identitySchema.parse(
        await readOAuthTestJson(new URL("oauth2/userinfo", authApiBase), {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        }),
      );
      if (identity.sub !== claims.sub) {
        throw new Error("OAuth test userinfo subject does not match the verified ID token.");
      }
      sendOAuthTestPage(
        response,
        200,
        "OAuth login succeeded",
        `PKCE code exchange, ID token signature/issuer/audience/expiry/nonce, and userinfo subject verified.\n\nUser info:\n${JSON.stringify(identity, null, 2)}\n\nGranted scopes: ${tokens.scope}\nAccess token expires in: ${tokens.expires_in} seconds\n\nCredentials are not displayed or persisted. This does not grant Backoffice execution access.`,
      );
      console.log(
        "OAuth login succeeded; ID token and userinfo verified. Credentials were not logged.",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown OAuth test error.";
      sendOAuthTestPage(response, 400, "OAuth login failed", message);
      console.error(`OAuth test failed: ${message}`);
    }
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", resolve);
  });
  console.log(
    `OAuth client test server: ${origin}\nRegister redirect URI: ${redirectUri}\nOpen the test server in your browser. Ctrl+C stops it.`,
  );
}

try {
  await runOAuthClientTestServer();
} catch (error) {
  console.error(
    `OAuth test startup failed: ${error instanceof Error ? error.message : "Unknown error."}`,
  );
  process.exitCode = 1;
}
