import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { backofficeDevServerPort } from "@rejot-dev/backoffice-local/dev-server-port";

const USAGE =
  "Usage: pnpm --filter @fragno-apps/backoffice-rr dev-account:create [--port PORT]\n" +
  "Defaults to this worktree's dev server. Set BACKOFFICE_URL to target another origin.";
const MAX_ATTEMPTS = 10;

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

const { values } = parseArgs({
  // pnpm forwards the `--` separator from `pnpm <script> -- ARGS`.
  args: process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--"),
  options: { port: { type: "string", short: "p" }, help: { type: "boolean", short: "h" } },
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

const email =
  process.env.BACKOFFICE_EMAIL ??
  (process.env.USER ? `${process.env.USER}@rejot.dev` : undefined) ??
  fail("USER is not set. Set BACKOFFICE_EMAIL explicitly.");
const password = process.env.BACKOFFICE_PASSWORD ?? "wachtwoord";
const name = process.env.BACKOFFICE_NAME ?? email.split("@")[0];

let response: Response;
for (let attempt = 1; ; attempt++) {
  try {
    response = await fetch(new URL("/api/auth/sign-up/email", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl.origin },
      body: JSON.stringify({ name, email, password }),
    });
    break;
  } catch (error) {
    if (!isConnectionRefused(error) || attempt >= MAX_ATTEMPTS) {
      const reason = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      fail(`Failed to create dev account at ${baseUrl.origin}: ${String(reason)}`);
    }
    console.log(`Backoffice not ready yet (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in 1s...`);
    await sleep(1000);
  }
}

const body = await response.text();
if (response.ok) {
  console.log(`Created dev account: ${email}`);
} else if (
  (response.status === 400 || response.status === 422) &&
  /USER_ALREADY_EXISTS|User already exists/.test(body)
) {
  console.log(`Dev account already exists: ${email}`);
} else {
  fail(`Failed to create dev account: HTTP ${response.status}\n${body}`);
}
