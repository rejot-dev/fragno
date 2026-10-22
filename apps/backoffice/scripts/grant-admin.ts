import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";

import { backofficeDevServerPort } from "@rejot-dev/backoffice-local/dev-server-port";

// Mirrors `GrantBackofficeAdminResult`; importing it would pull the app into the Node project.
type GrantAdminResponse =
  | { status: "granted" | "already_admin" | "email_not_verified"; userId: string }
  | { status: "user_not_found" | "user_not_active" };

const USAGE =
  "Usage: pnpm --filter @fragno-apps/backoffice-rr admin:grant -- [--local] [--port PORT] EMAIL\n" +
  "--local targets this worktree's dev server; --port targets a local server on PORT.";
const DEPLOYED_BACKOFFICE_URL = "https://backoffice.rejot.dev";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readAdminGrantToken(): string | undefined {
  if (process.env.AUTH_ADMIN_GRANT_TOKEN) {
    return process.env.AUTH_ADMIN_GRANT_TOKEN;
  }
  const devVarsFile =
    process.env.BACKOFFICE_DEV_VARS_FILE ?? resolve(import.meta.dirname, "../.dev.vars");
  if (!existsSync(devVarsFile)) {
    return undefined;
  }
  return parseEnv(readFileSync(devVarsFile, "utf8")).AUTH_ADMIN_GRANT_TOKEN;
}

const { values, positionals } = parseArgs({
  // pnpm forwards the `--` separator from `pnpm <script> -- ARGS`.
  args: process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--"),
  allowPositionals: true,
  options: {
    local: { type: "boolean" },
    port: { type: "string", short: "p" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (positionals.length !== 1) {
  fail(USAGE);
}
if (values.port !== undefined && !/^\d+$/.test(values.port)) {
  fail(`--port requires a numeric port.\n${USAGE}`);
}

const [email] = positionals;
const localPort =
  values.port ?? (values.local ? backofficeDevServerPort(import.meta.dirname) : undefined);
const baseUrl =
  localPort === undefined
    ? (process.env.BACKOFFICE_URL ?? DEPLOYED_BACKOFFICE_URL)
    : `http://127.0.0.1:${localPort}`;
const token =
  readAdminGrantToken() ??
  fail("AUTH_ADMIN_GRANT_TOKEN is not set in the environment or .dev.vars.");

const response = await fetch(new URL("/api/admin/grant", baseUrl), {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ email }),
});
if (response.status !== 200) {
  fail(
    `Failed to grant Backoffice administrator access: HTTP ${response.status}\n${await response.text()}`,
  );
}

const result = (await response.json()) as GrantAdminResponse;
switch (result.status) {
  case "granted":
    console.log(`Granted administrator access to ${result.userId}.`);
    break;
  case "already_admin":
    console.log(`Account ${result.userId} is already an administrator.`);
    break;
  case "email_not_verified":
    fail(`Account ${result.userId} must verify its email before becoming an administrator.`);
    break;
  case "user_not_found":
  case "user_not_active":
    fail(`Administrator access was not granted: ${result.status}.`);
}
