import type { GraftBackofficeConfiguration } from "../../app/backoffice-runtime/node/graft-runtime-services";

/** Process configuration is cloneable; worker-local composition owns clients and closures. */
export type GraftBackofficeProcessConfig = {
  port: number;
  listenHost: string;
  publicBaseUrl: string;
  configuration: GraftBackofficeConfiguration;
};

/** Validates the environment before any serving host or object worker is started. */
export function createGraftBackofficeProcessConfig(): GraftBackofficeProcessConfig {
  const tokenSecret = process.env.AUTH_ACCESS_TOKEN_SECRET;
  const internalSecret = process.env.BACKOFFICE_INTERNAL_REQUEST_SECRET;
  const bridgeUrl = process.env.CLOUDFLARE_BRIDGE_URL;
  const bridgeApiKey = process.env.CLOUDFLARE_BRIDGE_API_KEY;
  const port = Number(process.env.PORT ?? 5_173);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Node Backoffice PORT must be an integer between 1 and 65535.");
  }
  const listenHost = process.env.HOST?.trim() ?? "127.0.0.1";
  if (!listenHost) {
    throw new Error("Node Backoffice HOST must not be empty.");
  }
  const publicBaseUrl = process.env.DOCS_PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}/`;
  if (!tokenSecret || !internalSecret) {
    throw new Error(
      "Node Backoffice requires AUTH_ACCESS_TOKEN_SECRET and BACKOFFICE_INTERNAL_REQUEST_SECRET in .dev.vars.",
    );
  }
  if (!bridgeUrl || !bridgeApiKey) {
    throw new Error(
      "Node codemode and sandbox execution require CLOUDFLARE_BRIDGE_URL and CLOUDFLARE_BRIDGE_API_KEY in .dev.vars; no local bridge fallback is available.",
    );
  }
  return {
    port,
    listenHost,
    publicBaseUrl,
    configuration: {
      bridge: { url: bridgeUrl, apiKey: bridgeApiKey },
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
        OOMOL_CONNECTOR_BASE_URL: process.env.OOMOL_CONNECTOR_BASE_URL,
        OOMOL_PROJECT_API_KEY: process.env.OOMOL_PROJECT_API_KEY,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      },
    },
  };
}
