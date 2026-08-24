#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const ports = [5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180];
const configuredBaseUrl = process.env.BACKOFFICE_URL?.replace(/\/$/, "") ?? null;
const authFile = resolveAuthFile();
const oauthDeviceCodeGrantType = "urn:ietf:params:oauth:grant-type:device_code";
const credentialRefreshLeewayMs = 30_000;

class BackofficeTokenExchangeError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "BackofficeTokenExchangeError";
    this.status = status;
  }
}

function resolveAuthFile() {
  const configured = process.env.BACKOFFICE_CODEMODE_AUTH_FILE?.trim();
  if (configured) {
    return resolve(
      configured.startsWith("~/") ? `${homedir()}/${configured.slice(2)}` : configured,
    );
  }
  const stateHome = process.env.XDG_STATE_HOME?.trim() || resolve(homedir(), ".local/state");
  return resolve(stateHome, "fragno/backoffice-codemode/auth.json");
}

function usage() {
  console.error(`Usage:
  codemode.mjs login [--open] [--base-url URL]
  codemode.mjs probe [--base-url URL]
  codemode.mjs doctor [--base-url URL]
  codemode.mjs system [scope] [outputFile] [--base-url URL]
    Fetch rendered SYSTEM.md. If scope is omitted, uses the active or first organization.
  codemode.mjs exec <scope> (--file file.js | - | "async () => { ... }") [--timeout ms] [--base-url URL]
  codemode.mjs bash <scope> (--file script.sh | - | "ls -la") [--cwd path] [--timeout ms] [--base-url URL]

Scopes:
  system | org:<orgId> | project:<orgId>:<projectId> | user:<userId>

Canonical bootstrap:
  codemode.mjs login
    Requests an OAuth device code, waits for browser approval, exchanges the OAuth credential for
    a Backoffice scope token, and prints the authenticated user and organizations.
`);
  process.exit(1);
}

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

function getFlag(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    usage();
  }
  args.splice(index, 2);
  return value;
}

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return false;
  }
  args.splice(index, 1);
  return true;
}

function isBackofficeScope(value) {
  if (!value || typeof value !== "object" || typeof value.kind !== "string") {
    return false;
  }
  if (value.kind === "system") {
    return true;
  }
  if (value.kind === "org") {
    return typeof value.orgId === "string" && value.orgId.length > 0;
  }
  if (value.kind === "user") {
    return typeof value.userId === "string" && value.userId.length > 0;
  }
  return (
    value.kind === "project" &&
    typeof value.orgId === "string" &&
    value.orgId.length > 0 &&
    typeof value.projectId === "string" &&
    value.projectId.length > 0
  );
}

function backofficeScopesEqual(left, right) {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "system") {
    return true;
  }
  if (left.kind === "org") {
    return left.orgId === right.orgId;
  }
  if (left.kind === "user") {
    return left.userId === right.userId;
  }
  return left.orgId === right.orgId && left.projectId === right.projectId;
}

function decodeScopeComponent(value, label) {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded) {
      throw new Error(`Missing ${label}.`);
    }
    return decoded;
  } catch (error) {
    throw new Error(`Invalid Backoffice scope ${label}: ${error.message}`, { cause: error });
  }
}

function parseBackofficeScope(segment) {
  const parts = segment.split(":");
  if (parts[0] === "system" && parts.length === 1) {
    return { kind: "system" };
  }
  if (parts[0] === "org" && parts.length === 2) {
    return { kind: "org", orgId: decodeScopeComponent(parts[1], "organization id") };
  }
  if (parts[0] === "user" && parts.length === 2) {
    return { kind: "user", userId: decodeScopeComponent(parts[1], "user id") };
  }
  if (parts[0] === "project" && parts.length === 3) {
    return {
      kind: "project",
      orgId: decodeScopeComponent(parts[1], "organization id"),
      projectId: decodeScopeComponent(parts[2], "project id"),
    };
  }
  throw new Error(
    "Invalid Backoffice scope. Expected system, org:<orgId>, project:<orgId>:<projectId>, or user:<userId>.",
  );
}

function backofficeScopePath(scope, suffix = "") {
  const routeId =
    scope.kind === "system"
      ? "system"
      : scope.kind === "org"
        ? encodeURIComponent(scope.orgId)
        : scope.kind === "user"
          ? encodeURIComponent(scope.userId)
          : `${encodeURIComponent(scope.orgId)}:${encodeURIComponent(scope.projectId)}`;
  return `/__dev/codemode/${scope.kind}/${encodeURIComponent(routeId)}${suffix}`;
}

function isStoredAuthState(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.baseUrl === "string" &&
    value.oauth &&
    typeof value.oauth === "object" &&
    typeof value.oauth.clientId === "string" &&
    typeof value.oauth.accessToken === "string" &&
    typeof value.oauth.accessTokenExpiresAt === "string" &&
    typeof value.oauth.refreshToken === "string" &&
    value.backoffice &&
    typeof value.backoffice === "object" &&
    typeof value.backoffice.accessToken === "string" &&
    typeof value.backoffice.expiresAt === "string" &&
    isBackofficeScope(value.backoffice.scope),
  );
}

async function readAuth() {
  let text;
  try {
    text = await readFile(authFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw new Error(`Could not read auth state from ${authFile}: ${error.message}`, {
      cause: error,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Auth state in ${authFile} is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
  if (!isStoredAuthState(parsed)) {
    throw new Error(`Auth state in ${authFile} uses an unsupported format. Remove it and log in.`);
  }
  return parsed;
}

async function writeAuth(auth) {
  await mkdir(dirname(authFile), { recursive: true });
  const temporaryAuthFile = `${authFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryAuthFile, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryAuthFile, authFile);
  await chmod(authFile, 0o600);
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function assertOk(response, label) {
  if (response.ok) {
    return await readJsonResponse(response);
  }
  const body = await readJsonResponse(response);
  throw new Error(
    `${label} failed (${response.status}): ${typeof body === "string" ? body : JSON.stringify(body)}`,
  );
}

function isBackofficeHealthResponse(status, body) {
  return status === 200 && body?.ok === true;
}

async function findBackofficeServers() {
  const candidates = [];
  for (const port of ports) {
    const baseUrl = `http://localhost:${port}`;
    try {
      const response = await fetch(`${baseUrl}/api/auth/ok`);
      const body = await readJsonResponse(response);
      if (isBackofficeHealthResponse(response.status, body)) {
        candidates.push({ baseUrl });
      }
    } catch {
      // Try the next Vite port.
    }
  }
  return candidates;
}

function warnForMultipleServers(candidates) {
  if (candidates.length <= 1) {
    return;
  }

  console.error(
    `WARNING: Multiple Backoffice dev servers found: ${candidates
      .map((candidate) => candidate.baseUrl)
      .join(", ")}. Using ${candidates[0].baseUrl}.`,
  );
}

async function assertBackofficeServer(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/ok`);
  const body = await readJsonResponse(response);
  if (!isBackofficeHealthResponse(response.status, body)) {
    throw new Error(`${baseUrl} is not a current Backoffice dev server.`);
  }
  return baseUrl;
}

async function probe({ print = true, baseUrl = configuredBaseUrl } = {}) {
  if (baseUrl) {
    const selected = await assertBackofficeServer(baseUrl.replace(/\/$/, ""));
    if (print) {
      console.log(selected);
    }
    return selected;
  }

  const candidates = await findBackofficeServers();
  if (candidates.length === 0) {
    throw new Error("No Backoffice dev server found on ports 5173-5180.");
  }

  warnForMultipleServers(candidates);
  const selected = candidates[0].baseUrl;
  if (print) {
    console.log(selected);
  }
  return selected;
}

function isBackofficeCliOAuthConfig(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.clientId === "string" &&
    typeof value.scope === "string" &&
    typeof value.deviceAuthorizationEndpoint === "string" &&
    typeof value.tokenEndpoint === "string" &&
    typeof value.verificationUri === "string",
  );
}

async function registerOrLoadOAuthClient(baseUrl) {
  const response = await fetch(`${baseUrl}/api/backoffice/cli-config`);
  const config = await assertOk(response, "Load Backoffice CLI OAuth configuration");
  if (!isBackofficeCliOAuthConfig(config)) {
    throw new Error("Backoffice CLI OAuth configuration has an invalid response shape.");
  }
  return config;
}

function isDeviceCodeResponse(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.device_code === "string" &&
    typeof value.user_code === "string" &&
    typeof value.verification_uri === "string" &&
    typeof value.verification_uri_complete === "string" &&
    typeof value.expires_in === "number" &&
    typeof value.interval === "number",
  );
}

async function requestDeviceCode(config, baseUrl) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    scope: config.scope,
    resource: baseUrl,
  });
  const response = await fetch(config.deviceAuthorizationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const deviceCode = await assertOk(response, "Request OAuth device code");
  if (!isDeviceCodeResponse(deviceCode)) {
    throw new Error("OAuth device authorization returned an invalid response shape.");
  }
  return deviceCode;
}

function openVerificationUrl(url) {
  const command =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
    child.unref();
  } catch (error) {
    console.error(`Could not open the browser automatically: ${error.message}`);
  }
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });
}

function parseOAuthTokenResponse(body, previousRefreshToken = null) {
  if (
    !body ||
    typeof body !== "object" ||
    typeof body.access_token !== "string" ||
    typeof body.expires_in !== "number"
  ) {
    throw new Error("OAuth token endpoint returned an invalid response shape.");
  }
  const refreshToken =
    typeof body.refresh_token === "string" && body.refresh_token
      ? body.refresh_token
      : previousRefreshToken;
  if (!refreshToken) {
    throw new Error("OAuth token endpoint did not return a refresh token.");
  }
  return {
    accessToken: body.access_token,
    accessTokenExpiresAt: new Date(Date.now() + body.expires_in * 1_000).toISOString(),
    refreshToken,
  };
}

async function pollForOAuthToken(config, deviceCode, baseUrl) {
  let intervalMs = Math.max(1, deviceCode.interval) * 1_000;
  const expiresAt = Date.now() + deviceCode.expires_in * 1_000;

  while (Date.now() < expiresAt) {
    await sleep(intervalMs);
    const response = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: oauthDeviceCodeGrantType,
        device_code: deviceCode.device_code,
        client_id: config.clientId,
        resource: baseUrl,
      }),
    });
    const body = await readJsonResponse(response);
    if (response.ok) {
      return parseOAuthTokenResponse(body);
    }
    if (body?.error === "authorization_pending") {
      continue;
    }
    if (body?.error === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    if (body?.error === "access_denied") {
      throw new Error("OAuth device authorization was denied.");
    }
    if (body?.error === "expired_token") {
      throw new Error("OAuth device authorization expired before it was approved.");
    }
    throw new Error(
      `OAuth token polling failed (${response.status}): ${body?.error_description ?? body?.error ?? JSON.stringify(body)}`,
    );
  }

  throw new Error("OAuth device authorization expired before it was approved.");
}

function isCredentialUnexpired(expiresAt) {
  const expiresAtMilliseconds = new Date(expiresAt).getTime();
  return (
    Number.isFinite(expiresAtMilliseconds) &&
    expiresAtMilliseconds > Date.now() + credentialRefreshLeewayMs
  );
}

async function refreshOAuthAccessToken(auth, config) {
  const response = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.oauth.refreshToken,
      client_id: config.clientId,
      resource: auth.baseUrl,
    }),
  });
  if (!response.ok) {
    const body = await readJsonResponse(response);
    throw new BackofficeTokenExchangeError(
      response.status,
      `OAuth token refresh failed (${response.status}): ${body?.error_description ?? body?.error ?? JSON.stringify(body)}. Run codemode.mjs login again.`,
    );
  }

  const oauth = parseOAuthTokenResponse(await readJsonResponse(response), auth.oauth.refreshToken);
  const refreshed = { ...auth, oauth: { clientId: auth.oauth.clientId, ...oauth } };
  await writeAuth(refreshed);
  return refreshed;
}

function isBackofficeCliTokenResult(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.accessToken === "string" &&
    typeof value.expiresAt === "string" &&
    isBackofficeScope(value.scope),
  );
}

async function exchangeOAuthTokenForBackofficeJwt(auth, scope) {
  const response = await fetch(`${auth.baseUrl}/api/backoffice/cli-token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.oauth.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ scope }),
  });
  if (!response.ok) {
    const body = await readJsonResponse(response);
    throw new BackofficeTokenExchangeError(
      response.status,
      `Backoffice token exchange failed (${response.status}): ${body?.message ?? body?.error ?? JSON.stringify(body)}`,
    );
  }

  const result = await readJsonResponse(response);
  if (!isBackofficeCliTokenResult(result)) {
    throw new Error("Backoffice token exchange returned an invalid response shape.");
  }
  const exchanged = {
    ...auth,
    backoffice: {
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
      scope: result.scope,
    },
  };
  await writeAuth(exchanged);
  return exchanged;
}

async function ensureOAuthAccessToken(baseUrl) {
  const config = await registerOrLoadOAuthClient(baseUrl);
  let auth = await readAuth();
  if (!auth || auth.baseUrl !== baseUrl || auth.oauth.clientId !== config.clientId) {
    throw new Error(`No OAuth credential is stored for ${baseUrl}. Run codemode.mjs login.`);
  }
  if (!isCredentialUnexpired(auth.oauth.accessTokenExpiresAt)) {
    auth = await refreshOAuthAccessToken(auth, config);
  }
  return { auth, config };
}

async function ensureBackofficeJwtForScope({ baseUrl, scope, forceExchange = false }) {
  let { auth, config } = await ensureOAuthAccessToken(baseUrl);
  const cachedScopeMatches = scope === null || backofficeScopesEqual(auth.backoffice.scope, scope);
  if (!forceExchange && cachedScopeMatches && isCredentialUnexpired(auth.backoffice.expiresAt)) {
    return { auth, config };
  }

  try {
    auth = await exchangeOAuthTokenForBackofficeJwt(auth, scope);
  } catch (error) {
    if (!(error instanceof BackofficeTokenExchangeError) || error.status !== 401) {
      throw error;
    }
    auth = await refreshOAuthAccessToken(auth, config);
    auth = await exchangeOAuthTokenForBackofficeJwt(auth, scope);
  }
  return { auth, config };
}

function isMeBody(body) {
  return Boolean(
    body &&
    typeof body === "object" &&
    body.user &&
    typeof body.user === "object" &&
    typeof body.user.id === "string" &&
    typeof body.user.email === "string" &&
    Array.isArray(body.organizations),
  );
}

async function fetchMe(auth) {
  const response = await fetch(`${auth.baseUrl}/api/backoffice/me`, {
    headers: { authorization: `Bearer ${auth.backoffice.accessToken}` },
  });
  return { response, body: await readJsonResponse(response) };
}

async function ensureAuthenticatedState(requestedBaseUrl) {
  const baseUrl = await probe({ print: false, baseUrl: requestedBaseUrl });
  let { auth } = await ensureBackofficeJwtForScope({
    baseUrl,
    scope: null,
  });
  let current = await fetchMe(auth);
  if (current.response.status === 401) {
    ({ auth } = await ensureBackofficeJwtForScope({
      baseUrl,
      scope: auth.backoffice.scope,
      forceExchange: true,
    }));
    current = await fetchMe(auth);
  }
  if (!current.response.ok || !isMeBody(current.body)) {
    throw new Error("Authenticated, but /api/backoffice/me did not return the current user.");
  }
  return { auth, me: current.body };
}

function getLoginSummary({ baseUrl, me }) {
  return {
    baseUrl,
    user: me.user,
    active: me.activeOrganizationId,
    organizations: me.organizations.map((entry) => entry.organization),
  };
}

async function login(args) {
  const openBrowser =
    takeFlag(args, "--open") || process.env.BACKOFFICE_CODEMODE_OPEN_BROWSER === "1";
  const requestedBaseUrl = getFlag(args, "--base-url", configuredBaseUrl);
  if (args.length > 0) {
    usage();
  }

  const baseUrl = await probe({ print: false, baseUrl: requestedBaseUrl });
  const config = await registerOrLoadOAuthClient(baseUrl);
  const deviceCode = await requestDeviceCode(config, baseUrl);
  console.log(`Open ${deviceCode.verification_uri_complete}`);
  console.log(`Enter code: ${deviceCode.user_code}`);
  if (openBrowser) {
    openVerificationUrl(deviceCode.verification_uri_complete);
  }
  console.log("Waiting for approval…");

  const oauth = await pollForOAuthToken(config, deviceCode, baseUrl);
  const initialAuth = {
    baseUrl,
    oauth: { clientId: config.clientId, ...oauth },
    backoffice: {
      accessToken: "",
      expiresAt: new Date(0).toISOString(),
      scope: { kind: "system" },
    },
  };
  const auth = await exchangeOAuthTokenForBackofficeJwt(initialAuth, null);
  const current = await fetchMe(auth);
  if (!current.response.ok || !isMeBody(current.body)) {
    throw new Error(
      "OAuth login succeeded, but /api/backoffice/me did not return the current user.",
    );
  }

  console.log(`Authenticated as ${current.body.user.email}`);
  console.error(`Stored OAuth credential state in ${authFile}`);
  console.log(JSON.stringify(getLoginSummary({ baseUrl, me: current.body }), null, 2));
}

function requireAccessibleScope(me, scope) {
  if (scope.kind === "system") {
    if (me.user.role !== "admin") {
      throw new Error("System scope requires an admin user.");
    }
    return;
  }
  if (scope.kind === "user") {
    if (scope.userId !== me.user.id) {
      throw new Error(`User scope ${scope.userId} is not available to the authenticated user.`);
    }
    return;
  }
  if (!me.organizations.some((entry) => entry.organization.id === scope.orgId)) {
    throw new Error(`Organization ${scope.orgId} is not available to the authenticated user.`);
  }
}

async function authedFetch(path, scope, options = {}) {
  const { baseUrl: requestedBaseUrl, ...fetchOptions } = options;
  const baseUrl = await probe({ print: false, baseUrl: requestedBaseUrl });
  const session = await ensureAuthenticatedState(baseUrl);
  requireAccessibleScope(session.me, scope);

  let { auth } = await ensureBackofficeJwtForScope({ baseUrl, scope });
  const fetchWithAuth = (credentials) =>
    fetch(`${credentials.baseUrl}${path}`, {
      ...fetchOptions,
      headers: {
        authorization: `Bearer ${credentials.backoffice.accessToken}`,
        ...fetchOptions.headers,
      },
    });

  const response = await fetchWithAuth(auth);
  if (response.status !== 401) {
    return response;
  }

  ({ auth } = await ensureBackofficeJwtForScope({
    baseUrl,
    scope,
    forceExchange: true,
  }));
  return await fetchWithAuth(auth);
}

function resolveDefaultScope(me) {
  const orgId = me.activeOrganizationId ?? me.organizations[0]?.organization?.id;
  if (!orgId) {
    throw new Error("The authenticated user has no default organization scope.");
  }
  return { kind: "org", orgId };
}

async function doctor(args) {
  const requestedBaseUrl = getFlag(args, "--base-url", configuredBaseUrl);
  if (args.length > 0) {
    usage();
  }

  const baseUrl = await probe({ print: false, baseUrl: requestedBaseUrl });
  const { auth: exchanged } = await ensureBackofficeJwtForScope({
    baseUrl,
    scope: null,
    forceExchange: true,
  });
  const current = await fetchMe(exchanged);
  if (!current.response.ok || !isMeBody(current.body)) {
    throw new Error("Authenticated, but /api/backoffice/me did not return the current user.");
  }
  const scope = resolveDefaultScope(current.body);

  const systemResponse = await authedFetch(backofficeScopePath(scope, "/SYSTEM.md"), scope, {
    baseUrl,
  });
  if (!systemResponse.ok) {
    await assertOk(systemResponse, "Fetch SYSTEM.md");
  }

  const executionResponse = await authedFetch(backofficeScopePath(scope), scope, {
    baseUrl,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: 'async () => ({ rootEntries: await state.readdir({ path: "/" }) })',
    }),
  });
  const execution = await assertOk(executionResponse, "Read-only codemode execution");

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        user: current.body.user.email,
        scope,
        systemPrompt: "available",
        execution: execution.result,
      },
      null,
      2,
    ),
  );
}

async function fetchSystem(args) {
  const baseUrl = getFlag(args, "--base-url", configuredBaseUrl);
  const session = await ensureAuthenticatedState(baseUrl);
  const scopeArg = args.shift();
  const scope = scopeArg ? parseBackofficeScope(scopeArg) : resolveDefaultScope(session.me);
  const outputFile = args.shift() ?? "/tmp/backoffice-codemode-SYSTEM.md";
  if (args.length > 0) {
    usage();
  }

  const response = await authedFetch(backofficeScopePath(scope, "/SYSTEM.md"), scope, { baseUrl });
  if (!response.ok) {
    await assertOk(response, "Fetch SYSTEM.md");
  }
  await writeFile(outputFile, await response.text());
  console.log(outputFile);
}

async function execCodemode(args) {
  const baseUrl = getFlag(args, "--base-url", configuredBaseUrl);
  const scopeArg = args.shift();
  if (!scopeArg) {
    usage();
  }
  const scope = parseBackofficeScope(scopeArg);
  const timeoutValue = getFlag(args, "--timeout", undefined);
  const file = getFlag(args, "--file", undefined);
  const codeArg = args.shift();
  if (args.length > 0) {
    usage();
  }

  const code = file ? await readFile(file, "utf8") : codeArg === "-" ? await readStdin() : codeArg;
  if (!code) {
    usage();
  }

  const body = { code };
  if (timeoutValue) {
    body.timeout = Number(timeoutValue);
  }

  const response = await authedFetch(backofficeScopePath(scope), scope, {
    baseUrl,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(JSON.stringify(await assertOk(response, "Codemode execution"), null, 2));
}

async function execBash(args) {
  const baseUrl = getFlag(args, "--base-url", configuredBaseUrl);
  const scopeArg = args.shift();
  if (!scopeArg) {
    usage();
  }
  const scope = parseBackofficeScope(scopeArg);
  const timeoutValue = getFlag(args, "--timeout", undefined);
  const cwd = getFlag(args, "--cwd", undefined);
  const file = getFlag(args, "--file", undefined);
  const commandArg = args.shift();
  if (args.length > 0) {
    usage();
  }

  const command = file
    ? await readFile(file, "utf8")
    : commandArg === "-"
      ? await readStdin()
      : commandArg;
  if (!command) {
    usage();
  }

  const body = { command };
  if (cwd) {
    body.cwd = cwd;
  }
  if (timeoutValue) {
    body.timeout = Number(timeoutValue);
  }

  const response = await authedFetch(backofficeScopePath(scope, "/bash"), scope, {
    baseUrl,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(JSON.stringify(await assertOk(response, "Bash execution"), null, 2));
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "login") {
    await login(args);
  } else if (command === "probe") {
    const baseUrl = getFlag(args, "--base-url", configuredBaseUrl);
    if (args.length > 0) {
      usage();
    }
    await probe({ baseUrl });
  } else if (command === "doctor") {
    await doctor(args);
  } else if (command === "system") {
    await fetchSystem(args);
  } else if (command === "exec") {
    await execCodemode(args);
  } else if (command === "bash") {
    await execBash(args);
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
