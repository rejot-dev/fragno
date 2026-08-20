#!/usr/bin/env node
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(scriptDir, "..");
const authFile = resolve(skillDir, "auth.json");
const defaultEmail = "wilco@rejot.dev";
const defaultPassword = "wachtwoord";
const ports = [5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180];
const configuredBaseUrl = process.env.BACKOFFICE_URL?.replace(/\/$/, "") ?? null;

class BackofficeTokenExchangeError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "BackofficeTokenExchangeError";
    this.status = status;
  }
}

function usage() {
  console.error(`Usage:
  codemode.mjs login [--email EMAIL] [--password PASSWORD] [--base-url URL]
  codemode.mjs probe [--base-url URL]
  codemode.mjs doctor [--base-url URL]
  codemode.mjs system [orgId] [outputFile] [--base-url URL]
    Fetch rendered SYSTEM.md. If orgId is omitted, uses the active or first organization.
  codemode.mjs exec <orgId> (--file file.js | - | "async () => { ... }") [--timeout ms] [--base-url URL]
  codemode.mjs bash <orgId> (--file script.sh | - | "ls -la") [--cwd path] [--timeout ms] [--base-url URL]

Canonical bootstrap:
  codemode.mjs login
    Probes the dev server, warns if multiple servers are running, signs in through Better Auth,
    stores local session and Backoffice JWT state, and prints accessible organizations.
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

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Auth state in ${authFile} is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
}

async function writeAuth(auth) {
  await mkdir(dirname(authFile), { recursive: true });
  const temporaryAuthFile = `${authFile}.${process.pid}.tmp`;
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

function readSetCookie(response, cookieName) {
  const cookies = response.headers.getSetCookie?.() ?? [];
  const prefix = `${cookieName}=`;
  for (const cookie of cookies) {
    if (cookie.startsWith(prefix)) {
      return cookie.slice(0, cookie.indexOf(";"));
    }
  }
  return null;
}

function isCurrentAuthState(auth, baseUrl, email) {
  return Boolean(
    auth &&
    auth.baseUrl === baseUrl &&
    (!email || auth.email === email) &&
    typeof auth.sessionCookie === "string" &&
    typeof auth.accessToken === "string",
  );
}

async function fetchMe(auth) {
  const response = await fetch(`${auth.baseUrl}/api/backoffice/me`, {
    headers: { authorization: `Bearer ${auth.accessToken}` },
  });
  return { response, body: await readJsonResponse(response) };
}

async function exchangeBackofficeToken(auth, organizationId) {
  const response = await fetch(`${auth.baseUrl}/api/auth/backoffice-token`, {
    method: "POST",
    headers: {
      cookie: auth.sessionCookie,
      origin: auth.baseUrl,
      "content-type": "application/json",
    },
    body: JSON.stringify({ organizationId }),
  });
  if (!response.ok) {
    const body = await readJsonResponse(response);
    const detail = typeof body === "string" ? body : (body?.message ?? JSON.stringify(body));
    throw new BackofficeTokenExchangeError(
      response.status,
      `Backoffice token exchange failed (${response.status}): ${detail}`,
    );
  }

  const body = await readJsonResponse(response);
  const accessCookie =
    readSetCookie(response, "fragno-backoffice.access_token") ??
    readSetCookie(response, "__Host-fragno-backoffice.access_token");
  if (!accessCookie) {
    throw new Error("Backoffice token exchange did not set an access token cookie.");
  }

  const next = {
    ...auth,
    accessToken: accessCookie.slice(accessCookie.indexOf("=") + 1),
    organizationId: body.organizationId,
    expiresAt: body.expiresAt,
  };
  await writeAuth(next);
  return next;
}

async function signIn({ baseUrl, email, password }) {
  const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      origin: baseUrl,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  await assertOk(response.clone(), "Sign-in");

  const sessionCookie =
    readSetCookie(response, "better-auth.session_token") ??
    readSetCookie(response, "__Secure-better-auth.session_token");
  if (!sessionCookie) {
    throw new Error("Better Auth sign-in did not set a session cookie.");
  }

  const auth = {
    baseUrl,
    email,
    sessionCookie,
    accessToken: "",
    organizationId: null,
    expiresAt: null,
  };
  return await exchangeBackofficeToken(auth, null);
}

function isMeBody(body) {
  return Boolean(
    body &&
    typeof body === "object" &&
    body.user &&
    typeof body.user === "object" &&
    typeof body.user.id === "string" &&
    Array.isArray(body.organizations),
  );
}

async function ensureSession({
  baseUrl: requestedBaseUrl = configuredBaseUrl,
  email = null,
  password = null,
  forceSignIn = false,
} = {}) {
  const baseUrl = await probe({ print: false, baseUrl: requestedBaseUrl });
  const existingAuth = await readAuth();
  const selectedEmail = email ?? existingAuth?.email ?? defaultEmail;

  if (!forceSignIn && isCurrentAuthState(existingAuth, baseUrl, selectedEmail)) {
    const current = await fetchMe(existingAuth);
    if (current.response.ok && isMeBody(current.body)) {
      return { auth: existingAuth, me: current.body };
    }

    try {
      const exchanged = await exchangeBackofficeToken(existingAuth, existingAuth.organizationId);
      const refreshed = await fetchMe(exchanged);
      if (refreshed.response.ok && isMeBody(refreshed.body)) {
        return { auth: exchanged, me: refreshed.body };
      }
    } catch (error) {
      if (!(error instanceof BackofficeTokenExchangeError) || error.status !== 401) {
        throw error;
      }
    }
  }

  const selectedPassword = password ?? (selectedEmail === defaultEmail ? defaultPassword : null);
  if (!selectedPassword) {
    throw new Error(
      `The stored Better Auth session for ${selectedEmail} expired. Run codemode.mjs login --email ${selectedEmail} --password PASSWORD again.`,
    );
  }

  const auth = await signIn({ baseUrl, email: selectedEmail, password: selectedPassword });
  const signedIn = await fetchMe(auth);
  if (!signedIn.response.ok || !isMeBody(signedIn.body)) {
    throw new Error("Signed in, but /api/backoffice/me did not return the authenticated user.");
  }
  return { auth, me: signedIn.body };
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
  const email = getFlag(args, "--email", defaultEmail);
  const password = getFlag(args, "--password", defaultPassword);
  const baseUrl = getFlag(args, "--base-url", configuredBaseUrl);
  if (args.length > 0) {
    usage();
  }

  const { auth, me } = await ensureSession({
    baseUrl,
    email,
    password,
    forceSignIn: email !== defaultEmail || password !== defaultPassword,
  });
  console.error(`Stored auth state in ${authFile}`);
  console.log(JSON.stringify(getLoginSummary({ baseUrl: auth.baseUrl, me }), null, 2));
}

function requireAccessibleOrganization(me, organizationId) {
  const organization = me.organizations.find((entry) => entry.organization.id === organizationId);
  if (!organization) {
    throw new Error(`Organization ${organizationId} is not available to the authenticated user.`);
  }
  return organization.organization;
}

async function authedFetch(path, organizationId, options = {}) {
  const { baseUrl, ...fetchOptions } = options;
  const { auth: currentAuth, me } = await ensureSession({ baseUrl });
  requireAccessibleOrganization(me, organizationId);

  const auth =
    currentAuth.organizationId === organizationId
      ? currentAuth
      : await exchangeBackofficeToken(currentAuth, organizationId);
  const fetchWithAuth = (credentials) =>
    fetch(`${credentials.baseUrl}${path}`, {
      ...fetchOptions,
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        ...fetchOptions.headers,
      },
    });

  const response = await fetchWithAuth(auth);
  if (response.status !== 401) {
    return response;
  }

  try {
    const refreshed = await exchangeBackofficeToken(auth, organizationId);
    return await fetchWithAuth(refreshed);
  } catch (error) {
    if (!(error instanceof BackofficeTokenExchangeError) || error.status !== 401) {
      throw error;
    }
  }

  if (auth.email !== defaultEmail) {
    throw new Error(
      `The stored Better Auth session for ${auth.email} expired. Run codemode.mjs login --email ${auth.email} --password PASSWORD again.`,
    );
  }

  const signedIn = await signIn({
    baseUrl: auth.baseUrl,
    email: defaultEmail,
    password: defaultPassword,
  });
  const scoped =
    signedIn.organizationId === organizationId
      ? signedIn
      : await exchangeBackofficeToken(signedIn, organizationId);
  return await fetchWithAuth(scoped);
}

function resolveDefaultOrgId(me) {
  const orgId = me.activeOrganizationId ?? me.organizations[0]?.organization?.id;
  if (!orgId) {
    throw new Error("The authenticated user has no organizations.");
  }
  return orgId;
}

function orgCodemodePath(organizationId, suffix = "") {
  return `/__dev/codemode/org/${encodeURIComponent(organizationId)}${suffix}`;
}

async function doctor(args) {
  const baseUrl = getFlag(args, "--base-url", configuredBaseUrl);
  if (args.length > 0) {
    usage();
  }

  const { auth, me } = await ensureSession({ baseUrl });
  const organizationId = resolveDefaultOrgId(me);
  const systemResponse = await authedFetch(
    orgCodemodePath(organizationId, "/SYSTEM.md"),
    organizationId,
    { baseUrl },
  );
  if (!systemResponse.ok) {
    await assertOk(systemResponse, "Fetch SYSTEM.md");
  }

  const executionResponse = await authedFetch(orgCodemodePath(organizationId), organizationId, {
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
        baseUrl: auth.baseUrl,
        user: me.user.email,
        organizationId,
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
  const session = await ensureSession({ baseUrl });
  const orgId = args.shift() ?? resolveDefaultOrgId(session.me);
  const outputFile = args.shift() ?? "/tmp/backoffice-codemode-SYSTEM.md";
  if (args.length > 0) {
    usage();
  }

  const response = await authedFetch(orgCodemodePath(orgId, "/SYSTEM.md"), orgId, { baseUrl });
  if (!response.ok) {
    await assertOk(response, "Fetch SYSTEM.md");
  }
  await writeFile(outputFile, await response.text());
  console.log(outputFile);
}

async function execCodemode(args) {
  const baseUrl = getFlag(args, "--base-url", configuredBaseUrl);
  const orgId = args.shift();
  if (!orgId) {
    usage();
  }
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

  const response = await authedFetch(orgCodemodePath(orgId), orgId, {
    baseUrl,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(JSON.stringify(await assertOk(response, "Codemode execution"), null, 2));
}

async function execBash(args) {
  const baseUrl = getFlag(args, "--base-url", configuredBaseUrl);
  const orgId = args.shift();
  if (!orgId) {
    usage();
  }
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

  const response = await authedFetch(orgCodemodePath(orgId, "/bash"), orgId, {
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
