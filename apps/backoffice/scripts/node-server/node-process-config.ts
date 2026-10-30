import path from "node:path";

import type { WorkerTypeChecker } from "@fragno-dev/codemode/compiler/compile-worker";

import type { BackofficeRuntimeEnv } from "../../app/backoffice-runtime/backoffice-runtime-env";
import { createNodeBackofficeRuntimeConfiguration } from "../../app/backoffice-runtime/node/node-runtime-env";
import type { CloudflareObjectSource } from "../../app/backoffice-runtime/rivet/rivet-backoffice-host";
import type { CreateSandboxRuntimeProviders } from "../../app/sandbox/contracts";

/** Where objects run: in this process on SQLite files, or as Rivet actors. */
export type NodeBackofficeObjectHost =
  | { kind: "local"; sqliteDataDirectory: string }
  | { kind: "rivet"; endpoint: string; cloudflare: CloudflareObjectSource | null };

export type NodeBackofficeProcessConfig = {
  objectHost: NodeBackofficeObjectHost;
  port: number;
  listenHosts: readonly string[];
  publicBaseUrl: string;
  runtimeEnv: BackofficeRuntimeEnv;
  workerTypeChecker: WorkerTypeChecker;
  createSandboxProviders: CreateSandboxRuntimeProviders;
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

function parseNodeBackofficeObjectHost(env: NodeJS.ProcessEnv): NodeBackofficeObjectHost {
  if (env.BACKOFFICE_OBJECT_HOST !== "rivet") {
    return {
      kind: "local",
      sqliteDataDirectory: path.resolve(env.BACKOFFICE_SQLITE_DIR || "./.backoffice-node"),
    };
  }
  const workerUrl = env.CLOUDFLARE_OBJECTS_WORKER_URL;
  const token = env.WORKER_MIGRATOR_TOKEN;
  if (Boolean(workerUrl) !== Boolean(token)) {
    throw new Error(
      "Copying objects from Cloudflare requires both CLOUDFLARE_OBJECTS_WORKER_URL and WORKER_MIGRATOR_TOKEN.",
    );
  }
  return {
    kind: "rivet",
    endpoint: env.RIVET_ENDPOINT || "http://127.0.0.1:6420",
    cloudflare: workerUrl && token ? { workerUrl, token } : null,
  };
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

  const runtime = createNodeBackofficeRuntimeConfiguration({
    bridgeUrl: process.env.CLOUDFLARE_BRIDGE_URL,
    bridgeApiKey: process.env.CLOUDFLARE_BRIDGE_API_KEY,
    env: {
      AUTH_ACCESS_TOKEN_SECRET: tokenSecret,
      BACKOFFICE_INTERNAL_REQUEST_SECRET: internalSecret,
      AUTH_ADMIN_GRANT_TOKEN: process.env.AUTH_ADMIN_GRANT_TOKEN,
      AUTH_EMAIL_VERIFICATION_ENABLED: process.env.AUTH_EMAIL_VERIFICATION_ENABLED ?? "false",
      SIGN_UP_ACCESS_CODES_REQUIRED: process.env.SIGN_UP_ACCESS_CODES_REQUIRED ?? "false",
      LOCAL_EMAIL_LOG: process.env.LOCAL_EMAIL_LOG,
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
      OOMOL_CONNECTOR_BASE_URL: process.env.OOMOL_CONNECTOR_BASE_URL,
      OOMOL_PROJECT_API_KEY: process.env.OOMOL_PROJECT_API_KEY,
      OOMOL_CONNECTOR_CATALOG_API_KEY: process.env.OOMOL_CONNECTOR_CATALOG_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      RESON8_API_KEY: process.env.RESON8_API_KEY,
      BLOBS_R2_ENDPOINT: process.env.BLOBS_R2_ENDPOINT,
      BLOBS_R2_BUCKET: process.env.BLOBS_R2_BUCKET,
      BLOBS_R2_ACCESS_KEY_ID: process.env.BLOBS_R2_ACCESS_KEY_ID,
      BLOBS_R2_SECRET_ACCESS_KEY: process.env.BLOBS_R2_SECRET_ACCESS_KEY,
    },
  });

  return {
    objectHost: parseNodeBackofficeObjectHost(process.env),
    port,
    listenHosts,
    publicBaseUrl,
    runtimeEnv: runtime.runtimeEnv,
    workerTypeChecker: runtime.workerTypeChecker,
    createSandboxProviders: runtime.createSandboxProviders,
  };
}
