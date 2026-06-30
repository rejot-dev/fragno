import type { GitHubAppFragmentConfig } from "@fragno-dev/github-app-fragment";

import type { GitHubConfig } from "@/fragno/github";

export type RuntimeGitHubConfig = GitHubConfig & {
  privateKeySource: "env" | "file";
};

export type RuntimeConfigResolution =
  | {
      ok: true;
      config: RuntimeGitHubConfig;
    }
  | {
      ok: false;
      missing: string[];
      error: string | null;
    };

const normalizePem = (value: string) => value.trim().replace(/\r\n/g, "\n").replace(/\\n/g, "\n");

const parseBoolean = (value?: string | null) => {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
};

const parsePositiveInteger = (value?: string | null) => {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
};

export const maskSecret = (value: string) => {
  if (!value) {
    return "";
  }
  if (value.length <= 8) {
    return "••••";
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
};

export const resolveWebhookUrl = (origin: string) => {
  const trimmed = origin.replace(/\/+$/, "");
  return `${trimmed}/api/github/webhooks`;
};

const resolveUserAuthorizationCallbackUrl = (publicBaseUrl: string) =>
  new URL("/backoffice/connections/github/oauth-callback", publicBaseUrl).toString();

export const resolveGitHubConfig = (env: CloudflareEnv): RuntimeConfigResolution => {
  const appId = env.GITHUB_APP_ID?.trim() ?? "";
  const appSlug = env.GITHUB_APP_SLUG?.trim() ?? "";
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim() ?? "";
  const docsPublicBaseUrl = env.DOCS_PUBLIC_BASE_URL?.trim() ?? "";
  let callbackUrl = "";
  let callbackUrlError: string | null = null;
  if (docsPublicBaseUrl) {
    try {
      callbackUrl = resolveUserAuthorizationCallbackUrl(docsPublicBaseUrl);
    } catch {
      callbackUrlError = `DOCS_PUBLIC_BASE_URL must be an absolute URL. Received: ${docsPublicBaseUrl}`;
    }
  }
  const webhookSecret = env.GITHUB_APP_WEBHOOK_SECRET?.trim() ?? "";
  const apiBaseUrl = env.GITHUB_APP_API_BASE_URL?.trim() || undefined;
  const apiVersion = env.GITHUB_APP_API_VERSION?.trim() || undefined;
  const webBaseUrl = env.GITHUB_APP_WEB_BASE_URL?.trim() || undefined;
  const defaultLinkKey = env.GITHUB_APP_DEFAULT_LINK_KEY?.trim() || undefined;
  const tokenCacheTtlSeconds = parsePositiveInteger(env.GITHUB_APP_TOKEN_CACHE_TTL_SECONDS);
  const webhookDebug = parseBoolean(env.GITHUB_APP_WEBHOOK_DEBUG);

  const missing: string[] = [];
  if (!appId) {
    missing.push("GITHUB_APP_ID");
  }
  if (!appSlug) {
    missing.push("GITHUB_APP_SLUG");
  }
  if (!clientId) {
    missing.push("GITHUB_APP_CLIENT_ID");
  }
  if (!clientSecret) {
    missing.push("GITHUB_APP_CLIENT_SECRET");
  }
  if (!docsPublicBaseUrl) {
    missing.push("DOCS_PUBLIC_BASE_URL");
  }
  if (!webhookSecret) {
    missing.push("GITHUB_APP_WEBHOOK_SECRET");
  }

  const privateKeyRaw = env.GITHUB_APP_PRIVATE_KEY?.trim() ?? "";
  const privateKeyFile = env.GITHUB_APP_PRIVATE_KEY_FILE?.trim() ?? "";
  let privateKeyPem = "";
  let privateKeySource: RuntimeGitHubConfig["privateKeySource"] | null = null;

  if (privateKeyRaw) {
    privateKeyPem = normalizePem(privateKeyRaw);
    privateKeySource = "env";
  } else if (privateKeyFile) {
    return {
      ok: false,
      missing: [...missing, "GITHUB_APP_PRIVATE_KEY"],
      error:
        "GITHUB_APP_PRIVATE_KEY_FILE is not supported in Cloudflare Workers runtime. " +
        "Set GITHUB_APP_PRIVATE_KEY directly (recommended: `wrangler secret put GITHUB_APP_PRIVATE_KEY < private-key.pem`).",
    };
  } else {
    missing.push("GITHUB_APP_PRIVATE_KEY");
  }

  if (missing.length > 0 || callbackUrlError) {
    return {
      ok: false,
      missing,
      error: callbackUrlError,
    };
  }

  if (!privateKeySource) {
    return {
      ok: false,
      missing: ["GITHUB_APP_PRIVATE_KEY"],
      error: null,
    };
  }

  return {
    ok: true,
    config: {
      appId,
      appSlug,
      clientId,
      clientSecret,
      callbackUrl,
      privateKeyPem,
      privateKeySource,
      webhookSecret,
      webhookDebug,
      apiBaseUrl,
      apiVersion,
      webBaseUrl,
      defaultLinkKey,
      tokenCacheTtlSeconds,
    },
  };
};

export const extractFragmentConfig = (config: RuntimeGitHubConfig): GitHubAppFragmentConfig => ({
  appId: config.appId,
  appSlug: config.appSlug,
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  callbackUrl: config.callbackUrl,
  privateKeyPem: config.privateKeyPem,
  webhookSecret: config.webhookSecret,
  webhookDebug: config.webhookDebug,
  apiBaseUrl: config.apiBaseUrl,
  apiVersion: config.apiVersion,
  webBaseUrl: config.webBaseUrl,
  defaultLinkKey: config.defaultLinkKey,
  tokenCacheTtlSeconds: config.tokenCacheTtlSeconds,
});

export const configsEqual = (a: GitHubAppFragmentConfig, b: GitHubAppFragmentConfig) =>
  a.appId === b.appId &&
  a.appSlug === b.appSlug &&
  a.clientId === b.clientId &&
  a.clientSecret === b.clientSecret &&
  a.callbackUrl === b.callbackUrl &&
  a.privateKeyPem === b.privateKeyPem &&
  a.webhookSecret === b.webhookSecret &&
  a.webhookDebug === b.webhookDebug &&
  a.apiBaseUrl === b.apiBaseUrl &&
  a.apiVersion === b.apiVersion &&
  a.webBaseUrl === b.webBaseUrl &&
  a.defaultLinkKey === b.defaultLinkKey &&
  a.tokenCacheTtlSeconds === b.tokenCacheTtlSeconds;
