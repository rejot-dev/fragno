import { Buffer } from "node:buffer";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, resolve } from "node:path";

import { FRAGNO_OUTBOX_PAGE_SIZE } from "@fragno-dev/db/outbox";

import {
  fetchBackofficeWithoutRedirect,
  resolveSameOriginBackofficeEndpoint,
  resolveSecureBackofficeBaseUrl,
} from "./backoffice-server-url.js";
import { openBackofficeVerificationUrl } from "./browser-verification.js";

/** Slug-backed scope syntax accepted by Backoffice CLI commands and public routes. */
export type BackofficeScope =
  | { kind: "system" }
  | { kind: "org"; orgSlug: string }
  | { kind: "project"; orgSlug: string; projectId: string }
  | { kind: "user"; userId: string };

type BackofficeRuntimeScope =
  | { kind: "system" }
  | { kind: "org"; orgId: string }
  | { kind: "project"; orgId: string; projectId: string }
  | { kind: "user"; userId: string };

type OAuthCredential = {
  clientId: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
};

type BackofficeCredential = {
  accessToken: string;
  expiresAt: string;
  scope: BackofficeRuntimeScope;
};

type StoredAuthState = {
  baseUrl: string;
  oauth: OAuthCredential;
  backoffice: BackofficeCredential;
};

type BackofficeCliOAuthConfig = {
  clientId: string;
  scope: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  verificationUri: string;
};

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

export type BackofficeOrganization = { id: string; name: string; slug: string };
export type BackofficeMe = {
  user: { id: string; email: string; role: "user" | "admin" };
  activeOrganizationId: string | null;
  organizations: Array<{ organization: BackofficeOrganization }>;
};

/** CLI-ready available scope paired with its human label and default selection. */
export type BackofficeAvailableScope = {
  argument: string;
  label: string;
  isDefault: boolean;
};

type BackofficeCliTokenResult = {
  accessToken: string;
  expiresAt: string;
  scope: BackofficeRuntimeScope;
};

type OAuthToken = Omit<OAuthCredential, "clientId">;
type AuthenticatedState = { auth: StoredAuthState; me: BackofficeMe };
export type BackofficeServerCandidate = { baseUrl: string };
type AuthedFetchOptions = RequestInit & { baseUrl?: string | null };

export function backofficeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function responseMessage(body: unknown): string {
  if (body && typeof body === "object") {
    const response = body as Record<string, unknown>;
    for (const field of ["error_description", "message", "error"]) {
      if (typeof response[field] === "string") {
        return response[field];
      }
    }
  }
  return typeof body === "string" ? body : JSON.stringify(body);
}
const ports = [5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180];
const configuredBaseUrl = process.env["BACKOFFICE_URL"]?.replace(/\/$/, "") ?? null;
const authFile = resolveBackofficeAuthFile();
const oauthDeviceCodeGrantType = "urn:ietf:params:oauth:grant-type:device_code";
const credentialRefreshLeewayMs = 30_000;

class BackofficeTokenExchangeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "BackofficeTokenExchangeError";
    this.status = status;
  }
}

export function resolveBackofficeAuthFile(): string {
  const configured = process.env["BACKOFFICE_AUTH_FILE"]?.trim();
  if (configured) {
    return resolve(
      configured.startsWith("~/") ? `${homedir()}/${configured.slice(2)}` : configured,
    );
  }
  const stateHome = process.env["XDG_STATE_HOME"]?.trim() || resolve(homedir(), ".local/state");
  return resolve(stateHome, "fragno/backoffice-cli/auth.json");
}

function isBackofficeRuntimeScope(value: unknown): value is BackofficeRuntimeScope {
  if (!value || typeof value !== "object") {
    return false;
  }
  const scope = value as Record<string, unknown>;
  if (scope["kind"] === "system") {
    return true;
  }
  if (scope["kind"] === "org") {
    return typeof scope["orgId"] === "string" && scope["orgId"].length > 0;
  }
  if (scope["kind"] === "user") {
    return typeof scope["userId"] === "string" && scope["userId"].length > 0;
  }
  return (
    scope["kind"] === "project" &&
    typeof scope["orgId"] === "string" &&
    scope["orgId"].length > 0 &&
    typeof scope["projectId"] === "string" &&
    scope["projectId"].length > 0
  );
}

function backofficeRuntimeScopesEqual(
  left: BackofficeRuntimeScope,
  right: BackofficeRuntimeScope,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "system") {
    return true;
  }
  if (left.kind === "org" && right.kind === "org") {
    return left.orgId === right.orgId;
  }
  if (left.kind === "user" && right.kind === "user") {
    return left.userId === right.userId;
  }
  return (
    left.kind === "project" &&
    right.kind === "project" &&
    left.orgId === right.orgId &&
    left.projectId === right.projectId
  );
}

function decodeScopeComponent(value: string, label: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded) {
      throw new Error(`Missing ${label}.`);
    }
    return decoded;
  } catch (error) {
    throw new Error(`Invalid Backoffice scope ${label}: ${backofficeErrorMessage(error)}`, {
      cause: error,
    });
  }
}

export function parseBackofficeScope(segment: string): BackofficeScope {
  const parts = segment.split(":");
  if (parts[0] === "system" && parts.length === 1) {
    return { kind: "system" };
  }
  if (parts[0] === "org" && parts.length === 2) {
    return { kind: "org", orgSlug: decodeScopeComponent(parts[1], "organization slug") };
  }
  if (parts[0] === "user" && parts.length === 2) {
    return { kind: "user", userId: decodeScopeComponent(parts[1], "user id") };
  }
  if (parts[0] === "project" && parts.length === 3) {
    return {
      kind: "project",
      orgSlug: decodeScopeComponent(parts[1], "organization slug"),
      projectId: decodeScopeComponent(parts[2], "project id"),
    };
  }
  throw new Error(
    "Invalid Backoffice scope. Expected system, org:<organization-slug>, project:<organization-slug>:<project-id>, or user:<user-id>. Organization scopes use slugs, not internal IDs.",
  );
}

function backofficeRuntimeScopeRouteId(scope: BackofficeRuntimeScope): string {
  return scope.kind === "system"
    ? "system"
    : scope.kind === "org"
      ? encodeURIComponent(scope.orgId)
      : scope.kind === "user"
        ? encodeURIComponent(scope.userId)
        : `${encodeURIComponent(scope.orgId)}:${encodeURIComponent(scope.projectId)}`;
}

function backofficeScopePath(scope: BackofficeRuntimeScope, suffix = ""): string {
  return `/api/backoffice/codemode/${scope.kind}/${encodeURIComponent(backofficeRuntimeScopeRouteId(scope))}${suffix}`;
}

function backofficeScopedUploadPath(scope: BackofficeRuntimeScope, suffix = ""): string {
  return `/api/upload-scoped/${scope.kind}/${encodeURIComponent(backofficeRuntimeScopeRouteId(scope))}/files${suffix}`;
}

function backofficeAutomationsStreamPath(
  scope: BackofficeRuntimeScope,
  afterVersionstamp?: string,
): string {
  const path = `/api/automations-scoped/${scope.kind}/${encodeURIComponent(backofficeRuntimeScopeRouteId(scope))}/_internal/outbox/stream`;
  const query = new URLSearchParams({ limit: String(FRAGNO_OUTBOX_PAGE_SIZE) });
  if (afterVersionstamp) {
    query.set("afterVersionstamp", afterVersionstamp);
  }
  return `${path}?${query}`;
}

function isStoredAuthState(value: unknown): value is StoredAuthState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const auth = value as Record<string, unknown>;
  if (!auth["oauth"] || typeof auth["oauth"] !== "object") {
    return false;
  }
  if (!auth["backoffice"] || typeof auth["backoffice"] !== "object") {
    return false;
  }
  const oauth = auth["oauth"] as Record<string, unknown>;
  const backoffice = auth["backoffice"] as Record<string, unknown>;
  return (
    typeof auth["baseUrl"] === "string" &&
    typeof oauth["clientId"] === "string" &&
    typeof oauth["accessToken"] === "string" &&
    typeof oauth["accessTokenExpiresAt"] === "string" &&
    typeof oauth["refreshToken"] === "string" &&
    typeof backoffice["accessToken"] === "string" &&
    typeof backoffice["expiresAt"] === "string" &&
    isBackofficeRuntimeScope(backoffice["scope"])
  );
}

async function readAuth(): Promise<StoredAuthState | null> {
  let text;
  try {
    text = await readFile(authFile, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw new Error(
      `Could not read auth state from ${authFile}: ${backofficeErrorMessage(error)}`,
      {
        cause: error,
      },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Auth state in ${authFile} is not valid JSON: ${backofficeErrorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
  if (!isStoredAuthState(parsed)) {
    throw new Error(`Auth state in ${authFile} uses an unsupported format. Remove it and log in.`);
  }
  return parsed;
}

async function writeAuth(auth: StoredAuthState): Promise<void> {
  await mkdir(dirname(authFile), { recursive: true });
  const temporaryAuthFile = `${authFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryAuthFile, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryAuthFile, authFile);
  await chmod(authFile, 0o600);
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function assertOk(response: Response, label: string): Promise<unknown> {
  if (response.ok) {
    return await readJsonResponse(response);
  }
  const body = await readJsonResponse(response);
  throw new Error(
    `${label} failed (${response.status}): ${typeof body === "string" ? body : JSON.stringify(body)}`,
  );
}

function assertBackofficeCodemodeSucceeded(body: unknown): asserts body is Record<string, unknown> {
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as Record<string, unknown>)["ok"] !== "boolean"
  ) {
    throw new Error("Codemode execution returned an invalid response envelope.");
  }
  const response = body as Record<string, unknown>;
  if (response["ok"] === false) {
    const error =
      typeof response["error"] === "string" && response["error"].trim()
        ? response["error"]
        : "Unknown codemode error.";
    throw new Error(`Codemode execution failed: ${error}`);
  }
}

function isBackofficeHealthResponse(status: number, body: unknown): boolean {
  return (
    status === 200 && Boolean(body && typeof body === "object" && "ok" in body && body.ok === true)
  );
}

export async function findBackofficeServers(): Promise<BackofficeServerCandidate[]> {
  const candidates = [];
  for (const port of ports) {
    const baseUrl = `http://localhost:${port}`;
    try {
      const response = await fetchBackofficeWithoutRedirect(`${baseUrl}/api/auth/ok`, {});
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

export function warnForMultipleBackofficeServers(candidates: BackofficeServerCandidate[]): void {
  if (candidates.length <= 1) {
    return;
  }

  console.error(
    `WARNING: Multiple Backoffice dev servers found: ${candidates
      .map((candidate) => candidate.baseUrl)
      .join(", ")}. Using ${candidates[0].baseUrl}.`,
  );
}

async function assertBackofficeServer(baseUrl: string): Promise<string> {
  const response = await fetchBackofficeWithoutRedirect(`${baseUrl}/api/auth/ok`, {});
  const body = await readJsonResponse(response);
  if (!isBackofficeHealthResponse(response.status, body)) {
    throw new Error(`${baseUrl} is not a current Backoffice dev server.`);
  }
  return baseUrl;
}

export async function probeBackofficeServer({
  print = true,
  baseUrl = configuredBaseUrl,
}: { print?: boolean; baseUrl?: string | null } = {}): Promise<string> {
  if (baseUrl) {
    const selected = await assertBackofficeServer(resolveSecureBackofficeBaseUrl(baseUrl));
    if (print) {
      console.log(selected);
    }
    return selected;
  }

  const candidates = await findBackofficeServers();
  if (candidates.length === 0) {
    throw new Error("No Backoffice dev server found on ports 5173-5180.");
  }

  warnForMultipleBackofficeServers(candidates);
  const selected = candidates[0].baseUrl;
  if (print) {
    console.log(selected);
  }
  return selected;
}

function parseBackofficeCliOAuthConfig(value: unknown, baseUrl: string): BackofficeCliOAuthConfig {
  if (!value || typeof value !== "object") {
    throw new Error("Backoffice CLI OAuth configuration has an invalid response shape.");
  }
  const config = value as Record<string, unknown>;
  if (
    typeof config["clientId"] !== "string" ||
    typeof config["scope"] !== "string" ||
    typeof config["deviceAuthorizationEndpoint"] !== "string" ||
    typeof config["tokenEndpoint"] !== "string" ||
    typeof config["verificationUri"] !== "string"
  ) {
    throw new Error("Backoffice CLI OAuth configuration has an invalid response shape.");
  }

  return {
    clientId: config["clientId"],
    scope: config["scope"],
    deviceAuthorizationEndpoint: resolveSameOriginBackofficeEndpoint({
      baseUrl,
      endpoint: config["deviceAuthorizationEndpoint"],
      label: "OAuth device authorization endpoint",
    }),
    tokenEndpoint: resolveSameOriginBackofficeEndpoint({
      baseUrl,
      endpoint: config["tokenEndpoint"],
      label: "OAuth token endpoint",
    }),
    verificationUri: resolveSameOriginBackofficeEndpoint({
      baseUrl,
      endpoint: config["verificationUri"],
      label: "OAuth verification endpoint",
    }),
  };
}

async function registerOrLoadOAuthClient(baseUrl: string): Promise<BackofficeCliOAuthConfig> {
  const response = await fetchBackofficeWithoutRedirect(`${baseUrl}/api/backoffice/cli-config`, {});
  return parseBackofficeCliOAuthConfig(
    await assertOk(response, "Load Backoffice CLI OAuth configuration"),
    baseUrl,
  );
}

function isDeviceCodeResponse(value: unknown): value is DeviceCodeResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const deviceCode = value as Record<string, unknown>;
  return (
    typeof deviceCode["device_code"] === "string" &&
    typeof deviceCode["user_code"] === "string" &&
    typeof deviceCode["verification_uri"] === "string" &&
    typeof deviceCode["verification_uri_complete"] === "string" &&
    typeof deviceCode["expires_in"] === "number" &&
    typeof deviceCode["interval"] === "number"
  );
}

async function requestDeviceCode(
  config: BackofficeCliOAuthConfig,
  baseUrl: string,
): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    scope: config.scope,
    resource: baseUrl,
  });
  const response = await fetchBackofficeWithoutRedirect(config.deviceAuthorizationEndpoint, {
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });
}

function parseOAuthTokenResponse(
  body: unknown,
  previousRefreshToken: string | null = null,
): OAuthToken {
  if (!body || typeof body !== "object") {
    throw new Error("OAuth token endpoint returned an invalid response shape.");
  }
  const token = body as Record<string, unknown>;
  if (typeof token["access_token"] !== "string" || typeof token["expires_in"] !== "number") {
    throw new Error("OAuth token endpoint returned an invalid response shape.");
  }
  const refreshToken =
    typeof token["refresh_token"] === "string" && token["refresh_token"]
      ? token["refresh_token"]
      : previousRefreshToken;
  if (!refreshToken) {
    throw new Error("OAuth token endpoint did not return a refresh token.");
  }
  return {
    accessToken: token["access_token"],
    accessTokenExpiresAt: new Date(Date.now() + token["expires_in"] * 1_000).toISOString(),
    refreshToken,
  };
}

async function pollForOAuthToken(
  config: BackofficeCliOAuthConfig,
  deviceCode: DeviceCodeResponse,
  baseUrl: string,
): Promise<OAuthToken> {
  let intervalMs = Math.max(1, deviceCode.interval) * 1_000;
  const expiresAt = Date.now() + deviceCode.expires_in * 1_000;

  while (Date.now() < expiresAt) {
    await sleep(intervalMs);
    const response = await fetchBackofficeWithoutRedirect(config.tokenEndpoint, {
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
    const oauthError =
      body && typeof body === "object" ? (body as Record<string, unknown>)["error"] : undefined;
    if (oauthError === "authorization_pending") {
      continue;
    }
    if (oauthError === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    if (oauthError === "access_denied") {
      throw new Error("OAuth device authorization was denied.");
    }
    if (oauthError === "expired_token") {
      throw new Error("OAuth device authorization expired before it was approved.");
    }
    throw new Error(`OAuth token polling failed (${response.status}): ${responseMessage(body)}`);
  }

  throw new Error("OAuth device authorization expired before it was approved.");
}

function isCredentialUnexpired(expiresAt: string): boolean {
  const expiresAtMilliseconds = new Date(expiresAt).getTime();
  return (
    Number.isFinite(expiresAtMilliseconds) &&
    expiresAtMilliseconds > Date.now() + credentialRefreshLeewayMs
  );
}

async function refreshOAuthAccessToken(
  auth: StoredAuthState,
  config: BackofficeCliOAuthConfig,
): Promise<StoredAuthState> {
  const response = await fetchBackofficeWithoutRedirect(config.tokenEndpoint, {
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
      `OAuth token refresh failed (${response.status}): ${responseMessage(body)}. Run backoffice login again.`,
    );
  }

  const oauth = parseOAuthTokenResponse(await readJsonResponse(response), auth.oauth.refreshToken);
  const refreshed = { ...auth, oauth: { clientId: auth.oauth.clientId, ...oauth } };
  await writeAuth(refreshed);
  return refreshed;
}

function isBackofficeCliTokenResult(value: unknown): value is BackofficeCliTokenResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const result = value as Record<string, unknown>;
  return (
    typeof result["accessToken"] === "string" &&
    typeof result["expiresAt"] === "string" &&
    isBackofficeRuntimeScope(result["scope"])
  );
}

async function exchangeOAuthTokenForBackofficeJwt(
  auth: StoredAuthState,
  scope: BackofficeRuntimeScope | null,
): Promise<StoredAuthState> {
  const response = await fetchBackofficeWithoutRedirect(
    `${auth.baseUrl}/api/backoffice/cli-token`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${auth.oauth.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope }),
    },
  );
  if (!response.ok) {
    const body = await readJsonResponse(response);
    throw new BackofficeTokenExchangeError(
      response.status,
      `Backoffice token exchange failed (${response.status}): ${responseMessage(body)}`,
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

async function ensureOAuthAccessToken(
  baseUrl: string,
): Promise<{ auth: StoredAuthState; config: BackofficeCliOAuthConfig }> {
  const config = await registerOrLoadOAuthClient(baseUrl);
  let auth = await readAuth();
  if (!auth || auth.baseUrl !== baseUrl || auth.oauth.clientId !== config.clientId) {
    throw new Error(`No OAuth credential is stored for ${baseUrl}. Run backoffice login.`);
  }
  if (!isCredentialUnexpired(auth.oauth.accessTokenExpiresAt)) {
    auth = await refreshOAuthAccessToken(auth, config);
  }
  return { auth, config };
}

async function ensureBackofficeJwtForScope({
  baseUrl,
  scope,
  forceExchange = false,
}: {
  baseUrl: string;
  scope: BackofficeRuntimeScope | null;
  forceExchange?: boolean;
}): Promise<{ auth: StoredAuthState; config: BackofficeCliOAuthConfig }> {
  let { auth, config } = await ensureOAuthAccessToken(baseUrl);
  const cachedScopeMatches =
    scope === null || backofficeRuntimeScopesEqual(auth.backoffice.scope, scope);
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

function isMeBody(body: unknown): body is BackofficeMe {
  if (!body || typeof body !== "object") {
    return false;
  }
  const result = body as Record<string, unknown>;
  if (!result["user"] || typeof result["user"] !== "object") {
    return false;
  }
  const user = result["user"] as Record<string, unknown>;
  const organizations = result["organizations"];
  return (
    typeof user["id"] === "string" &&
    typeof user["email"] === "string" &&
    (user["role"] === "user" || user["role"] === "admin") &&
    (result["activeOrganizationId"] === null ||
      typeof result["activeOrganizationId"] === "string") &&
    Array.isArray(organizations) &&
    organizations.every((membership) => {
      if (!membership || typeof membership !== "object") {
        return false;
      }
      const organization = (membership as Record<string, unknown>)["organization"];
      if (!organization || typeof organization !== "object") {
        return false;
      }
      const record = organization as Record<string, unknown>;
      return (
        typeof record["id"] === "string" &&
        typeof record["name"] === "string" &&
        typeof record["slug"] === "string"
      );
    })
  );
}

async function fetchMe(auth: StoredAuthState): Promise<{ response: Response; body: unknown }> {
  const response = await fetchBackofficeWithoutRedirect(`${auth.baseUrl}/api/backoffice/me`, {
    headers: { authorization: `Bearer ${auth.backoffice.accessToken}` },
  });
  return { response, body: await readJsonResponse(response) };
}

async function ensureAuthenticatedState(
  requestedBaseUrl: string | null,
): Promise<AuthenticatedState> {
  const baseUrl = await probeBackofficeServer({ print: false, baseUrl: requestedBaseUrl });
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

function formatBackofficeScopeArgument(scope: BackofficeScope): string {
  switch (scope.kind) {
    case "system":
      return "system";
    case "org":
      return `org:${encodeURIComponent(scope.orgSlug)}`;
    case "project":
      return `project:${encodeURIComponent(scope.orgSlug)}:${encodeURIComponent(scope.projectId)}`;
    case "user":
      return `user:${encodeURIComponent(scope.userId)}`;
  }
  throw new Error("Unsupported Backoffice CLI scope kind.");
}

/** Lists the exact scope arguments available from one authenticated Backoffice identity. */
export function listBackofficeAvailableScopes(me: BackofficeMe): BackofficeAvailableScope[] {
  const defaultOrganizationId =
    me.activeOrganizationId ?? me.organizations[0]?.organization.id ?? null;
  const organizationScopes = me.organizations.map(({ organization }) => ({
    argument: formatBackofficeScopeArgument({ kind: "org", orgSlug: organization.slug }),
    label: organization.name,
    isDefault: organization.id === defaultOrganizationId,
  }));
  const userScope = {
    argument: formatBackofficeScopeArgument({ kind: "user", userId: me.user.id }),
    label: me.user.email,
    isDefault: false,
  };
  const systemScopes =
    me.user.role === "admin"
      ? [{ argument: "system", label: "System administrator", isDefault: false }]
      : [];
  return [...organizationScopes, userScope, ...systemScopes];
}

export function getBackofficeLoginSummary({ baseUrl, me }: { baseUrl: string; me: BackofficeMe }) {
  const scopes = listBackofficeAvailableScopes(me);
  return {
    baseUrl,
    user: me.user,
    defaultScope: scopes.find((scope) => scope.isDefault)?.argument ?? null,
    scopes,
  };
}

function resolveBackofficeRuntimeScope(
  me: BackofficeMe,
  scope: BackofficeScope,
): BackofficeRuntimeScope {
  if (scope.kind === "system") {
    if (me.user.role !== "admin") {
      throw new Error("System scope requires an admin user.");
    }
    return scope;
  }
  if (scope.kind === "user") {
    if (scope.userId !== me.user.id) {
      throw new Error(`User scope ${scope.userId} is not available to the authenticated user.`);
    }
    return scope;
  }

  const organization = me.organizations.find(
    (membership) => membership.organization.slug === scope.orgSlug,
  )?.organization;
  if (!organization) {
    throw new Error(
      `Organization slug '${scope.orgSlug}' is not available to the authenticated user. Run 'backoffice scopes' to list available organization slugs; org:* never accepts an internal organization ID.`,
    );
  }
  return scope.kind === "org"
    ? { kind: "org", orgId: organization.id }
    : { kind: "project", orgId: organization.id, projectId: scope.projectId };
}

async function authedFetch(
  pathForScope: (scope: BackofficeRuntimeScope) => string,
  scope: BackofficeScope,
  options: AuthedFetchOptions = {},
): Promise<Response> {
  const { baseUrl: requestedBaseUrl, ...fetchOptions } = options;
  const baseUrl = await probeBackofficeServer({ print: false, baseUrl: requestedBaseUrl });
  const session = await ensureAuthenticatedState(baseUrl ?? null);
  const runtimeScope = resolveBackofficeRuntimeScope(session.me, scope);

  let { auth } = await ensureBackofficeJwtForScope({ baseUrl, scope: runtimeScope });
  const fetchWithAuth = (credentials: StoredAuthState) => {
    const headers = new Headers(fetchOptions.headers);
    headers.set("authorization", `Bearer ${credentials.backoffice.accessToken}`);
    const requestInit: RequestInit & { duplex?: "half" } = {
      ...fetchOptions,
      headers,
    };
    if (fetchOptions.body instanceof ReadableStream) {
      requestInit.duplex = "half";
    }
    return fetchBackofficeWithoutRedirect(
      `${credentials.baseUrl}${pathForScope(runtimeScope)}`,
      requestInit,
    );
  };

  const response = await fetchWithAuth(auth);
  if (response.status !== 401 || fetchOptions.body instanceof ReadableStream) {
    return response;
  }

  ({ auth } = await ensureBackofficeJwtForScope({
    baseUrl,
    scope: runtimeScope,
    forceExchange: true,
  }));
  return await fetchWithAuth(auth);
}

export function resolveDefaultBackofficeScope(me: BackofficeMe): BackofficeScope {
  const membership =
    me.organizations.find(({ organization }) => organization.id === me.activeOrganizationId) ??
    me.organizations[0];
  if (!membership) {
    throw new Error("The authenticated user has no default organization scope.");
  }
  return { kind: "org", orgSlug: membership.organization.slug };
}

export type BackofficeDeviceAuthorization = {
  verificationUrl: string;
  userCode: string;
};

export async function resumeBackofficeLogin(options: {
  baseUrl: string;
}): Promise<ReturnType<typeof getBackofficeLoginSummary> | null> {
  const baseUrl = await probeBackofficeServer({ print: false, baseUrl: options.baseUrl });
  const config = await registerOrLoadOAuthClient(baseUrl);
  const storedAuth = await readAuth();
  if (
    !storedAuth ||
    storedAuth.baseUrl !== baseUrl ||
    storedAuth.oauth.clientId !== config.clientId
  ) {
    return null;
  }

  try {
    const session = await ensureAuthenticatedState(baseUrl);
    return getBackofficeLoginSummary({ baseUrl, me: session.me });
  } catch (error) {
    if (error instanceof BackofficeTokenExchangeError) {
      return null;
    }
    throw error;
  }
}

export async function loginToBackoffice(options: {
  baseUrl: string;
  openBrowser?: boolean;
  onDeviceAuthorization?: (authorization: BackofficeDeviceAuthorization) => void;
}): Promise<ReturnType<typeof getBackofficeLoginSummary>> {
  const baseUrl = await probeBackofficeServer({ print: false, baseUrl: options.baseUrl });
  const config = await registerOrLoadOAuthClient(baseUrl);
  const deviceCode = await requestDeviceCode(config, baseUrl);
  options.onDeviceAuthorization?.({
    verificationUrl: deviceCode.verification_uri_complete,
    userCode: deviceCode.user_code,
  });
  if (options.openBrowser) {
    openBackofficeVerificationUrl(deviceCode.verification_uri_complete);
  }
  const oauth = await pollForOAuthToken(config, deviceCode, baseUrl);
  const initialAuth: StoredAuthState = {
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
  return getBackofficeLoginSummary({ baseUrl, me: current.body });
}

export async function connectToBackoffice(options: {
  baseUrl: string;
  openBrowser?: boolean;
  forceLogin?: boolean;
  onDeviceAuthorization?: (authorization: BackofficeDeviceAuthorization) => void;
}): Promise<{
  summary: ReturnType<typeof getBackofficeLoginSummary>;
  authentication: "stored" | "device";
}> {
  if (!options.forceLogin) {
    const summary = await resumeBackofficeLogin({ baseUrl: options.baseUrl });
    if (summary) {
      return { summary, authentication: "stored" };
    }
  }

  const summary = await loginToBackoffice(options);
  return { summary, authentication: "device" };
}

export async function resolveBackofficeDefaultScopeForServer(options: {
  baseUrl: string;
}): Promise<BackofficeScope> {
  const session = await ensureAuthenticatedState(options.baseUrl);
  return resolveDefaultBackofficeScope(session.me);
}

/** Lists CLI-ready scope arguments, using organization slugs rather than internal IDs. */
export async function listBackofficeAvailableScopesForServer(options: {
  baseUrl: string;
}): Promise<BackofficeAvailableScope[]> {
  const session = await ensureAuthenticatedState(options.baseUrl);
  return listBackofficeAvailableScopes(session.me);
}

export async function fetchBackofficeSystemPrompt(options: {
  baseUrl: string;
  scope?: BackofficeScope;
}): Promise<string> {
  const session = await ensureAuthenticatedState(options.baseUrl);
  const scope = options.scope ?? resolveDefaultBackofficeScope(session.me);
  const response = await authedFetch(
    (runtimeScope) => backofficeScopePath(runtimeScope, "/SYSTEM.md"),
    scope,
    { baseUrl: options.baseUrl },
  );
  if (!response.ok) {
    await assertOk(response, "Fetch SYSTEM.md");
  }
  return await response.text();
}

/** Opens the authenticated NDJSON mutation stream for one scoped Automations runtime. */
export async function openBackofficeAutomationsStream(options: {
  baseUrl: string;
  scope: BackofficeScope;
  afterVersionstamp?: string;
  signal?: AbortSignal;
}): Promise<ReadableStream<Uint8Array>> {
  const response = await authedFetch(
    (runtimeScope) => backofficeAutomationsStreamPath(runtimeScope, options.afterVersionstamp),
    options.scope,
    {
      baseUrl: options.baseUrl,
      headers: { accept: "application/x-ndjson" },
      signal: options.signal,
    },
  );
  if (!response.ok) {
    await assertOk(response, "Open Automations stream");
  }
  if (!response.body) {
    throw new Error("Open Automations stream returned a response without a body.");
  }
  return response.body;
}

export async function executeBackofficeCodemode(options: {
  baseUrl: string;
  scope: BackofficeScope;
  code: string;
  dependencies?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
}): Promise<unknown> {
  const response = await authedFetch(
    (runtimeScope) => backofficeScopePath(runtimeScope),
    options.scope,
    {
      baseUrl: options.baseUrl,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: options.code,
        ...(options.dependencies ? { dependencies: options.dependencies } : {}),
        ...(options.timeout ? { timeout: options.timeout } : {}),
      }),
      signal: options.signal,
    },
  );
  const body = await assertOk(response, "Codemode execution");
  assertBackofficeCodemodeSucceeded(body);
  return body;
}

function requireSafeBackofficeWorkspaceFileKey(fileKey: string): string {
  const normalized = fileKey.replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..")) {
    throw new Error("Backoffice workspace operation requires a safe file key.");
  }
  return normalized;
}

function requireBackofficeWorkspaceScope(scope: BackofficeScope): void {
  if (scope.kind === "system") {
    throw new Error("Backoffice system scope does not have a /workspace filesystem.");
  }
}

/** Downloads bytes from an absolute path in the selected Backoffice filesystem. */
export async function downloadBackofficeFile(options: {
  baseUrl: string;
  scope: BackofficeScope;
  path: string;
  signal?: AbortSignal;
}): Promise<Uint8Array> {
  if (!options.path.startsWith("/")) {
    throw new Error("Backoffice download requires a safe absolute file path.");
  }
  const path = posix.normalize(options.path);
  if (path.startsWith("/workspace/")) {
    requireBackofficeWorkspaceScope(options.scope);
    const fileKey = requireSafeBackofficeWorkspaceFileKey(path.slice("/workspace/".length));
    const query = new URLSearchParams({ provider: "database", key: fileKey });
    const response = await authedFetch(
      (runtimeScope) => backofficeScopedUploadPath(runtimeScope, `/by-key/content?${query}`),
      options.scope,
      {
        baseUrl: options.baseUrl,
        signal: options.signal,
      },
    );
    if (!response.ok) {
      await assertOk(response, `Download Backoffice file '${path}'`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  const response = await executeBackofficeCodemode({
    baseUrl: options.baseUrl,
    scope: options.scope,
    signal: options.signal,
    code: `async () => {
      const bytes = await state.readFileBytes({ path: ${JSON.stringify(path)} });
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      }
      return { base64: btoa(binary) };
    }`,
  });
  if (!response || typeof response !== "object") {
    throw new Error(`Download Backoffice file '${path}' returned an invalid response.`);
  }
  const result = (response as Record<string, unknown>)["result"];
  if (!result || typeof result !== "object") {
    throw new Error(`Download Backoffice file '${path}' returned an invalid result.`);
  }
  const base64 = (result as Record<string, unknown>)["base64"];
  if (typeof base64 !== "string") {
    throw new Error(`Download Backoffice file '${path}' returned invalid file content.`);
  }
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

/** Uploads bytes into the persistent Backoffice workspace for the selected scope. */
export async function uploadBackofficeWorkspaceFile(options: {
  baseUrl: string;
  scope: BackofficeScope;
  fileKey: string;
  content: ReadableStream<Uint8Array>;
  sizeBytes: number;
  contentType: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  requireBackofficeWorkspaceScope(options.scope);
  const fileKey = requireSafeBackofficeWorkspaceFileKey(options.fileKey);
  const path = `/workspace/${fileKey}`;
  const query = new URLSearchParams({ path });
  const response = await authedFetch(
    (runtimeScope) =>
      `/api/files-scoped/${runtimeScope.kind}/${encodeURIComponent(backofficeRuntimeScopeRouteId(runtimeScope))}/workspace?${query}`,
    options.scope,
    {
      baseUrl: options.baseUrl,
      method: "POST",
      headers: {
        "content-length": String(options.sizeBytes),
        "content-type": options.contentType,
      },
      body: options.content,
      signal: options.signal,
    },
  );
  return await assertOk(response, `Upload Backoffice workspace file '${fileKey}'`);
}

export async function executeBackofficeBash(options: {
  baseUrl: string;
  scope: BackofficeScope;
  command: string;
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
}): Promise<unknown> {
  const response = await authedFetch(
    (runtimeScope) => backofficeScopePath(runtimeScope, "/bash"),
    options.scope,
    {
      baseUrl: options.baseUrl,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: options.command,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.timeout ? { timeout: options.timeout } : {}),
      }),
      signal: options.signal,
    },
  );
  return await assertOk(response, "Bash execution");
}
