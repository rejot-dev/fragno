import path from "node:path";

import type { BackofficeRuntimeEnv } from "../../app/backoffice-runtime/backoffice-runtime-env";
import { createNodeBackofficeRuntimeEnv } from "../../app/backoffice-runtime/node/node-runtime-env";

export type NodeBackofficeProcessConfig = {
  sqliteDataDirectory: string;
  port: number;
  listenHosts: readonly string[];
  publicBaseUrl: string;
  runtimeEnv: BackofficeRuntimeEnv;
};

function parseNodeBackofficeListenHosts(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return ["127.0.0.1", "::1"];
  }
  const host = value.trim();
  if (!host) {
    throw new Error("Node Backoffice HOST must not be empty.");
  }
  return [host];
}

function parsePort(name: string, value: string | undefined, fallback: number): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return port;
}

export async function createNodeBackofficeProcessConfig(): Promise<NodeBackofficeProcessConfig> {
  const tokenSecret = process.env.AUTH_ACCESS_TOKEN_SECRET;
  const internalSecret = process.env.BACKOFFICE_INTERNAL_REQUEST_SECRET;
  const port = parsePort("Node Backoffice PORT", process.env.PORT, 5_173);
  const listenHosts = parseNodeBackofficeListenHosts(process.env.HOST);
  const publicBaseUrl = process.env.DOCS_PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}/`;
  if (!tokenSecret || !internalSecret) {
    throw new Error(
      "Node Backoffice requires AUTH_ACCESS_TOKEN_SECRET and BACKOFFICE_INTERNAL_REQUEST_SECRET in .dev.vars.",
    );
  }

  const runtimeEnv = await createNodeBackofficeRuntimeEnv({
    denoExecutable: process.env.DENO_EXECUTABLE,
    env: {
      AUTH_ACCESS_TOKEN_SECRET: tokenSecret,
      BACKOFFICE_INTERNAL_REQUEST_SECRET: internalSecret,
      AUTH_ADMIN_GRANT_TOKEN: process.env.AUTH_ADMIN_GRANT_TOKEN,
      AUTH_EMAIL_VERIFICATION_ENABLED: process.env.AUTH_EMAIL_VERIFICATION_ENABLED ?? "false",
      SIGN_UP_INVITATIONS_ENABLED: process.env.SIGN_UP_INVITATIONS_ENABLED ?? "false",
      DOCS_PUBLIC_BASE_URL: publicBaseUrl,
      TURNSTILE_SITEKEY: process.env.TURNSTILE_SITEKEY,
      GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
      GITHUB_APP_ID: process.env.GITHUB_APP_ID,
      GITHUB_APP_SLUG: process.env.GITHUB_APP_SLUG,
      GITHUB_APP_CLIENT_ID: process.env.GITHUB_APP_CLIENT_ID,
      GITHUB_APP_CLIENT_SECRET: process.env.GITHUB_APP_CLIENT_SECRET,
      GITHUB_APP_WEBHOOK_SECRET: process.env.GITHUB_APP_WEBHOOK_SECRET,
      GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
      CLOUDFLARE_WORKERS_ACCOUNT_ID: process.env.CLOUDFLARE_WORKERS_ACCOUNT_ID,
      CLOUDFLARE_WORKERS_API_TOKEN: process.env.CLOUDFLARE_WORKERS_API_TOKEN,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    },
  });

  return {
    sqliteDataDirectory: path.resolve(process.env.BACKOFFICE_SQLITE_DIR || "./.backoffice-node"),
    port,
    listenHosts,
    publicBaseUrl,
    runtimeEnv,
  };
}
