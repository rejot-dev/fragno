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
  codemode.mjs probe
  codemode.mjs login [--base-url URL] [--email EMAIL] [--password PASSWORD]
  codemode.mjs refresh
  codemode.mjs me
  codemode.mjs orgs
  codemode.mjs agents <orgId> [outputFile]
  codemode.mjs exec <orgId> (--file file.js | - | "async () => { ... }") [--timeout ms]
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
      throw new Error(`Not authenticated. Run: ${process.argv[1]} login`);
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

const isBackofficeMeResponse = (status, body) => {
  if (!body || typeof body !== "object") {
    return false;
  }

  if (status === 200) {
    return (
      body.user &&
      typeof body.user === "object" &&
      typeof body.user.id === "string" &&
      Array.isArray(body.organizations)
    );
  }

  return (
    (status === 400 || status === 401) &&
    (body.code === "credential_invalid" ||
      (body.error && typeof body.error === "object" && body.error.code === "credential_invalid"))
  );
};

const probe = async () => {
  for (const port of ports) {
    const baseUrl = `http://localhost:${port}`;
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      const body = await readProbeJson(response);
      if (isBackofficeMeResponse(response.status, body)) {
        console.log(baseUrl);
        return baseUrl;
      }
    } catch {
      // Try the next Vite port.
    }
  }
  throw new Error("No Backoffice dev server found on ports 5173-5180.");
};

const login = async (args) => {
  const baseUrl = getFlag(args, "--base-url", undefined) ?? (await probe());
  const email = getFlag(args, "--email", defaultEmail);
  const password = getFlag(args, "--password", defaultPassword);
  if (args.length > 0) {
    usage();
  }

  const response = await fetch(`${baseUrl}/api/auth/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await assertOk(response, "Sign-in");
  if (!body?.auth?.token || !body?.auth?.refreshToken) {
    throw new Error("Sign-in did not return auth.token and auth.refreshToken.");
  }

  await writeAuth({
    baseUrl,
    token: body.auth.token,
    refreshToken: body.auth.refreshToken,
    expiresAt: body.auth.expiresAt ?? null,
    refreshExpiresAt: body.auth.refreshExpiresAt ?? null,
  });
  console.error(`Stored auth state in ${authFile}`);
};

const refresh = async () => {
  const previous = await readAuth();
  const response = await fetch(`${previous.baseUrl}/api/auth/token/refresh`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${previous.refreshToken}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  const body = await assertOk(response, "Refresh");
  if (!body?.auth?.token) {
    throw new Error("Refresh did not return auth.token.");
  }

  const next = {
    ...previous,
    token: body.auth.token,
    refreshToken: body.auth.refreshToken ?? previous.refreshToken,
    expiresAt: body.auth.expiresAt ?? null,
    refreshExpiresAt: body.auth.refreshExpiresAt ?? previous.refreshExpiresAt ?? null,
  };
  await writeAuth(next);
  return next;
};

const authedFetch = async (path, options = {}) => {
  const { retryOnStatuses = [401], ...fetchOptions } = options;
  const auth = await readAuth();
  const response = await fetch(`${auth.baseUrl}${path}`, {
    ...fetchOptions,
    headers: {
      authorization: `Bearer ${auth.token}`,
      ...fetchOptions.headers,
    },
  });
  if (!retryOnStatuses.includes(response.status)) {
    return response;
  }

  let refreshed;
  try {
    refreshed = await refresh();
  } catch (error) {
    if (response.status === 403) {
      return response;
    }
    throw error;
  }

  return await fetch(`${refreshed.baseUrl}${path}`, {
    ...fetchOptions,
    headers: {
      authorization: `Bearer ${refreshed.token}`,
      ...fetchOptions.headers,
    },
  });
};

const getMe = async () => assertOk(await authedFetch("/api/auth/me"), "Fetch /me");

const printMe = async () => {
  console.log(JSON.stringify(await getMe(), null, 2));
};

const printOrgs = async () => {
  const me = await getMe();
  console.log(
    JSON.stringify(
      {
        active: me.activeOrganization?.organization?.id ?? null,
        organizations: (me.organizations ?? []).map((entry) => entry.organization),
      },
      null,
      2,
    ),
  );
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

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "probe") {
    await probe();
  } else if (command === "login") {
    await login(args);
  } else if (command === "refresh") {
    await refresh();
  } else if (command === "me") {
    await printMe();
  } else if (command === "orgs") {
    await printOrgs();
  } else if (command === "agents") {
    await fetchAgents(args);
  } else if (command === "exec") {
    await execCodemode(args);
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
