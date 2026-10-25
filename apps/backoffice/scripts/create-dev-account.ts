import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { backofficeDevServerPort } from "@rejot-dev/backoffice-local/dev-server-port";

const USAGE =
  "Usage: pnpm --filter @fragno-apps/backoffice-rr dev-account:create " +
  "[--email EMAIL]... [--password PASSWORD] [--port PORT]\n" +
  "Creates one account per --email, named after the address; defaults to $USER@rejot.dev.\n" +
  'The password defaults to "wachtwoord".\n' +
  "Defaults to this worktree's dev server. Set BACKOFFICE_URL to target another origin.";
const MAX_CONNECTION_ATTEMPTS = 10;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function isConnectionRefused(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.cause instanceof Error &&
    "code" in error.cause &&
    error.cause.code === "ECONNREFUSED"
  );
}

/** "ada.lovelace@example.com" is named "Ada Lovelace". */
function nameFromEmail(email: string): string {
  return email
    .split("@")[0]
    .split(/[._-]+/u)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

const { values } = parseArgs({
  // pnpm forwards the `--` separator from `pnpm <script> -- ARGS`.
  args: process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--"),
  options: {
    email: { type: "string", short: "e", multiple: true },
    password: { type: "string" },
    port: { type: "string", short: "p" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (values.port !== undefined && !/^\d+$/.test(values.port)) {
  fail(`Port must be numeric: ${values.port}\n${USAGE}`);
}

const baseUrl = new URL(
  process.env.BACKOFFICE_URL ?? `http://127.0.0.1:${backofficeDevServerPort(import.meta.dirname)}`,
);
if (values.port !== undefined) {
  baseUrl.port = values.port;
}

const emails =
  values.email ??
  (process.env.USER ? [`${process.env.USER}@rejot.dev`] : undefined) ??
  fail(`USER is not set. Pass --email explicitly.\n${USAGE}`);
const password = values.password ?? "wachtwoord";

/** Signs up, waiting for the dev server to start and for Better Auth's sign-up rate limit. */
async function signUp(email: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(new URL("/api/auth/sign-up/email", baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: baseUrl.origin },
        body: JSON.stringify({ name: nameFromEmail(email), email, password }),
      });
    } catch (error) {
      if (!isConnectionRefused(error) || attempt >= MAX_CONNECTION_ATTEMPTS) {
        const reason = error instanceof Error && error.cause instanceof Error ? error.cause : error;
        fail(`Failed to create dev account at ${baseUrl.origin}: ${String(reason)}`);
      }
      console.log(
        `Backoffice not ready yet (attempt ${attempt}/${MAX_CONNECTION_ATTEMPTS}), retrying in 1s...`,
      );
      await sleep(1000);
      continue;
    }
    if (response.status !== 429) {
      return response;
    }
    const retryAfterSeconds = Number(response.headers.get("x-retry-after") ?? "10") || 10;
    console.log(`Sign-up is rate limited, retrying ${email} in ${retryAfterSeconds}s...`);
    await sleep(retryAfterSeconds * 1000);
  }
}

for (const email of emails) {
  const response = await signUp(email);
  const body = await response.text();
  if (response.ok) {
    console.log(`Created dev account: ${email}`);
  } else if (
    (response.status === 400 || response.status === 422) &&
    /USER_ALREADY_EXISTS|User already exists/.test(body)
  ) {
    console.log(`Dev account already exists: ${email}`);
  } else {
    fail(`Failed to create dev account ${email}: HTTP ${response.status}\n${body}`);
  }
}
