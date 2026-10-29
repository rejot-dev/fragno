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
import { backofficeDevServerPort } from "@rejot-dev/backoffice-local/dev-server-port";
import { z } from "zod";

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
// Firms and clients are Backoffice organizations: Bookkeeping reads them and their members as the
// person signed in. Owners and admins invite through provisioning, since apps never hold org.manage.
// Documents' files live in their administration's project workspace, stored and read as the person.
// Bookkeeping defines the bookkeeping agent in each firm's agent project, shares a document's folder
// with it, and asks it about the document, as the installation; the agent's turns run with these
// grants, so they include what it reads the files and the books with.
const REQUESTED_PERMISSIONS = [
  { namespace: "org", permission: "read" },
  { namespace: "upload", permission: "read" },
  { namespace: "upload", permission: "modify" },
  { namespace: "pi", permission: "manage" },
  { namespace: "pi", permission: "modify" },
  { namespace: "pi", permission: "read" },
  { namespace: "models", permission: "extract" },
  { namespace: "integrations", permission: "read" },
  { namespace: "integrations", permission: "execute" },
];

function readDevVars(): Map<string, string> {
  const values = new Map<string, string>();
  if (!existsSync(devVarsPath)) {
    return values;
  }
  for (const line of readFileSync(devVarsPath, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) {
      values.set(match[1], match[2]);
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

/** Runs codemode in a scope, e.g. `system`; the CLI exits non-zero when the code throws. */
function execIn<T>(scope: string, baseUrl: string, code: string, result: z.ZodType<T>): T {
  const stdout = runCli(["exec", scope, code, "--base-url", baseUrl], "capture");
  return z.object({ result }).parse(JSON.parse(stdout)).result;
}

function execSystem<T>(baseUrl: string, code: string, result: z.ZodType<T>): T {
  return execIn("system", baseUrl, code, result);
}

const { values: flags } = parseArgs({
  options: {
    "backoffice-url": { type: "string" },
    "bookkeeping-url": { type: "string" },
    name: { type: "string", default: "Bookkeeping" },
    slug: { type: "string", default: "bookkeeping" },
    "operators-slug": { type: "string", default: "bookkeeping-operators" },
    "change-approval": { type: "string", default: "automatic" },
    help: { type: "boolean", short: "h" },
  },
});

const localBackofficeUrl = `http://127.0.0.1:${backofficeDevServerPort(bookkeepingDir)}`;

if (flags.help) {
  console.log(`Usage: pnpm --dir apps/bookkeeping backoffice:connect [options]

Signs in to Backoffice with the Backoffice CLI (a global administrator is required), creates or
repairs Bookkeeping's OAuth client, registers the app as first-party with its actions, creates the
operator organization with the administrator as owner and installs Bookkeeping there, and updates
apps/bookkeeping/.dev.vars. Rerunning converges on the same client, app, and organization.

Options:
  --backoffice-url URL     Backoffice origin (default: this worktree's local Backoffice,
                           ${localBackofficeUrl})
  --bookkeeping-url URL    Bookkeeping origin (default: BOOKKEEPING_BASE_URL or http://127.0.0.1:4173)
  --name NAME              OAuth client name for a new client (default: Bookkeeping)
  --slug SLUG              Permanent app slug, addressed as app#SLUG (default: bookkeeping)
  --operators-slug SLUG    The operator organization's slug (default: bookkeeping-operators)
  --change-approval MODE   automatic (default) or installation`);
  process.exit(0);
}

const changeApproval = flags["change-approval"];
if (changeApproval !== "automatic" && changeApproval !== "installation") {
  throw new Error("--change-approval must be automatic or installation.");
}

const devVars = readDevVars();
// Not .dev.vars: a value written by an earlier run, or copied from another checkout, may point at
// another worktree's Backoffice.
const backofficeUrl = origin(flags["backoffice-url"] ?? localBackofficeUrl, "--backoffice-url");
const bookkeepingUrl = origin(
  flags["bookkeeping-url"] ?? devVars.get("BOOKKEEPING_BASE_URL") ?? "http://127.0.0.1:4173",
  "--bookkeeping-url",
);
const callbackUrl = `${bookkeepingUrl}/api/auth/callback/backoffice`;
// Backoffice operates Bookkeeping: it may provision Bookkeeping's tenants there, and Backoffice's
// sign-in looks like Bookkeeping to people Bookkeeping sends there.
const TRUST = {
  kind: "first-party",
  provisioningPermissions: [
    "organizations.provision",
    "organizations.provisionForInvitee",
    "organizations.provisionManaged",
    "organizations.listManaged",
    "projects.provision",
    "invitations.create",
    "invitations.send",
    "invitations.accept",
  ],
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

console.log("1/5 Building the Backoffice CLI");
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

console.log("\n2/5 Signing in to Backoffice");
// The CLI prints the approval link and code; the user opens it themselves.
runCli(["login", "--base-url", backofficeUrl], "inherit");
const account = execSystem(
  backofficeUrl,
  "async () => account.me()",
  z.object({ userId: z.string().min(1), email: z.string(), emailVerified: z.boolean() }),
);
console.log(`Signed in as ${account.email} (user ID ${account.userId})`);

console.log("\n3/5 Creating or repairing the OAuth client");
// An app keeps the OAuth client it was registered with, so the client of the app holding the slug
// wins over the stored one. A stored client from another Backoffice server is not found here, so
// without such an app a new one is created.
const client = execSystem(
  backofficeUrl,
  `async () => {
    const want = ${JSON.stringify({
      storedClientId: devVars.get("BACKOFFICE_OAUTH_CLIENT_ID") ?? null,
      hasStoredSecret: Boolean(devVars.get("BACKOFFICE_OAUTH_CLIENT_SECRET")),
      slug: flags.slug,
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
    const findAppBySlug = async () => {
      let cursor = null;
      do {
        const page = await admin.appsList({ pageSize: 100, cursor });
        const app = page.apps.find((app) => app.slug === want.slug);
        if (app) return app;
        cursor = page.nextCursor;
      } while (cursor !== null);
      return null;
    };
    const appWithSlug = await findAppBySlug();
    const wantedClientId = appWithSlug?.oauthClientId ?? want.storedClientId;
    const existing = wantedClientId
      ? (await listClients()).find((client) => client.clientId === wantedClientId)
      : undefined;
    if (appWithSlug && !existing) {
      throw new Error("app#" + want.slug + " is registered with OAuth client " + appWithSlug.oauthClientId + ", which no longer exists; pass another --slug.");
    }
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
      if (clientId !== want.storedClientId || !want.hasStoredSecret) {
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
  z.object({
    clientId: z.string(),
    clientSecret: z.string().nullable(),
    created: z.boolean(),
    problems: z.array(z.string()),
  }),
);
if (client.problems.length > 0) {
  throw new Error(`OAuth client ${client.clientId} is not usable: ${client.problems.join("; ")}.`);
}
console.log(
  `${client.created ? "Created" : "Verified"} OAuth client ${client.clientId}${client.clientSecret && !client.created ? " (rotated its secret)" : ""}`,
);

console.log("\n4/5 Registering the app and its actions");
const app = execSystem(
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
  z.object({
    appId: z.string(),
    slug: z.string(),
    created: z.boolean(),
    actionsRevision: z.number(),
    actionsChanged: z.boolean(),
    permissionsChanged: z.boolean(),
    problems: z.array(z.string()),
  }),
);
if (app.problems.length > 0) {
  throw new Error(`App ${app.appId} is not usable: ${app.problems.join("; ")}.`);
}
console.log(
  `${app.created ? "Registered" : "Verified"} app#${app.slug} (app ID ${app.appId}, actions revision ${app.actionsRevision}${app.actionsChanged ? ", updated" : ""}${app.permissionsChanged ? ", requested permissions updated" : ""})`,
);

console.log("\n5/5 Creating or finding the operator organization");
// Its members operate Bookkeeping. Backoffice's administrator creates it: Bookkeeping can only
// provision organizations for people who already signed in to it.
const operators = execSystem(
  backofficeUrl,
  `async () => {
    const want = ${JSON.stringify({ slug: flags["operators-slug"], ownerEmail: account.email })};
    let cursor = null;
    do {
      const page = await admin.orgList({ pageSize: 100, cursor });
      const existing = page.organizations.find((organization) => organization.slug === want.slug);
      if (existing) return { organizationId: existing.organizationId, created: false };
      cursor = page.nextCursor;
    } while (cursor);
    const created = await admin.orgCreate({
      name: "Bookkeeping operators",
      slug: want.slug,
      ownerEmail: want.ownerEmail,
    });
    return { organizationId: created.organizationId, created: true };
  }`,
  z.object({ organizationId: z.string().min(1), created: z.boolean() }),
);
let installed;
try {
  installed = execIn(
    `org:${flags["operators-slug"]}`,
    backofficeUrl,
    `async () => {
      const appId = ${JSON.stringify(app.appId)};
      if ((await apps.getInstallation({ appId }))?.status === "active") return false;
      const registered = await apps.get({ appId });
      await apps.install({
        appId,
        grantedPermissions: registered.requestedPermissions,
        actionsRevision: registered.actionsRevision,
      });
      return true;
    }`,
    z.boolean(),
  );
} catch {
  throw new Error(
    `Installing Bookkeeping in ${flags["operators-slug"]} failed. ${account.email} must be an owner or admin of that organization; pass --operators-slug to use another.`,
  );
}
console.log(
  `${operators.created ? "Created" : "Found"} org:${flags["operators-slug"]} (organization ID ${operators.organizationId}), with Bookkeeping ${installed ? "installed" : "already installed"}`,
);

const betterAuthSecret = devVars.get("BETTER_AUTH_SECRET") ?? "";
writeDevVars({
  ...(betterAuthSecret.length >= 32 && !betterAuthSecret.startsWith("replace-")
    ? {}
    : { BETTER_AUTH_SECRET: randomBytes(32).toString("base64") }),
  BOOKKEEPING_BASE_URL: bookkeepingUrl,
  BACKOFFICE_BASE_URL: backofficeUrl,
  BACKOFFICE_OAUTH_CLIENT_ID: client.clientId,
  BOOKKEEPING_OPERATOR_ORGANIZATION_ID: operators.organizationId,
  ...(client.clientSecret ? { BACKOFFICE_OAUTH_CLIENT_SECRET: client.clientSecret } : {}),
});

console.log(`\nUpdated ${devVarsPath}; ${account.email} is a Bookkeeping operator.

Next:
  1. Restart Bookkeeping so it reads the new .dev.vars, and open ${bookkeepingUrl}/operator.
     Invite other operators there, under Operators.
  2. Sign in as ${account.email}, and create the first firm at
     ${bookkeepingUrl}/operator/firms/new. Bookkeeping invites its owner by email.${
       account.emailVerified
         ? ""
         : `\n     ${account.email} is not verified in Backoffice, so it cannot accept invitations.`
     }
  3. In a firm's or client's Backoffice terminal:
       integrations.verify --connection-id 'app#${app.slug}'${
         app.actionsChanged && changeApproval === "installation"
           ? `\n  Existing installations approve the changed actions with:
       apps.installations.approve-actions --app-id ${app.appId} --actions-revision ${app.actionsRevision}`
           : ""
       }`);
