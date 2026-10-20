/// <reference types="node" />

/**
 * Connects this Bookkeeping checkout to a Backoffice server through the Backoffice CLI: signs in,
 * creates or repairs Bookkeeping's OAuth client, registers the app as first-party with its actions,
 * and writes the resulting credentials to apps/bookkeeping/.dev.vars. Safe to rerun; every step
 * converges.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isLoopbackUrl } from "@fragno-dev/backoffice-api/v0/apps";

import {
  BACKOFFICE_ACTIONS_PATH,
  BOOKKEEPING_BACKOFFICE_ACTIONS,
} from "../workers/backoffice/actions";

// Failures are user-facing messages, not crashes.
process.on("uncaughtException", (error) => {
  console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

const bookkeepingDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(bookkeepingDir, "../..");
const devVarsPath = resolve(bookkeepingDir, ".dev.vars");
const cliEntry = resolve(repositoryRoot, "apps/backoffice-cli/bin/run.js");

const OAUTH_SCOPES = ["openid", "profile", "email", "offline_access", "backoffice"];
// Workspaces are Backoffice organizations: Bookkeeping reads them and their members, and owners
// and admins invite people through it.
const REQUESTED_PERMISSIONS = [
  { namespace: "org", permission: "read" },
  { namespace: "org", permission: "manage" },
];

function readDevVars(): Map<string, string> {
  const values = new Map<string, string>();
  if (!existsSync(devVarsPath)) {
    return values;
  }
  for (const line of readFileSync(devVarsPath, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) {
      values.set(match[1]!, match[2]!);
    }
  }
  return values;
}

/** Replaces the given keys in place and appends missing ones, keeping every other line. */
function writeDevVars(updates: Record<string, string>) {
  const lines = existsSync(devVarsPath) ? readFileSync(devVarsPath, "utf8").split("\n") : [];
  const pending = new Map(Object.entries(updates));
  const next = lines.map((line) => {
    const key = /^([A-Z0-9_]+)=/.exec(line)?.[1];
    if (key && pending.has(key)) {
      const value = pending.get(key)!;
      pending.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  while (next.length > 0 && next.at(-1) === "") {
    next.pop();
  }
  for (const [key, value] of pending) {
    next.push(`${key}=${value}`);
  }
  writeFileSync(devVarsPath, `${next.join("\n")}\n`, { mode: 0o600 });
}

function origin(value: string, flag: string) {
  try {
    return new URL(value).origin;
  } catch {
    throw new Error(`${flag} must be an absolute URL, got '${value}'.`);
  }
}

function runCli(args: string[], output: "inherit" | "capture") {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, BACKOFFICE_OPEN_BROWSER: "0" },
    encoding: "utf8",
    stdio: ["inherit", output === "inherit" ? "inherit" : "pipe", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(`backoffice ${args[0]} failed (exit ${result.status ?? "signal"}).`);
  }
  return result.stdout;
}

/** Runs codemode in System scope; the CLI exits non-zero when the code throws. */
function execSystem<T>(baseUrl: string, code: string): T {
  const stdout = runCli(["exec", "system", code, "--base-url", baseUrl], "capture");
  return (JSON.parse(stdout) as { result: T }).result;
}

const { values: flags } = parseArgs({
  options: {
    "backoffice-url": { type: "string" },
    "bookkeeping-url": { type: "string" },
    name: { type: "string", default: "Bookkeeping" },
    slug: { type: "string", default: "bookkeeping" },
    "change-approval": { type: "string", default: "automatic" },
    help: { type: "boolean", short: "h" },
  },
});

if (flags.help) {
  console.log(`Usage: pnpm --dir apps/bookkeeping backoffice:connect [options]

Signs in to Backoffice with the Backoffice CLI (a global administrator is required), creates or
repairs Bookkeeping's OAuth client, registers the app as first-party with its actions, and updates
apps/bookkeeping/.dev.vars. Rerunning converges on the same client and app.

Options:
  --backoffice-url URL     Backoffice origin (default: BACKOFFICE_BASE_URL or http://127.0.0.1:5173)
  --bookkeeping-url URL    Bookkeeping origin (default: BOOKKEEPING_BASE_URL or http://127.0.0.1:6174)
  --name NAME              OAuth client name for a new client (default: Bookkeeping)
  --slug SLUG              Permanent app slug, addressed as app#SLUG (default: bookkeeping)
  --change-approval MODE   automatic (default) or installation`);
  process.exit(0);
}

const changeApproval = flags["change-approval"];
if (changeApproval !== "automatic" && changeApproval !== "installation") {
  throw new Error("--change-approval must be automatic or installation.");
}

const devVars = readDevVars();
const backofficeUrl = origin(
  flags["backoffice-url"] ?? devVars.get("BACKOFFICE_BASE_URL") ?? "http://127.0.0.1:5173",
  "--backoffice-url",
);
const bookkeepingUrl = origin(
  flags["bookkeeping-url"] ?? devVars.get("BOOKKEEPING_BASE_URL") ?? "http://127.0.0.1:6174",
  "--bookkeeping-url",
);
const callbackUrl = `${bookkeepingUrl}/api/auth/callback/backoffice`;
// Backoffice operates Bookkeeping: it may provision Bookkeeping's tenants there, and Backoffice's
// sign-in looks like Bookkeeping to people Bookkeeping sends there.
const TRUST = {
  kind: "first-party",
  provisioningPermissions: ["organizations.provision", "projects.provision", "invitations.accept"],
  branding: {
    displayName: "Bookkeeping",
    logoUrl: `${bookkeepingUrl}/logo.svg`,
    accentColor: "#1e2fb0",
    homeUrl: bookkeepingUrl,
    supportUrl: `${bookkeepingUrl}/help`,
  },
};
const actions = {
  kind: "endpoint",
  endpointUrl: `${bookkeepingUrl}${BACKOFFICE_ACTIONS_PATH}`,
  changeApproval,
  actions: BOOKKEEPING_BACKOFFICE_ACTIONS,
};

console.log(`Backoffice:  ${backofficeUrl}\nBookkeeping: ${bookkeepingUrl}\n`);

console.log("1/4 Building the Backoffice CLI");
const build = spawnSync(
  "pnpm",
  [
    "exec",
    "turbo",
    "run",
    "build",
    "--filter=@rejot-dev/backoffice-cli",
    "--output-logs=errors-only",
  ],
  { cwd: repositoryRoot, stdio: "inherit" },
);
if (build.status !== 0) {
  throw new Error("Building the Backoffice CLI failed.");
}

console.log("\n2/4 Signing in to Backoffice");
// The CLI prints the approval link and code; the user opens it themselves.
runCli(["login", "--base-url", backofficeUrl], "inherit");

console.log("\n3/4 Creating or repairing the OAuth client");
// A stored client from another Backoffice server is not found here, so a new one is created.
const client = execSystem<{
  clientId: string;
  clientSecret: string | null;
  created: boolean;
  problems: string[];
}>(
  backofficeUrl,
  `async () => {
    const want = ${JSON.stringify({
      clientId: devVars.get("BACKOFFICE_OAUTH_CLIENT_ID") ?? null,
      hasSecret: Boolean(devVars.get("BACKOFFICE_OAUTH_CLIENT_SECRET")),
      name: flags.name,
      redirectUris: [callbackUrl],
      scopes: OAUTH_SCOPES,
      applicationType: isLoopbackUrl(bookkeepingUrl) ? "native" : "web",
    })};
    const listClients = async () => {
      const clients = [];
      let cursor = null;
      do {
        const page = await admin.oauthClientsList({ pageSize: 100, cursor });
        clients.push(...page.clients);
        cursor = page.nextCursor;
      } while (cursor !== null);
      return clients;
    };
    const existing = want.clientId
      ? (await listClients()).find((client) => client.clientId === want.clientId)
      : undefined;
    let clientId;
    let clientSecret = null;
    let created = false;
    if (existing) {
      clientId = existing.clientId;
      // Reapplying is idempotent and restores client credentials, which listing cannot show.
      await admin.oauthClientsUpdate({
        clientId,
        redirectUris: want.redirectUris,
        scopes: want.scopes,
        clientCredentials: true,
      });
      if (!want.hasSecret) {
        clientSecret = (await admin.oauthClientsRotateSecret({ clientId })).clientSecret;
      }
    } else {
      const result = await admin.oauthClientsCreate({
        name: want.name,
        redirectUris: want.redirectUris,
        scopes: want.scopes,
        clientType: "confidential",
        applicationType: want.applicationType,
        clientCredentials: true,
      });
      clientId = result.clientId;
      clientSecret = result.clientSecret;
      created = true;
    }
    const stored = (await listClients()).find((client) => client.clientId === clientId);
    const problems = [];
    if (!stored) problems.push("the client is missing after saving it");
    else {
      if (stored.disabled) problems.push("the client is disabled");
      if (!(stored.redirectUris ?? []).includes(want.redirectUris[0])) problems.push("the callback URL is not registered");
      for (const scope of want.scopes) {
        if (!(stored.scopes ?? []).includes(scope)) problems.push("scope " + scope + " is missing");
      }
      if (stored.tokenEndpointAuthMethod !== "client_secret_basic") problems.push("the client is not confidential");
    }
    return { clientId, clientSecret, created, problems };
  }`,
);
if (client.problems.length > 0) {
  throw new Error(`OAuth client ${client.clientId} is not usable: ${client.problems.join("; ")}.`);
}
console.log(
  `${client.created ? "Created" : "Verified"} OAuth client ${client.clientId}${client.clientSecret && !client.created ? " (rotated its secret)" : ""}`,
);

console.log("\n4/4 Registering the app and its actions");
const app = execSystem<{
  appId: string;
  slug: string;
  created: boolean;
  actionsRevision: number;
  actionsChanged: boolean;
  permissionsChanged: boolean;
  problems: string[];
}>(
  backofficeUrl,
  `async () => {
    const want = ${JSON.stringify({
      slug: flags.slug,
      oauthClientId: client.clientId,
      requestedPermissions: REQUESTED_PERMISSIONS,
      actions,
      trust: TRUST,
    })};
    const findApp = async () => {
      let cursor = null;
      do {
        const page = await admin.appsList({ pageSize: 100, cursor });
        const app = page.apps.find((app) => app.oauthClientId === want.oauthClientId);
        if (app) return app;
        cursor = page.nextCursor;
      } while (cursor !== null);
      return null;
    };
    let app = await findApp();
    let created = false;
    let actionsChanged = false;
    let permissionsChanged = false;
    if (!app) {
      await admin.appsCreate(want);
      created = true;
    } else {
      actionsChanged = (await admin.appsUpdateActions({ appId: app.id, actions: want.actions })).changed;
      permissionsChanged = (await admin.appsUpdatePermissions({ appId: app.id, requestedPermissions: want.requestedPermissions })).changed;
      await admin.appsUpdateTrust({ appId: app.id, trust: want.trust });
      // An app registered before slugs answers to its ID; registering it again names it.
      if (app.slug === app.id) await admin.appsCreate(want);
    }
    app = await findApp();
    const problems = [];
    if (!app) problems.push("the app is missing after registering it");
    else {
      if (app.slug !== want.slug) problems.push("it is registered as app#" + app.slug + "; slugs never change, so pass --slug " + app.slug);
      if (JSON.stringify(app.actions) !== JSON.stringify(want.actions)) problems.push("the stored actions differ from Bookkeeping's");
      if (JSON.stringify(app.trust) !== JSON.stringify(want.trust)) problems.push("it is not registered as a first-party app with every provisioning permission");
      const requested = app.requestedPermissions.map((p) => p.namespace + "." + p.permission).sort();
      const wanted = want.requestedPermissions.map((p) => p.namespace + "." + p.permission).sort();
      if (JSON.stringify(requested) !== JSON.stringify(wanted)) problems.push("it requests " + requested.join(", ") + " instead of " + wanted.join(", "));
    }
    return { appId: app?.id ?? "", slug: app?.slug ?? "", created, actionsRevision: app?.actionsRevision ?? 0, actionsChanged, permissionsChanged, problems };
  }`,
);
if (app.problems.length > 0) {
  throw new Error(`App ${app.appId} is not usable: ${app.problems.join("; ")}.`);
}
console.log(
  `${app.created ? "Registered" : "Verified"} app#${app.slug} (app ID ${app.appId}, actions revision ${app.actionsRevision}${app.actionsChanged ? ", updated" : ""}${app.permissionsChanged ? ", requested permissions updated" : ""})`,
);

const betterAuthSecret = devVars.get("BETTER_AUTH_SECRET") ?? "";
writeDevVars({
  ...(betterAuthSecret.length >= 32 && !betterAuthSecret.startsWith("replace-")
    ? {}
    : { BETTER_AUTH_SECRET: randomBytes(32).toString("base64") }),
  BOOKKEEPING_BASE_URL: bookkeepingUrl,
  BACKOFFICE_BASE_URL: backofficeUrl,
  BACKOFFICE_OAUTH_CLIENT_ID: client.clientId,
  ...(client.clientSecret ? { BACKOFFICE_OAUTH_CLIENT_SECRET: client.clientSecret } : {}),
});

console.log(`\nUpdated ${devVarsPath}.

Next:
  1. Restart Bookkeeping so it reads the new .dev.vars, and open ${bookkeepingUrl}.
  2. Get started: sign in, and name your business to create its workspace.
  3. In that organization's Backoffice terminal:
       integrations.verify --connection-id 'app#${app.slug}'${
         app.actionsChanged && changeApproval === "installation"
           ? `\n  Existing installations approve the changed actions with:
       apps.installations.approve-actions --app-id ${app.appId} --actions-revision ${app.actionsRevision}`
           : ""
       }`);
