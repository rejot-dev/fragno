import { readFileSync } from "node:fs";

import type { GitHubAppFragmentConfig } from "../../github/types.js";

type CommandContext = { values: Record<string, unknown> };

type ResolveStringOptions = {
  key: string;
  env: string | string[];
};

const resolveString = (ctx: CommandContext, options: ResolveStringOptions) => {
  const value = ctx.values[options.key] as string | undefined;
  if (value && value.trim().length > 0) {
    return value;
  }
  const envKeys = Array.isArray(options.env) ? options.env : [options.env];
  for (const envKey of envKeys) {
    const envValue = process.env[envKey];
    if (envValue && envValue.trim().length > 0) {
      return envValue;
    }
  }
  return undefined;
};

const resolveRequiredString = (
  ctx: CommandContext,
  options: ResolveStringOptions & { label: string },
) => {
  const value = resolveString(ctx, options);
  if (!value) {
    const envLabel = Array.isArray(options.env) ? options.env.join(" or ") : options.env;
    throw new Error(`Missing ${options.label}. Provide --${options.key} or set ${envLabel}.`);
  }
  return value;
};

const parseNumber = (label: string, value: string | number | undefined) => {
  if (value === undefined) {
    return undefined;
  }
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${label} must be a number`);
  }
  return numeric;
};

const parseBoolean = (label: string, value: string | boolean | undefined) => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`${label} must be a boolean`);
};

const normalizePem = (value: string) => {
  return value.trim().replace(/\r\n/g, "\n").replace(/\\n/g, "\n");
};

export const resolveWebhookSecret = (ctx: CommandContext) =>
  resolveRequiredString(ctx, {
    key: "webhook-secret",
    env: ["GITHUB_APP_WEBHOOK_SECRET", "FRAGNO_GITHUB_APP_WEBHOOK_SECRET"],
    label: "webhook secret",
  });

export const resolveGitHubAppConfig = (ctx: CommandContext): GitHubAppFragmentConfig => {
  const appId = resolveRequiredString(ctx, {
    key: "app-id",
    env: "GITHUB_APP_ID",
    label: "GitHub App ID",
  });
  const appSlug = resolveRequiredString(ctx, {
    key: "app-slug",
    env: "GITHUB_APP_SLUG",
    label: "GitHub App slug",
  });

  const privateKey = resolveString(ctx, { key: "private-key", env: "GITHUB_APP_PRIVATE_KEY" });
  const privateKeyFile = resolveString(ctx, {
    key: "private-key-file",
    env: "GITHUB_APP_PRIVATE_KEY_FILE",
  });

  if (privateKey && privateKeyFile) {
    throw new Error("Provide either --private-key or --private-key-file, not both.");
  }

  let privateKeyPem = privateKey ?? undefined;
  if (!privateKeyPem && privateKeyFile) {
    privateKeyPem = readFileSync(privateKeyFile, "utf-8");
  }

  if (!privateKeyPem) {
    throw new Error(
      "Missing GitHub App private key. Provide --private-key, --private-key-file, or GITHUB_APP_PRIVATE_KEY.",
    );
  }

  const webhookSecret = resolveWebhookSecret(ctx);

  const apiBaseUrl = resolveString(ctx, { key: "api-base-url", env: "GITHUB_APP_API_BASE_URL" });
  const apiVersion = resolveString(ctx, { key: "api-version", env: "GITHUB_APP_API_VERSION" });
  const webBaseUrl = resolveString(ctx, { key: "web-base-url", env: "GITHUB_APP_WEB_BASE_URL" });
  const defaultLinkKey = resolveString(ctx, {
    key: "default-link-key",
    env: "GITHUB_APP_DEFAULT_LINK_KEY",
  });

  const tokenCacheRaw =
    (ctx.values["token-cache-ttl"] as number | string | undefined) ??
    process.env["GITHUB_APP_TOKEN_CACHE_TTL_SECONDS"];
  const tokenCacheTtlSeconds = parseNumber("token-cache-ttl", tokenCacheRaw);

  const webhookDebugRaw =
    (ctx.values["webhook-debug"] as boolean | string | undefined) ??
    process.env["GITHUB_APP_WEBHOOK_DEBUG"] ??
    process.env["FRAGNO_GITHUB_APP_WEBHOOK_DEBUG"];
  const webhookDebug = parseBoolean("webhook-debug", webhookDebugRaw);

  return {
    appId,
    appSlug,
    privateKeyPem: normalizePem(privateKeyPem),
    webhookSecret,
    webhookDebug,
    apiBaseUrl: apiBaseUrl || undefined,
    apiVersion: apiVersion || undefined,
    webBaseUrl: webBaseUrl || undefined,
    defaultLinkKey: defaultLinkKey || undefined,
    tokenCacheTtlSeconds: tokenCacheTtlSeconds || undefined,
  };
};
