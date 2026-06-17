#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(scriptDir, "..");
const authFile = resolve(skillDir, "auth.json");
const defaultEmail = "wilco@rejot.dev";
const defaultPassword = "wachtwoord";
const ports = [5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180];

const usage = () => {
  console.error(`Usage:
  codemode.mjs login [--email EMAIL] [--password PASSWORD]
  codemode.mjs probe
  codemode.mjs agents <orgId> [outputFile]
  codemode.mjs exec <orgId> (--file file.js | - | "async () => { ... }") [--timeout ms]
  codemode.mjs bash <orgId> (--file script.sh | - | "ls -la") [--cwd path] [--timeout ms]

Canonical bootstrap:
  codemode.mjs login
    Probes the dev server, warns if multiple servers are running, refreshes or signs in,
    stores auth state, and prints the authenticated user plus accessible orgs.
`);
  process.exit(1);
};

const readStdin = async () => {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
};

const getFlag = (args, name, fallback) => {
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
};

const readAuth = async () => {
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
};

const writeAuth = async (auth) => {
  await mkdir(dirname(authFile), { recursive: true });
  await writeFile(authFile, `${JSON.stringify(auth, null, 2)}\n`);
};

const readJsonResponse = async (response) => {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
};

const assertOk = async (response, label) => {
  if (response.ok) {
    return await readJsonResponse(response);
  }
  const body = await readJsonResponse(response);
  throw new Error(
    `${label} failed (${response.status}): ${typeof body === "string" ? body : JSON.stringify(body)}`,
  );
};

const readProbeJson = async (response) => {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return null;
  }

  try {
    return await response.json();
  } catch {
    return null;
  }
};

const isMeBody = (body) =>
  Boolean(
    body &&
    typeof body === "object" &&
    body.user &&
    typeof body.user === "object" &&
    typeof body.user.id === "string" &&
    Array.isArray(body.organizations),
  );

const isCredentialInvalidBody = (body) =>
  Boolean(
    body &&
    typeof body === "object" &&
    ((body.error && typeof body.error === "object" && body.error.code === "credential_invalid") ||
      body.code === "credential_invalid"),
  );

const isBackofficeMeResponse = (status, body) => {
  if (status === 200) {
    return isMeBody(body);
  }

  return (status === 400 || status === 401) && isCredentialInvalidBody(body);
};

const findBackofficeServers = async () => {
  const candidates = [];
  for (const port of ports) {
    const baseUrl = `http://localhost:${port}`;
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      const body = await readProbeJson(response);
      if (isBackofficeMeResponse(response.status, body)) {
        candidates.push({ baseUrl, status: response.status });
      }
    } catch {
      // Try the next Vite port.
    }
  }
  return candidates;
};

const warnForMultipleServers = (candidates) => {
  if (candidates.length <= 1) {
    return;
  }

  console.error(
    `WARNING: Multiple Backoffice dev servers found: ${candidates
      .map((candidate) => candidate.baseUrl)
      .join(", ")}. Using ${candidates[0].baseUrl}.`,
  );
};

const probe = async ({ print = true } = {}) => {
  const candidates = await findBackofficeServers();
  if (candidates.length === 0) {
    throw new Error("No Backoffice dev server found on ports 5173-5180.");
  }

  warnForMultipleServers(candidates);
  const baseUrl = candidates[0].baseUrl;
  if (print) {
    console.log(baseUrl);
  }
  return baseUrl;
};

const fetchMe = async (auth) => {
  const response = await fetch(`${auth.baseUrl}/api/auth/me`, {
    headers: { authorization: `Bearer ${auth.token}` },
  });
  return { response, body: await readJsonResponse(response) };
};

const refreshAuth = async (auth) => {
  if (!auth?.refreshToken) {
    return null;
  }

  const response = await fetch(`${auth.baseUrl}/api/auth/token/refresh`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.refreshToken}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) {
    return null;
  }

  const body = await readJsonResponse(response);
  if (!body?.auth?.token) {
    throw new Error("Refresh did not return auth.token.");
  }

  const next = {
    ...auth,
    token: body.auth.token,
    refreshToken: body.auth.refreshToken ?? auth.refreshToken,
    expiresAt: body.auth.expiresAt ?? null,
    refreshExpiresAt: body.auth.refreshExpiresAt ?? auth.refreshExpiresAt ?? null,
  };
  await writeAuth(next);
  return next;
};

const signIn = async ({ baseUrl, email, password }) => {
  const response = await fetch(`${baseUrl}/api/auth/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await assertOk(response, "Sign-in");
  if (!body?.auth?.token || !body?.auth?.refreshToken) {
    throw new Error("Sign-in did not return auth.token and auth.refreshToken.");
  }

  const auth = {
    baseUrl,
    token: body.auth.token,
    refreshToken: body.auth.refreshToken,
    expiresAt: body.auth.expiresAt ?? null,
    refreshExpiresAt: body.auth.refreshExpiresAt ?? null,
  };
  await writeAuth(auth);
  return auth;
};

const getLoginSummary = ({ baseUrl, me }) => ({
  baseUrl,
  user: me.user,
  active: me.activeOrganization?.organization?.id ?? null,
  organizations: (me.organizations ?? []).map((entry) => entry.organization),
});

const ensureSession = async ({
  email = defaultEmail,
  password = defaultPassword,
  forceSignIn = false,
} = {}) => {
  const baseUrl = await probe({ print: false });
  const existingAuth = await readAuth();
  const authAtCurrentServer = existingAuth ? { ...existingAuth, baseUrl } : null;

  if (authAtCurrentServer && !forceSignIn) {
    const current = await fetchMe(authAtCurrentServer);
    if (current.response.ok && isMeBody(current.body)) {
      if (existingAuth?.baseUrl !== baseUrl) {
        await writeAuth(authAtCurrentServer);
      }
      return { auth: authAtCurrentServer, me: current.body };
    }

    const refreshedAuth = await refreshAuth(authAtCurrentServer);
    if (refreshedAuth) {
      const refreshed = await fetchMe(refreshedAuth);
      if (refreshed.response.ok && isMeBody(refreshed.body)) {
        return { auth: refreshedAuth, me: refreshed.body };
      }
    }
  }

  const auth = await signIn({ baseUrl, email, password });
  const signedIn = await fetchMe(auth);
  if (!signedIn.response.ok || !isMeBody(signedIn.body)) {
    throw new Error("Signed in, but /api/auth/me did not return the authenticated user.");
  }
  return { auth, me: signedIn.body };
};

const login = async (args) => {
  const email = getFlag(args, "--email", defaultEmail);
  const password = getFlag(args, "--password", defaultPassword);
  if (args.length > 0) {
    usage();
  }

  const { auth, me } = await ensureSession({
    email,
    password,
    forceSignIn: email !== defaultEmail || password !== defaultPassword,
  });
  console.error(`Stored auth state in ${authFile}`);
  console.log(JSON.stringify(getLoginSummary({ baseUrl: auth.baseUrl, me }), null, 2));
};

const authedFetch = async (path, options = {}) => {
  const { retryOnStatuses = [401], ...fetchOptions } = options;
  const { auth } = await ensureSession();
  const response = await fetch(`${auth.baseUrl}${path}`, {
    ...fetchOptions,
    headers: {
      authorization: `Bearer ${auth.token}`,
      ...fetchOptions.headers,
    },
  });
  if (!retryOnStatuses.includes(response.status) || response.status !== 401) {
    return response;
  }

  const { auth: nextAuth } = await ensureSession({ forceSignIn: true });
  return await fetch(`${nextAuth.baseUrl}${path}`, {
    ...fetchOptions,
    headers: {
      authorization: `Bearer ${nextAuth.token}`,
      ...fetchOptions.headers,
    },
  });
};

const fetchAgents = async (args) => {
  const orgId = args.shift();
  if (!orgId) {
    usage();
  }
  const outputFile = args.shift() ?? "/tmp/backoffice-codemode-AGENTS.md";
  if (args.length > 0) {
    usage();
  }

  const response = await authedFetch(`/__dev/codemode/${encodeURIComponent(orgId)}/AGENTS.md`, {
    retryOnStatuses: [401, 403],
  });
  if (!response.ok) {
    await assertOk(response, "Fetch AGENTS.md");
  }
  await writeFile(outputFile, await response.text());
  console.log(outputFile);
};

const execCodemode = async (args) => {
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

  const response = await authedFetch(`/__dev/codemode/${encodeURIComponent(orgId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    retryOnStatuses: [401, 403],
  });
  console.log(JSON.stringify(await assertOk(response, "Codemode execution"), null, 2));
};

const execBash = async (args) => {
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

  const response = await authedFetch(`/__dev/codemode/${encodeURIComponent(orgId)}/bash`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    retryOnStatuses: [401, 403],
  });
  console.log(JSON.stringify(await assertOk(response, "Bash execution"), null, 2));
};

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "login") {
    await login(args);
  } else if (command === "probe") {
    await probe();
  } else if (command === "agents") {
    await fetchAgents(args);
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
